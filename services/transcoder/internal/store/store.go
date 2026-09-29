// Package store implements job.Store on PostgreSQL (schema media).
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// Postgres implements job.Store.
type Postgres struct{ Pool *pgxpool.Pool }

var _ job.Store = (*Postgres)(nil)

func (p *Postgres) BeginJob(ctx context.Context, videoID uuid.UUID, encoder, workerID string) (job.BeginResult, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return job.BeginResult{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var v job.Video
	err = tx.QueryRow(ctx, `
		SELECT id, owner_id, status::text, raw_bucket, raw_key
		FROM media.videos WHERE id = $1 FOR UPDATE`, videoID).
		Scan(&v.ID, &v.OwnerID, &v.Status, &v.RawBucket, &v.RawKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return job.BeginResult{Skip: true}, nil
	}
	if err != nil {
		return job.BeginResult{}, fmt.Errorf("load video: %w", err)
	}
	switch v.Status {
	case "READY":
		return job.BeginResult{Skip: true, Video: v}, nil
	case "UPLOADING":
		// The event is written in the same transaction that sets UPLOADED, so
		// this cannot happen unless something is badly wrong: retry later.
		return job.BeginResult{}, fmt.Errorf("video %s is still UPLOADING", videoID)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE media.videos SET status = 'PROCESSING', error = NULL
		WHERE id = $1 AND status IN ('UPLOADED', 'FAILED', 'PROCESSING')`, videoID); err != nil {
		return job.BeginResult{}, fmt.Errorf("mark processing: %w", err)
	}
	// A crashed worker can leave an active job behind; only one may be active
	// per video (unique index), so retire it.
	if _, err := tx.Exec(ctx, `
		UPDATE media.transcode_jobs
		SET status = 'FAILED', error = 'superseded by a new attempt', finished_at = now()
		WHERE video_id = $1 AND status IN ('QUEUED', 'RUNNING')`, videoID); err != nil {
		return job.BeginResult{}, fmt.Errorf("retire stale jobs: %w", err)
	}
	var attempt int
	if err := tx.QueryRow(ctx,
		`SELECT coalesce(max(attempt), 0) + 1 FROM media.transcode_jobs WHERE video_id = $1`, videoID).
		Scan(&attempt); err != nil {
		return job.BeginResult{}, fmt.Errorf("next attempt: %w", err)
	}
	jobID := ids.New()
	if _, err := tx.Exec(ctx, `
		INSERT INTO media.transcode_jobs (id, video_id, attempt, status, encoder, worker_id, started_at)
		VALUES ($1, $2, $3, 'RUNNING', $4, $5, now())`, jobID, videoID, attempt, encoder, workerID); err != nil {
		return job.BeginResult{}, fmt.Errorf("insert job: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return job.BeginResult{}, fmt.Errorf("commit: %w", err)
	}
	v.Status = "PROCESSING"
	return job.BeginResult{Video: v, JobID: jobID, Attempt: attempt}, nil
}

func (p *Postgres) SetJobEncoder(ctx context.Context, jobID uuid.UUID, encoder string) error {
	_, err := p.Pool.Exec(ctx, `UPDATE media.transcode_jobs SET encoder = $2 WHERE id = $1`, jobID, encoder)
	return err
}

func (p *Postgres) SetProgress(ctx context.Context, jobID uuid.UUID, percent float64) error {
	_, err := p.Pool.Exec(ctx, `UPDATE media.transcode_jobs SET progress = $2 WHERE id = $1`, jobID, float32(percent))
	return err
}

type readyRendition struct {
	Name        string `json:"name"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	BitrateKbps int    `json:"bitrate_kbps"`
}

type readyEvent struct {
	VideoID      string           `json:"video_id"`
	OwnerID      string           `json:"owner_id"`
	JobID        string           `json:"job_id"`
	Attempt      int              `json:"attempt"`
	Encoder      string           `json:"encoder"`
	HLSMasterKey string           `json:"hls_master_key"`
	ThumbnailKey string           `json:"thumbnail_key"`
	DurationMs   int              `json:"duration_ms"`
	Width        int              `json:"width"`
	Height       int              `json:"height"`
	Renditions   []readyRendition `json:"renditions"`
}

func (p *Postgres) Complete(ctx context.Context, r job.ReadyResult) (bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	tag, err := tx.Exec(ctx, `
		UPDATE media.videos SET
			status = 'READY', duration_ms = $2, width = $3, height = $4,
			hls_master_key = $5, thumbnail_key = $6,
			published_at = coalesce(published_at, now()), error = NULL
		WHERE id = $1 AND status = 'PROCESSING'`,
		r.VideoID, r.DurationMs, r.Width, r.Height, r.MasterKey, r.ThumbKey)
	if err != nil {
		return false, fmt.Errorf("mark ready: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `DELETE FROM media.video_renditions WHERE video_id = $1`, r.VideoID); err != nil {
		return false, fmt.Errorf("clear renditions: %w", err)
	}
	ev := readyEvent{
		VideoID: r.VideoID.String(), OwnerID: r.OwnerID.String(), JobID: r.JobID.String(),
		Attempt: r.Attempt, Encoder: r.Encoder, HLSMasterKey: r.MasterKey, ThumbnailKey: r.ThumbKey,
		DurationMs: r.DurationMs, Width: r.Width, Height: r.Height,
	}
	for i, rd := range r.Renditions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO media.video_renditions (video_id, name, width, height, bitrate_kbps, playlist_key)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			r.VideoID, rd.Name, rd.Width, rd.Height, rd.TargetK, r.PlaylistKeys[i]); err != nil {
			return false, fmt.Errorf("insert rendition %s: %w", rd.Name, err)
		}
		ev.Renditions = append(ev.Renditions, readyRendition{rd.Name, rd.Width, rd.Height, rd.TargetK})
	}
	if _, err := tx.Exec(ctx, `
		UPDATE media.transcode_jobs
		SET status = 'SUCCEEDED', progress = 100, encoder = $2, finished_at = now(), error = NULL
		WHERE id = $1`, r.JobID, r.Encoder); err != nil {
		return false, fmt.Errorf("finish job: %w", err)
	}
	if err := outbox.Enqueue(ctx, tx, "media", "video.ready", ev); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

type failedEvent struct {
	VideoID   string `json:"video_id"`
	OwnerID   string `json:"owner_id"`
	JobID     string `json:"job_id"`
	Attempt   int    `json:"attempt"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (p *Postgres) FailJob(ctx context.Context, f job.FailRecord) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	if _, err := tx.Exec(ctx, `
		UPDATE media.transcode_jobs SET status = 'FAILED', error = $2, finished_at = now()
		WHERE id = $1`, f.JobID, f.Failure.Reason+": "+f.Failure.Message); err != nil {
		return fmt.Errorf("fail job: %w", err)
	}
	if f.Terminal {
		tag, err := tx.Exec(ctx, `
			UPDATE media.videos SET status = 'FAILED', error = $2
			WHERE id = $1 AND status = 'PROCESSING'`, f.VideoID, f.Failure.Message)
		if err != nil {
			return fmt.Errorf("fail video: %w", err)
		}
		if tag.RowsAffected() == 1 {
			if err := outbox.Enqueue(ctx, tx, "media", "video.failed", failedEvent{
				VideoID: f.VideoID.String(), OwnerID: f.OwnerID.String(), JobID: f.JobID.String(),
				Attempt: f.Attempt, Reason: f.Failure.Reason, Message: f.Failure.Message,
				Retryable: f.Failure.Retryable,
			}); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func (p *Postgres) FailStuck(ctx context.Context, videoID uuid.UUID, f job.Failure) (job.FailRecord, bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return job.FailRecord{}, false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var owner uuid.UUID
	var status string
	err = tx.QueryRow(ctx, `SELECT owner_id, status::text FROM media.videos WHERE id = $1 FOR UPDATE`, videoID).
		Scan(&owner, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return job.FailRecord{}, false, nil
	}
	if err != nil {
		return job.FailRecord{}, false, fmt.Errorf("load video: %w", err)
	}
	if status != "PROCESSING" && status != "UPLOADED" {
		return job.FailRecord{}, false, nil // READY / FAILED / UPLOADING: nothing to give up on
	}

	text := f.Reason + ": " + f.Message
	var jobID uuid.UUID
	var attempt int
	var jobStatus string
	err = tx.QueryRow(ctx, `
		SELECT id, attempt, status::text FROM media.transcode_jobs
		WHERE video_id = $1 ORDER BY attempt DESC LIMIT 1`, videoID).Scan(&jobID, &attempt, &jobStatus)
	switch {
	case err == nil && (jobStatus == "RUNNING" || jobStatus == "QUEUED"):
		if _, err := tx.Exec(ctx, `
			UPDATE media.transcode_jobs SET status = 'FAILED', error = $2, finished_at = now() WHERE id = $1`,
			jobID, text); err != nil {
			return job.FailRecord{}, false, fmt.Errorf("close job: %w", err)
		}
	case err == nil && jobStatus == "FAILED":
		// The last attempt already failed; report against it.
	case err == nil || errors.Is(err, pgx.ErrNoRows):
		// No job ever ran (or the last one succeeded): record one so the event has a job_id.
		attempt++
		jobID = ids.New()
		if _, err := tx.Exec(ctx, `
			INSERT INTO media.transcode_jobs (id, video_id, attempt, status, error, finished_at)
			VALUES ($1, $2, $3, 'FAILED', $4, now())`, jobID, videoID, attempt, text); err != nil {
			return job.FailRecord{}, false, fmt.Errorf("record job: %w", err)
		}
	default:
		return job.FailRecord{}, false, fmt.Errorf("latest job: %w", err)
	}

	if _, err := tx.Exec(ctx, `UPDATE media.videos SET status = 'FAILED', error = $2 WHERE id = $1`,
		videoID, f.Message); err != nil {
		return job.FailRecord{}, false, fmt.Errorf("fail video: %w", err)
	}
	rec := job.FailRecord{VideoID: videoID, OwnerID: owner, JobID: jobID, Attempt: attempt, Failure: f, Terminal: true}
	if err := outbox.Enqueue(ctx, tx, "media", "video.failed", failedEvent{
		VideoID: videoID.String(), OwnerID: owner.String(), JobID: jobID.String(), Attempt: attempt,
		Reason: f.Reason, Message: f.Message, Retryable: f.Retryable,
	}); err != nil {
		return job.FailRecord{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return job.FailRecord{}, false, fmt.Errorf("commit: %w", err)
	}
	return rec, true, nil
}
