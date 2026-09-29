// Package janitor removes abandoned uploads.
package janitor

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

// Janitor aborts multipart uploads and deletes rows stuck in UPLOADING for
// longer than StaleAfter (index media.videos_stale_uploads).
type Janitor struct {
	Store      domain.Store
	Storage    domain.Storage
	Log        *slog.Logger
	Interval   time.Duration // default 10m
	StaleAfter time.Duration // default 24h
	BatchSize  int           // default 100
}

// Run sweeps immediately and then every Interval until ctx is cancelled.
func (j *Janitor) Run(ctx context.Context) {
	if j.Interval <= 0 {
		j.Interval = 10 * time.Minute
	}
	t := time.NewTicker(j.Interval)
	defer t.Stop()
	for {
		if n, err := j.Sweep(ctx); err != nil {
			j.Log.ErrorContext(ctx, "upload janitor sweep failed", "error", err)
		} else if n > 0 {
			j.Log.InfoContext(ctx, "upload janitor removed stale uploads", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Sweep processes stale uploads, returning how many rows were deleted. A video
// whose multipart abort fails for a reason other than "already gone" is left
// for the next sweep.
func (j *Janitor) Sweep(ctx context.Context) (int, error) {
	if j.StaleAfter <= 0 {
		j.StaleAfter = 24 * time.Hour
	}
	if j.BatchSize <= 0 {
		j.BatchSize = 100
	}
	stale, err := j.Store.StaleUploads(ctx, j.StaleAfter, j.BatchSize)
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, v := range stale {
		if ctx.Err() != nil {
			break
		}
		if v.S3UploadID != "" {
			err := j.Storage.AbortMultipart(ctx, v.RawBucket, v.RawKey, v.S3UploadID)
			if err != nil && !errors.Is(err, domain.ErrNoSuchUpload) {
				j.Log.WarnContext(ctx, "abort stale multipart failed", "video_id", v.ID, "error", err)
				continue
			}
		}
		ok, err := j.Store.DeleteUploading(ctx, v.ID)
		if err != nil {
			j.Log.WarnContext(ctx, "delete stale upload failed", "video_id", v.ID, "error", err)
			continue
		}
		if ok {
			deleted++
		}
	}
	return deleted, nil
}
