// Package store implements domain.Store on PostgreSQL (schema media).
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

// Postgres implements domain.Store.
type Postgres struct{ Pool *pgxpool.Pool }

const cols = `id, owner_id, status::text, raw_bucket, raw_key, coalesce(s3_upload_id, ''),
	content_type, size_bytes, coalesce(error, '')`

func scan(row pgx.Row) (domain.Video, error) {
	var v domain.Video
	err := row.Scan(&v.ID, &v.OwnerID, &v.Status, &v.RawBucket, &v.RawKey, &v.S3UploadID,
		&v.ContentType, &v.SizeBytes, &v.Error)
	return v, err
}

// usageSQL reads the owner's usage in ONE round trip (task UQ1-b, ADR-027 addendum). The daily
// window (count, bytes, oldest) comes from the append-only media.upload_ledger, which keeps one row
// per started upload even after the video row was hard-deleted (index upload_ledger_owner_created).
// The concurrent count stays on media.videos: an upload that was deleted no longer occupies a slot.
const usageSQL = `
	SELECT l.cnt, l.bytes, l.oldest,
		(SELECT count(*) FROM media.videos WHERE owner_id = $1 AND status = 'UPLOADING'),
		now()
	FROM (
		SELECT count(*) AS cnt, coalesce(sum(size_bytes), 0)::bigint AS bytes, min(created_at) AS oldest
		FROM media.upload_ledger
		WHERE owner_id = $1 AND created_at > now() - interval '24 hours'
	) l`

func (p *Postgres) Create(ctx context.Context, v domain.NewVideo, check func(domain.Usage) error,
	startUpload func(context.Context) (string, error)) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	if check != nil {
		// One owner at a time: a second request waits here until the first one has committed
		// (the lock is released at commit), then reads usage that includes the first row.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('upload-quota:' || $1::text, 0))`, v.OwnerID.String()); err != nil {
			return fmt.Errorf("quota lock: %w", err)
		}
		var u domain.Usage
		var oldest *time.Time
		if err := tx.QueryRow(ctx, usageSQL, v.OwnerID).Scan(&u.Count, &u.Bytes, &oldest, &u.Uploading, &u.Now); err != nil {
			return fmt.Errorf("quota usage: %w", err)
		}
		if oldest != nil {
			u.Oldest = *oldest
		}
		if err := check(u); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO media.videos
			(id, owner_id, title, description, visibility, status, raw_bucket, raw_key,
			 content_type, size_bytes)
		VALUES ($1, $2, $3, $4, $5::media.visibility, 'UPLOADING', $6, $7, $8, $9)`,
		v.ID, v.OwnerID, v.Title, v.Description, v.Visibility, v.RawBucket, v.RawKey,
		v.ContentType, v.SizeBytes); err != nil {
		return fmt.Errorf("insert video: %w", err)
	}
	// The ledger row is written for every upload that passed the check, admins included, in the
	// same transaction: a refusal or an S3 failure (rollback) leaves no ledger row either.
	if _, err := tx.Exec(ctx, `
		INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes) VALUES ($1, $2, $3)`,
		v.ID, v.OwnerID, v.SizeBytes); err != nil {
		return fmt.Errorf("insert ledger: %w", err)
	}
	uploadID, err := startUpload(ctx)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE media.videos SET s3_upload_id = $2 WHERE id = $1`, v.ID, uploadID); err != nil {
		return fmt.Errorf("store upload id: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func (p *Postgres) Get(ctx context.Context, id uuid.UUID) (domain.Video, error) {
	v, err := scan(p.Pool.QueryRow(ctx, `SELECT `+cols+` FROM media.videos WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Video{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Video{}, fmt.Errorf("get video: %w", err)
	}
	return v, nil
}

func (p *Postgres) Progress(ctx context.Context, id uuid.UUID) (float64, error) {
	var pr float32
	err := p.Pool.QueryRow(ctx, `
		SELECT progress FROM media.transcode_jobs WHERE video_id = $1 ORDER BY attempt DESC LIMIT 1`, id).Scan(&pr)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get progress: %w", err)
	}
	return float64(pr), nil
}

func (p *Postgres) MarkUploaded(ctx context.Context, v domain.Video) (bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	tag, err := tx.Exec(ctx, `
		UPDATE media.videos SET status = 'UPLOADED', s3_upload_id = NULL
		WHERE id = $1 AND status = 'UPLOADING'`, v.ID)
	if err != nil {
		return false, fmt.Errorf("mark uploaded: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if err := outbox.Enqueue(ctx, tx, "media", "video.uploaded", domain.UploadedEvent{
		VideoID: v.ID.String(), OwnerID: v.OwnerID.String(),
		RawBucket: v.RawBucket, RawKey: v.RawKey,
		SizeBytes: v.SizeBytes, ContentType: v.ContentType,
	}); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

func (p *Postgres) MarkFailed(ctx context.Context, id uuid.UUID, message string) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE media.videos SET status = 'FAILED', s3_upload_id = NULL, error = $2
		WHERE id = $1 AND status = 'UPLOADING'`, id, message)
	if err != nil {
		return false, fmt.Errorf("mark failed: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (p *Postgres) DeleteUploading(ctx context.Context, id uuid.UUID) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `DELETE FROM media.videos WHERE id = $1 AND status = 'UPLOADING'`, id)
	if err != nil {
		return false, fmt.Errorf("delete video: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (p *Postgres) StaleUploads(ctx context.Context, olderThan time.Duration, limit int) ([]domain.Video, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT `+cols+` FROM media.videos
		WHERE status = 'UPLOADING' AND created_at < now() - make_interval(secs => $1)
		ORDER BY created_at LIMIT $2`, olderThan.Seconds(), limit)
	if err != nil {
		return nil, fmt.Errorf("stale uploads: %w", err)
	}
	defer rows.Close()
	var out []domain.Video
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// PurgeLedger deletes at most limit ledger rows created more than olderThan ago and returns how many.
// The database trigger refuses rows younger than 25 h, so olderThan must be at least that.
func (p *Postgres) PurgeLedger(ctx context.Context, olderThan time.Duration, limit int) (int, error) {
	tag, err := p.Pool.Exec(ctx, `
		DELETE FROM media.upload_ledger
		WHERE ctid IN (
			SELECT ctid FROM media.upload_ledger
			WHERE created_at < now() - make_interval(secs => $1)
			LIMIT $2)`, olderThan.Seconds(), limit)
	if err != nil {
		return 0, fmt.Errorf("purge ledger: %w", err)
	}
	return int(tag.RowsAffected()), nil
}
