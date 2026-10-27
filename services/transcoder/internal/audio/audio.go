// Package audio runs the audio-only job of task MUX1 (ADR-042): an extra audio track uploaded after the
// video (video.audio_uploaded) is probed, checked against the video's duration, encoded into an HLS
// alternate audio rendition under v/{video_id}/audio/{track_id}/ and added to the video's master playlist.
// The video is never re-encoded.
//
// The output lives outside the v/{video_id}/a{n}/ attempt directories, so a later re-encode of the video
// (which deletes older attempts) keeps it; that re-encode re-applies the audio group to its new master
// (store.Complete).
package audio

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// UploadedEvent is the `data` of video.audio_uploaded.
type UploadedEvent struct {
	VideoID     string `json:"video_id"`
	OwnerID     string `json:"owner_id"`
	TrackID     string `json:"track_id"`
	Lang        string `json:"lang"`
	Kind        string `json:"kind"`
	RawBucket   string `json:"raw_bucket"`
	RawKey      string `json:"raw_key"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
}

// Outcome of Store.BeginAudio.
type Outcome int

const (
	// Run: the track is now PROCESSING; encode it.
	Run Outcome = iota
	// Skip: nothing to do (the track is gone, READY or FAILED; the video is gone). Ack.
	Skip
	// Wait: the video is not READY yet (still uploading or processing). Retry later.
	Wait
	// VideoFailed: the video failed to process, so the track never can. Fail it.
	VideoFailed
)

// Track is what the job knows of the track and its video.
type Track struct {
	ID, VideoID, OwnerID uuid.UUID
	Lang, Kind           string
	RawBucket, RawKey    string
	VideoDurationMs      int
}

// Failure reasons of video.audio_failed; the reason is also the track's `error`.
const (
	ReasonInvalidInput     = "INVALID_INPUT"
	ReasonDurationMismatch = "AUDIO_DURATION_MISMATCH"
	ReasonEncoder          = "ENCODER_ERROR"
	ReasonStorage          = "STORAGE_ERROR"
	ReasonInternal         = "INTERNAL"
)

// Failure is one failed track: Message is safe to show to the owner.
type Failure struct {
	Reason    string
	Message   string
	Retryable bool
}

// Rewrite stores a master with the given READY tracks next to masterKey and returns its key.
type Rewrite func(ctx context.Context, masterKey string, ready []hlsmaster.Track) (string, error)

// Store is the persistence port (media.video_audio_tracks, media.videos, outbox).
type Store interface {
	// BeginAudio, in one transaction holding the video row lock: decides the Outcome and, for Run, moves
	// the track UPLOADED|PROCESSING → PROCESSING.
	BeginAudio(ctx context.Context, trackID uuid.UUID) (Outcome, Track, error)
	// CompleteAudio, in one transaction holding the video row lock: PROCESSING → READY with playlistKey
	// and durationMs; when the video is READY, rewrites its master with every READY track and stores the
	// new hls_master_key (a video being re-encoded gets the group from its own Complete); enqueues
	// video.audio_ready. ok is false when the track is no longer PROCESSING (deleted meanwhile).
	CompleteAudio(ctx context.Context, trackID uuid.UUID, playlistKey string, durationMs int, rewrite Rewrite) (ok bool, err error)
	// FailAudio sets the track FAILED (error = reason) unless it is READY or gone, and enqueues
	// video.audio_failed. ok is false when there was nothing to fail.
	FailAudio(ctx context.Context, trackID uuid.UUID, f Failure) (ok bool, err error)
}

// Media is the local media-processing port (job.Tools).
type Media interface {
	ProbeAudio(ctx context.Context, path string) (media.AudioInfo, error)
	EncodeAudioHLS(ctx context.Context, input, outDir string, durationSec float64) error
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

// Retry delays.
const (
	WaitDelay  = 2 * time.Minute  // the video is still processing
	RetryDelay = 30 * time.Second // a transient error (database, storage)
	// MaxDeliveries bounds the redeliveries of one message: about 6 h of WaitDelay, longer than the
	// longest video encode. Past it the track fails with INTERNAL.
	MaxDeliveries = 200
)

const cacheImmutable = job.CacheImmutable

// Job processes video.audio_uploaded messages.
type Job struct {
	Store       Store
	Objects     job.Objects
	Media       Media
	MediaBucket string
	WorkDir     string // scratch space; one sub-directory per job
	Log         *slog.Logger
}

// Process runs one message. delivery is the 1-based delivery count of the message.
func (j *Job) Process(ctx context.Context, ev UploadedEvent, delivery int) Result {
	log := j.Log.With("video_id", ev.VideoID, "track_id", ev.TrackID, "delivery", delivery)
	trackID, err := uuid.Parse(ev.TrackID)
	if err != nil {
		log.ErrorContext(ctx, "video.audio_uploaded with an invalid track_id; dropping")
		return Result{Action: Ack}
	}
	outcome, t, err := j.Store.BeginAudio(ctx, trackID)
	if err != nil {
		return j.retry(ctx, log, trackID, delivery, "begin", err)
	}
	switch outcome {
	case Skip:
		log.InfoContext(ctx, "nothing to do (track READY, FAILED or gone); acking")
		return Result{Action: Ack}
	case Wait:
		if delivery >= MaxDeliveries {
			return j.fail(ctx, log, trackID, Failure{ReasonInternal, "The video did not finish processing in time.", true})
		}
		return Result{Action: Nak, Delay: WaitDelay}
	case VideoFailed:
		return j.fail(ctx, log, trackID, Failure{ReasonInvalidInput, "The video failed to process, so its audio tracks cannot be added.", false})
	}

	dir, err := os.MkdirTemp(j.WorkDir, "audio-"+trackID.String()+"-")
	if err != nil {
		return j.retry(ctx, log, trackID, delivery, "scratch dir", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	src := filepath.Join(dir, "source")
	if err := j.Objects.Download(ctx, t.RawBucket, t.RawKey, src); err != nil {
		return j.retry(ctx, log, trackID, delivery, "download", err)
	}
	info, err := j.Media.ProbeAudio(ctx, src)
	var invalid *media.InvalidInputError
	switch {
	case errors.As(err, &invalid):
		return j.fail(ctx, log, trackID, Failure{ReasonInvalidInput, "The audio file cannot be used: " + invalid.Msg + ".", false})
	case err != nil:
		return j.retry(ctx, log, trackID, delivery, "probe", err)
	}
	if !media.AudioMatchesVideo(info.DurationSec, t.VideoDurationMs) {
		return j.fail(ctx, log, trackID, Failure{ReasonDurationMismatch, fmt.Sprintf(
			"The audio is %.2f s long but the video is %.2f s; they may differ by at most %.1f s.",
			info.DurationSec, float64(t.VideoDurationMs)/1000, media.AudioDurationTolerance), false})
	}

	out := filepath.Join(dir, "hls")
	if err := j.Media.EncodeAudioHLS(ctx, src, out, info.DurationSec); err != nil {
		if ctx.Err() != nil {
			return Result{Action: Nak, Delay: RetryDelay} // shutdown: another worker takes it
		}
		log.WarnContext(ctx, "audio encode failed", "error", err)
		return j.fail(ctx, log, trackID, Failure{ReasonEncoder, "The audio could not be encoded. Export it again (WAV or FLAC) and upload it.", true})
	}

	prefix := fmt.Sprintf("v/%s/audio/%s/", t.VideoID, t.ID)
	if err := j.upload(ctx, out, prefix); err != nil {
		j.cleanup(prefix, log)
		return j.retry(ctx, log, trackID, delivery, "upload", err)
	}
	durationMs := max(1, int(info.DurationSec*1000+0.5))
	ok, err := j.Store.CompleteAudio(ctx, trackID, prefix+media.AudioPlaylist, durationMs, j.rewriteMaster(dir))
	if err != nil {
		return j.retry(ctx, log, trackID, delivery, "complete", err)
	}
	if !ok {
		log.WarnContext(ctx, "track no longer PROCESSING (deleted?); discarding output")
		j.cleanup(prefix, log)
		return Result{Action: Ack}
	}
	log.InfoContext(ctx, "audio track ready", "duration_ms", durationMs)
	j.deleteRaw(t, log)
	return Result{Action: Ack}
}

// deleteRaw removes the uploaded audio once its track is READY: only the HLS output is ever read again (a re-encode
// of the video re-applies the audio group from it), unlike the video's own raw file, which AV1 upgrades still use.
// Best effort on a fresh context: a leftover is reported by storage-gc as raw-audio-processed.
func (j *Job) deleteRaw(t Track, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := j.Objects.DeleteObject(ctx, t.RawBucket, t.RawKey); err != nil {
		log.Warn("delete processed raw audio", "error", err)
	}
}

// upload sends every file of dir to prefix: segments and init first, the playlist last, so a playlist is
// never visible before what it lists.
func (j *Job) upload(ctx context.Context, dir, prefix string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var playlist string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if e.Name() == media.AudioPlaylist {
			playlist = e.Name()
			continue
		}
		if strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		if err := j.Objects.UploadFile(ctx, j.MediaBucket, prefix+e.Name(), filepath.Join(dir, e.Name()), "video/mp4", cacheImmutable); err != nil {
			return err
		}
	}
	if playlist == "" {
		return errors.New("no playlist in the encoder output")
	}
	return j.Objects.UploadFile(ctx, j.MediaBucket, prefix+playlist, filepath.Join(dir, playlist), hlsmaster.ContentType, cacheImmutable)
}

// rewriteMaster is the Rewrite of the audio job: download the current master, replace its audio group,
// upload it under a new key next to it.
func (j *Job) rewriteMaster(dir string) Rewrite {
	return func(ctx context.Context, masterKey string, ready []hlsmaster.Track) (string, error) {
		return job.RewriteMaster(ctx, j.Objects, j.MediaBucket, dir, masterKey, ready)
	}
}

func (j *Job) retry(ctx context.Context, log *slog.Logger, trackID uuid.UUID, delivery int, op string, err error) Result {
	if ctx.Err() != nil {
		return Result{Action: Nak, Delay: RetryDelay}
	}
	log.WarnContext(ctx, "audio job step failed; will retry", "op", op, "error", err)
	if delivery >= MaxDeliveries {
		reason := ReasonInternal
		if op == "download" || op == "upload" {
			reason = ReasonStorage
		}
		return j.fail(ctx, log, trackID, Failure{reason, "Processing the audio did not complete after several attempts.", true})
	}
	return Result{Action: Nak, Delay: RetryDelay}
}

func (j *Job) fail(ctx context.Context, log *slog.Logger, trackID uuid.UUID, f Failure) Result {
	ok, err := j.Store.FailAudio(ctx, trackID, f)
	if err != nil {
		log.ErrorContext(ctx, "recording the audio failure failed; will retry", "error", err)
		return Result{Action: Nak, Delay: RetryDelay}
	}
	if ok {
		log.InfoContext(ctx, "audio track failed", "reason", f.Reason)
	}
	return Result{Action: Ack}
}

// cleanup removes a partial output on a fresh context (the job context may be cancelled).
func (j *Job) cleanup(prefix string, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := j.Objects.DeletePrefix(ctx, j.MediaBucket, prefix); err != nil {
		log.Warn("cleanup partial audio output", "prefix", prefix, "error", err)
	}
}
