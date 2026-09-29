package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// Heartbeat stamps transcode_jobs.heartbeat_at for a running job.
func (p *Postgres) Heartbeat(ctx context.Context, jobID uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `UPDATE media.transcode_jobs SET heartbeat_at = now() WHERE id = $1`, jobID)
	return err
}

// LostJobError is the error recorded on a job whose worker disappeared.
const LostJobError = "worker lost (no heartbeat)"

// ReconcileStale implements job.Store. Candidates are read without locks;
// each is then handled in its own transaction that locks the video row first
// (the same order as BeginJob, so the two cannot deadlock) with SKIP LOCKED,
// and only then the job row, re-checking that it is still RUNNING and still
// stale. Two reconcilers racing for the same job therefore never both act:
// the loser either skips the locked video or finds the job already FAILED.
func (p *Postgres) ReconcileStale(ctx context.Context, staleAfter time.Duration, maxAttempts, limit int) ([]job.Reconciled, error) {
	secs := staleAfter.Seconds()
	rows, err := p.Pool.Query(ctx, `
		SELECT id, video_id FROM media.transcode_jobs
		WHERE status = 'RUNNING' AND coalesce(heartbeat_at, started_at) < now() - make_interval(secs => $1)
		ORDER BY coalesce(heartbeat_at, started_at) LIMIT $2`, secs, limit)
	if err != nil {
		return nil, fmt.Errorf("find lost jobs: %w", err)
	}
	type cand struct{ job, video uuid.UUID }
	var cands []cand
	for rows.Next() {
		var c cand
		if err := rows.Scan(&c.job, &c.video); err != nil {
			rows.Close()
			return nil, err
		}
		cands = append(cands, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var out []job.Reconciled
	for _, c := range cands {
		r, ok, err := p.reconcileOne(ctx, c.job, c.video, secs, maxAttempts)
		if err != nil {
			return out, err
		}
		if ok {
			out = append(out, r)
		}
	}
	return out, nil
}

func (p *Postgres) reconcileOne(ctx context.Context, jobID, videoID uuid.UUID, staleSecs float64, maxAttempts int) (job.Reconciled, bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return job.Reconciled{}, false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var v job.Video
	var size int64
	var contentType string
	err = tx.QueryRow(ctx, `
		SELECT id, owner_id, status::text, raw_bucket, raw_key, size_bytes, content_type
		FROM media.videos WHERE id = $1 FOR UPDATE SKIP LOCKED`, videoID).
		Scan(&v.ID, &v.OwnerID, &v.Status, &v.RawBucket, &v.RawKey, &size, &contentType)
	if errors.Is(err, pgx.ErrNoRows) {
		return job.Reconciled{}, false, nil // locked by a worker or another reconciler, or gone
	}
	if err != nil {
		return job.Reconciled{}, false, fmt.Errorf("lock video: %w", err)
	}

	var attempt int
	err = tx.QueryRow(ctx, `
		SELECT attempt FROM media.transcode_jobs
		WHERE id = $1 AND status = 'RUNNING'
		  AND coalesce(heartbeat_at, started_at) < now() - make_interval(secs => $2)
		FOR UPDATE`, jobID, staleSecs).Scan(&attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return job.Reconciled{}, false, nil // already handled, finished, or its heartbeat came back
	}
	if err != nil {
		return job.Reconciled{}, false, fmt.Errorf("lock job: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE media.transcode_jobs SET status = 'FAILED', error = $2, finished_at = now() WHERE id = $1`,
		jobID, LostJobError); err != nil {
		return job.Reconciled{}, false, fmt.Errorf("fail lost job: %w", err)
	}

	res := job.Reconciled{VideoID: videoID, JobID: jobID, Attempt: attempt}
	switch {
	case v.Status != "PROCESSING":
		// The video already left PROCESSING (READY/FAILED): only the job needed closing.
	case attempt < maxAttempts:
		if err := outbox.Enqueue(ctx, tx, "media", "video.uploaded", job.UploadedEvent{
			VideoID: v.ID.String(), OwnerID: v.OwnerID.String(), RawBucket: v.RawBucket, RawKey: v.RawKey,
			SizeBytes: size, ContentType: contentType,
		}); err != nil {
			return job.Reconciled{}, false, err
		}
		res.Retried = true
	default:
		if _, _, err := failStuck(ctx, tx, videoID, job.GaveUpFailure); err != nil {
			return job.Reconciled{}, false, err
		}
		res.Failed = true
	}
	if err := tx.Commit(ctx); err != nil {
		return job.Reconciled{}, false, fmt.Errorf("commit: %w", err)
	}
	return res, true, nil
}
