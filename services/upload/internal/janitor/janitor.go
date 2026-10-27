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
// longer than StaleAfter (index media.videos_stale_uploads), audio tracks included.
type Janitor struct {
	Store domain.Store
	Audio domain.AudioStore // nil skips the audio tracks (MUX1)
	// Images and ImageStorage sweep social images left UPLOADING longer than ImageStaleAfter (SOC-1b); nil skips.
	Images          domain.ImageStore
	ImageStorage    domain.ImageStorage
	ImageStaleAfter time.Duration // default 1h
	Storage         domain.Storage
	Log             *slog.Logger
	Interval        time.Duration // default 10m
	StaleAfter      time.Duration // default 24h
	BatchSize       int           // default 100

	// Upload ledger retention (UQ1-b): rows older than LedgerRetention are deleted, at most
	// LedgerBatch per statement, until none are left. The database refuses rows younger than 25 h.
	LedgerRetention time.Duration // default 48h
	LedgerBatch     int           // default 1000
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
	// The ledger retention runs on every sweep, whatever happens to the stale uploads below.
	purged, perr := j.purgeLedger(ctx)
	if purged > 0 {
		j.Log.InfoContext(ctx, "upload janitor purged ledger rows", "count", purged)
	}
	stale, err := j.Store.StaleUploads(ctx, j.StaleAfter, j.BatchSize)
	if err != nil {
		return 0, errors.Join(err, perr)
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
	n, aerr := j.sweepAudio(ctx)
	m, ierr := j.sweepImages(ctx)
	return deleted + n + m, errors.Join(perr, aerr, ierr)
}

// sweepImages deletes images stuck in UPLOADING: the object (if the PUT happened) and the row.
func (j *Janitor) sweepImages(ctx context.Context) (int, error) {
	if j.Images == nil {
		return 0, nil
	}
	if j.ImageStaleAfter <= 0 {
		j.ImageStaleAfter = time.Hour
	}
	stale, err := j.Images.StaleImageUploads(ctx, j.ImageStaleAfter, j.BatchSize)
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, img := range stale {
		if ctx.Err() != nil {
			break
		}
		if err := j.ImageStorage.DeleteObject(ctx, img.RawBucket, img.RawKey); err != nil && !errors.Is(err, domain.ErrNoSuchObject) {
			j.Log.WarnContext(ctx, "delete stale image object failed", "image_id", img.ID, "error", err)
			continue
		}
		ok, err := j.Images.DeleteUploadingImage(ctx, img.ID)
		if err != nil {
			j.Log.WarnContext(ctx, "delete stale image failed", "image_id", img.ID, "error", err)
			continue
		}
		if ok {
			deleted++
		}
	}
	return deleted, nil
}

// sweepAudio does the same for audio tracks stuck in UPLOADING.
func (j *Janitor) sweepAudio(ctx context.Context) (int, error) {
	if j.Audio == nil {
		return 0, nil
	}
	stale, err := j.Audio.StaleAudioUploads(ctx, j.StaleAfter, j.BatchSize)
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, t := range stale {
		if ctx.Err() != nil {
			break
		}
		if t.S3UploadID != "" {
			err := j.Storage.AbortMultipart(ctx, t.RawBucket, t.RawKey, t.S3UploadID)
			if err != nil && !errors.Is(err, domain.ErrNoSuchUpload) {
				j.Log.WarnContext(ctx, "abort stale audio multipart failed", "track_id", t.ID, "error", err)
				continue
			}
		}
		ok, err := j.Audio.DeleteUploadingAudio(ctx, t.ID)
		if err != nil {
			j.Log.WarnContext(ctx, "delete stale audio upload failed", "track_id", t.ID, "error", err)
			continue
		}
		if ok {
			deleted++
		}
	}
	return deleted, nil
}

// purgeLedger deletes ledger rows older than LedgerRetention in batches and returns the total.
func (j *Janitor) purgeLedger(ctx context.Context) (int, error) {
	if j.LedgerRetention <= 0 {
		j.LedgerRetention = 48 * time.Hour
	}
	if j.LedgerBatch <= 0 {
		j.LedgerBatch = 1000
	}
	total := 0
	for ctx.Err() == nil {
		n, err := j.Store.PurgeLedger(ctx, j.LedgerRetention, j.LedgerBatch)
		total += n
		if err != nil {
			return total, err
		}
		if n < j.LedgerBatch {
			break
		}
	}
	return total, nil
}
