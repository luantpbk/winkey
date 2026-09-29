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

func (p *Postgres) Insert(ctx context.Context, v domain.NewVideo) error {
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO media.videos
			(id, owner_id, title, description, visibility, status, raw_bucket, raw_key,
			 s3_upload_id, content_type, size_bytes)
		VALUES ($1, $2, $3, $4, $5::media.visibility, 'UPLOADING', $6, $7, $8, $9, $10)`,
		v.ID, v.OwnerID, v.Title, v.Description, v.Visibility, v.RawBucket, v.RawKey,
		v.S3UploadID, v.ContentType, v.SizeBytes)
	if err != nil {
		return fmt.Errorf("insert video: %w", err)
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
