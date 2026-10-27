package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

var _ domain.ImageStore = (*Postgres)(nil)

const imageCols = `id, owner_id, purpose, status, content_type, size_bytes, raw_bucket, raw_key,
	coalesce(image_key, ''), coalesce(thumb_key, ''), coalesce(width, 0), coalesce(height, 0), coalesce(error, ''),
	created_at`

func scanImage(row pgx.Row) (domain.Image, error) {
	var i domain.Image
	err := row.Scan(&i.ID, &i.OwnerID, &i.Purpose, &i.Status, &i.ContentType, &i.SizeBytes, &i.RawBucket, &i.RawKey,
		&i.ImageKey, &i.ThumbKey, &i.Width, &i.Height, &i.Error, &i.CreatedAt)
	return i, err
}

// imageUsageSQL reads the owner's image quota state in one statement (index media.images_owner_created).
const imageUsageSQL = `
	SELECT count(*) FILTER (WHERE status IN ('UPLOADING', 'PROCESSING')),
	       count(*) FILTER (WHERE created_at > now() - interval '24 hours'),
	       min(created_at) FILTER (WHERE created_at > now() - interval '24 hours'),
	       now()
	FROM media.images WHERE owner_id = $1 AND (status IN ('UPLOADING', 'PROCESSING') OR created_at > now() - interval '24 hours')`

func (p *Postgres) CreateImage(ctx context.Context, img domain.Image, check func(domain.ImageUsage) error) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	if check != nil {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('image-quota:' || $1::text, 0))`, img.OwnerID.String()); err != nil {
			return fmt.Errorf("image quota lock: %w", err)
		}
		var u domain.ImageUsage
		var oldest *time.Time
		if err := tx.QueryRow(ctx, imageUsageSQL, img.OwnerID).Scan(&u.Pending, &u.Count, &oldest, &u.Now); err != nil {
			return fmt.Errorf("image usage: %w", err)
		}
		if oldest != nil {
			u.Oldest = *oldest
		}
		if err := check(u); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO media.images (id, owner_id, purpose, status, content_type, size_bytes, raw_bucket, raw_key)
		VALUES ($1, $2, $3, 'UPLOADING', $4, $5, $6, $7)`,
		img.ID, img.OwnerID, img.Purpose, img.ContentType, img.SizeBytes, img.RawBucket, img.RawKey); err != nil {
		return fmt.Errorf("insert image: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func (p *Postgres) GetImage(ctx context.Context, id uuid.UUID) (domain.Image, error) {
	i, err := scanImage(p.Pool.QueryRow(ctx, `SELECT `+imageCols+` FROM media.images WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Image{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Image{}, fmt.Errorf("get image: %w", err)
	}
	return i, nil
}

func (p *Postgres) MarkImageUploaded(ctx context.Context, img domain.Image) (bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	tag, err := tx.Exec(ctx, `UPDATE media.images SET status = 'PROCESSING' WHERE id = $1 AND status = 'UPLOADING'`, img.ID)
	if err != nil {
		return false, fmt.Errorf("mark image uploaded: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if err := outbox.Enqueue(ctx, tx, "media", "media.image_uploaded", domain.ImageUploadedEvent{
		ImageID: img.ID.String(), OwnerID: img.OwnerID.String(), Purpose: img.Purpose,
		RawBucket: img.RawBucket, RawKey: img.RawKey, SizeBytes: img.SizeBytes, ContentType: img.ContentType,
	}); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

func (p *Postgres) StaleImageUploads(ctx context.Context, olderThan time.Duration, limit int) ([]domain.Image, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT `+imageCols+` FROM media.images
		WHERE status = 'UPLOADING' AND created_at < now() - make_interval(secs => $1)
		ORDER BY created_at LIMIT $2`, olderThan.Seconds(), limit)
	if err != nil {
		return nil, fmt.Errorf("stale images: %w", err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Image, error) { return scanImage(r) })
}

func (p *Postgres) DeleteUploadingImage(ctx context.Context, id uuid.UUID) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `DELETE FROM media.images WHERE id = $1 AND status = 'UPLOADING'`, id)
	if err != nil {
		return false, fmt.Errorf("delete image: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}
