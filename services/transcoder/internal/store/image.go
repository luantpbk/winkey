package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/services/transcoder/internal/image"
)

var _ image.Store = (*Postgres)(nil)

// BeginImage implements image.Store (task SOC-1b).
func (p *Postgres) BeginImage(ctx context.Context, id uuid.UUID) (image.Image, bool, error) {
	var img image.Image
	err := p.Pool.QueryRow(ctx, `
		SELECT id, owner_id, purpose, raw_bucket, raw_key FROM media.images WHERE id = $1 AND status = 'PROCESSING'`,
		id).Scan(&img.ID, &img.OwnerID, &img.Purpose, &img.RawBucket, &img.RawKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return image.Image{}, false, nil
	}
	if err != nil {
		return image.Image{}, false, fmt.Errorf("begin image: %w", err)
	}
	return img, true, nil
}

// CompleteImage implements image.Store.
func (p *Postgres) CompleteImage(ctx context.Context, id uuid.UUID, out image.Output) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE media.images SET status = 'READY', image_key = $2, thumb_key = $3, width = $4, height = $5,
			output_bytes = $6
		WHERE id = $1 AND status = 'PROCESSING'`, id, out.ImageKey, out.ThumbKey, out.Width, out.Height, out.Bytes)
	if err != nil {
		return false, fmt.Errorf("complete image: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// FailImage implements image.Store.
func (p *Postgres) FailImage(ctx context.Context, id uuid.UUID, reason string) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `UPDATE media.images SET status = 'FAILED', error = $2 WHERE id = $1 AND status = 'PROCESSING'`, id, reason)
	if err != nil {
		return false, fmt.Errorf("fail image: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}
