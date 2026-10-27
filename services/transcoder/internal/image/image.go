// Package image runs the social image job of task SOC-1b (ADR-049 §4): a still image uploaded to the raw
// bucket (media.image_uploaded) is checked, turned upright, cropped and scaled for its purpose, encoded to
// WebP without metadata under i/{owner_id}/{image_id}/ in the media bucket, and its raw file is deleted.
package image

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// UploadedEvent is the `data` of media.image_uploaded.
type UploadedEvent struct {
	ImageID     string `json:"image_id"`
	OwnerID     string `json:"owner_id"`
	Purpose     string `json:"purpose"`
	RawBucket   string `json:"raw_bucket"`
	RawKey      string `json:"raw_key"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
}

// Image is what the job knows of the row.
type Image struct {
	ID, OwnerID       uuid.UUID
	Purpose           string
	RawBucket, RawKey string
}

// Output is a READY image.
type Output struct {
	ImageKey, ThumbKey string
	Width, Height      int
	Bytes              int64
}

// Failure reasons (media.images.error and Image.error of upload.v1.yaml).
const (
	ReasonInvalidInput = "INVALID_INPUT"
	ReasonStorage      = "STORAGE_ERROR"
	ReasonInternal     = "INTERNAL"
)

// Store is the persistence port (media.images).
type Store interface {
	// BeginImage returns the image when it is PROCESSING; ok is false otherwise (gone, READY, FAILED).
	BeginImage(ctx context.Context, id uuid.UUID) (img Image, ok bool, err error)
	// CompleteImage sets PROCESSING → READY with the outputs; ok is false when it was no longer PROCESSING.
	CompleteImage(ctx context.Context, id uuid.UUID, out Output) (ok bool, err error)
	// FailImage sets PROCESSING → FAILED with a reason; ok is false when there was nothing to fail.
	FailImage(ctx context.Context, id uuid.UUID, reason string) (ok bool, err error)
}

// Media is the local media-processing port (job.Tools).
type Media interface {
	ProbeImage(ctx context.Context, path string) (media.ImageInfo, error)
	EncodeWebP(ctx context.Context, input, output, filter string, alpha bool) error
}

// Action tells the consumer what to do with the message.
type Action int

const (
	Ack Action = iota
	Nak        // redeliver after Delay
)

// Result of Job.Process.
type Result struct {
	Action Action
	Delay  time.Duration
}

// Retry policy: a transient error is retried every RetryDelay, at most MaxDeliveries times in total.
const (
	RetryDelay    = 20 * time.Second
	MaxDeliveries = 15
	maxRawBytes   = 20 << 20
	sniffBytes    = 64 << 10
)

// Job processes media.image_uploaded messages.
type Job struct {
	Store       Store
	Objects     job.Objects
	Media       Media
	MediaBucket string
	WorkDir     string
	Log         *slog.Logger
}

// Process runs one message. delivery is the 1-based delivery count.
func (j *Job) Process(ctx context.Context, ev UploadedEvent, delivery int) Result {
	log := j.Log.With("image_id", ev.ImageID, "delivery", delivery)
	id, err := uuid.Parse(ev.ImageID)
	if err != nil {
		log.ErrorContext(ctx, "media.image_uploaded with an invalid image_id; dropping")
		return Result{Action: Ack}
	}
	img, ok, err := j.Store.BeginImage(ctx, id)
	if err != nil {
		return j.retry(ctx, log, img, id, delivery, ReasonInternal, "begin", err)
	}
	if !ok {
		log.InfoContext(ctx, "image not PROCESSING (READY, FAILED or gone); acking")
		return Result{Action: Ack}
	}

	dir, err := os.MkdirTemp(j.WorkDir, "image-"+id.String()+"-")
	if err != nil {
		return j.retry(ctx, log, img, id, delivery, ReasonInternal, "scratch dir", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	src := filepath.Join(dir, "source")
	if err := j.Objects.Download(ctx, img.RawBucket, img.RawKey, src); err != nil {
		return j.retry(ctx, log, img, id, delivery, ReasonStorage, "download", err)
	}
	head, size, err := readHead(src)
	if err != nil {
		return j.retry(ctx, log, img, id, delivery, ReasonInternal, "read source", err)
	}
	if size > maxRawBytes {
		return j.fail(ctx, log, img, id, ReasonInvalidInput, "larger than 20 MiB")
	}
	format, err := media.SniffImage(head)
	if err != nil {
		return j.fail(ctx, log, img, id, ReasonInvalidInput, err.Error())
	}
	info, err := j.Media.ProbeImage(ctx, src)
	var invalid *media.InvalidInputError
	switch {
	case errors.As(err, &invalid):
		return j.fail(ctx, log, img, id, ReasonInvalidInput, invalid.Msg)
	case err != nil:
		return j.retry(ctx, log, img, id, delivery, ReasonInternal, "probe", err)
	}
	orient := ""
	if format == "jpeg" {
		orient = media.OrientFilter(media.JPEGOrientation(head))
	}
	full, thumb := media.ImageFilters(img.Purpose)
	chain := func(f string) string {
		if orient == "" {
			return f
		}
		return orient + "," + f
	}
	fullPath, thumbPath := filepath.Join(dir, "image.webp"), filepath.Join(dir, "thumb.webp")
	for _, o := range []struct{ path, filter string }{{fullPath, chain(full)}, {thumbPath, chain(thumb)}} {
		if err := j.Media.EncodeWebP(ctx, src, o.path, o.filter, info.Alpha); err != nil {
			if errors.As(err, &invalid) {
				return j.fail(ctx, log, img, id, ReasonInvalidInput, invalid.Msg)
			}
			return j.retry(ctx, log, img, id, delivery, ReasonInternal, "encode", err)
		}
	}
	outInfo, err := j.Media.ProbeImage(ctx, fullPath)
	if err != nil {
		return j.retry(ctx, log, img, id, delivery, ReasonInternal, "probe output", err)
	}
	var total int64
	for _, p := range []string{fullPath, thumbPath} {
		st, err := os.Stat(p)
		if err != nil {
			return j.retry(ctx, log, img, id, delivery, ReasonInternal, "stat output", err)
		}
		total += st.Size()
	}

	prefix := fmt.Sprintf("i/%s/%s/", img.OwnerID, img.ID)
	out := Output{ImageKey: prefix + "image.webp", ThumbKey: prefix + "thumb.webp",
		Width: outInfo.Width, Height: outInfo.Height, Bytes: total}
	for _, u := range []struct{ key, path string }{{out.ThumbKey, thumbPath}, {out.ImageKey, fullPath}} {
		if err := j.Objects.UploadFile(ctx, j.MediaBucket, u.key, u.path, "image/webp", job.CacheImmutable); err != nil {
			j.cleanup(prefix, log)
			return j.retry(ctx, log, img, id, delivery, ReasonStorage, "upload", err)
		}
	}
	ok, err = j.Store.CompleteImage(ctx, id, out)
	if err != nil {
		return j.retry(ctx, log, img, id, delivery, ReasonInternal, "complete", err)
	}
	if !ok {
		log.WarnContext(ctx, "image no longer PROCESSING; discarding output")
		j.cleanup(prefix, log)
		return Result{Action: Ack}
	}
	j.deleteRaw(img, log)
	log.InfoContext(ctx, "image ready", "purpose", img.Purpose, "bytes_in", size, "bytes_out", total)
	return Result{Action: Ack}
}

// readHead returns the first sniffBytes of the file and its size.
func readHead(path string) ([]byte, int64, error) {
	f, err := os.Open(path) // #nosec G304 -- scratch file the job wrote itself
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	head := make([]byte, sniffBytes)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, 0, err
	}
	return head[:n], st.Size(), nil
}

func (j *Job) retry(ctx context.Context, log *slog.Logger, img Image, id uuid.UUID, delivery int, reason, op string, err error) Result {
	if ctx.Err() != nil {
		return Result{Action: Nak, Delay: RetryDelay}
	}
	log.WarnContext(ctx, "image job step failed; will retry", "op", op, "error", err)
	if delivery >= MaxDeliveries {
		return j.fail(ctx, log, img, id, reason, op+" kept failing")
	}
	return Result{Action: Nak, Delay: RetryDelay}
}

// fail marks the image FAILED and deletes its raw file (an image that cannot be processed is never retried
// by the user with the same object).
func (j *Job) fail(ctx context.Context, log *slog.Logger, img Image, id uuid.UUID, reason, detail string) Result {
	ok, err := j.Store.FailImage(ctx, id, reason)
	if err != nil {
		log.ErrorContext(ctx, "recording the image failure failed; will retry", "error", err)
		return Result{Action: Nak, Delay: RetryDelay}
	}
	if ok {
		log.InfoContext(ctx, "image failed", "reason", reason, "detail", detail)
	}
	if img.RawKey != "" {
		j.deleteRaw(img, log)
	}
	return Result{Action: Ack}
}

// deleteRaw removes the upload on a fresh context; a leftover is reported by storage-gc.
func (j *Job) deleteRaw(img Image, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := j.Objects.DeleteObject(ctx, img.RawBucket, img.RawKey); err != nil {
		log.Warn("delete raw image", "error", err)
	}
}

// cleanup removes partial outputs on a fresh context.
func (j *Job) cleanup(prefix string, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := j.Objects.DeletePrefix(ctx, j.MediaBucket, prefix); err != nil {
		log.Warn("cleanup partial image output", "prefix", prefix, "error", err)
	}
}
