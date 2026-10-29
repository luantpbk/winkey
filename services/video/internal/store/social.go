package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Social videos (SOC-2b, ADR-049): a SOCIAL video belongs to a post. social-svc reports the attachment and the
// release through events; a video never attached is deleted by the janitor.

// AttachSocialVideo sets attached_at (once) on a SOCIAL video owned by authorID. found is false when there is no
// such video (deleted, a FILM, or someone else's): the event is then ignored.
func (p *Postgres) AttachSocialVideo(ctx context.Context, videoID, authorID uuid.UUID) (found bool, err error) {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE media.videos SET attached_at = coalesce(attached_at, now())
		WHERE id = $1 AND owner_id = $2 AND purpose = 'SOCIAL'`, videoID, authorID)
	if err != nil {
		return false, fmt.Errorf("attach social video: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// ReleaseSocialVideo deletes a SOCIAL video owned by authorID (its post was deleted) and enqueues video.deleted
// in the same transaction. deleted is false when there is no such video (already deleted: idempotent).
func (p *Postgres) ReleaseSocialVideo(ctx context.Context, videoID, authorID uuid.UUID, mediaBucket string) (deleted bool, err error) {
	ids, err := p.deleteVideosWhere(ctx, mediaBucket,
		`id = $1 AND owner_id = $2 AND purpose = 'SOCIAL'`, videoID, authorID)
	return len(ids) == 1, err
}

// DeleteUnattachedSocialVideos deletes up to limit SOCIAL videos never attached to a post: READY for longer than
// olderThan (published_at is set when the video becomes READY), or FAILED and created longer ago than that. Each
// gets its video.deleted in the same transaction. Rows locked by another replica are skipped.
func (p *Postgres) DeleteUnattachedSocialVideos(ctx context.Context, olderThan time.Duration, limit int, mediaBucket string) ([]uuid.UUID, error) {
	cutoff := time.Now().Add(-olderThan)
	return p.deleteVideosWhere(ctx, mediaBucket, `id IN (
		SELECT id FROM media.videos
		WHERE purpose = 'SOCIAL' AND attached_at IS NULL AND created_at < $1
		  AND (status = 'FAILED' OR (status = 'READY' AND published_at < $1))
		ORDER BY created_at
		LIMIT $2
		FOR UPDATE SKIP LOCKED)`, cutoff, limit)
}

// deleteVideosWhere deletes the matching videos (the cascade removes renditions and jobs) and enqueues one
// video.deleted per row, in ONE transaction (ADR-008), like DeleteVideo.
func (p *Postgres) deleteVideosWhere(ctx context.Context, mediaBucket, where string, args ...any) ([]uuid.UUID, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	rows, err := tx.Query(ctx, `DELETE FROM media.videos WHERE `+where+` RETURNING id, owner_id, raw_bucket, raw_key`, args...)
	if err != nil {
		return nil, fmt.Errorf("delete videos: %w", err)
	}
	type gone struct {
		id, owner         uuid.UUID
		rawBucket, rawKey string
	}
	victims, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (gone, error) {
		var g gone
		err := r.Scan(&g.id, &g.owner, &g.rawBucket, &g.rawKey)
		return g, err
	})
	if err != nil {
		return nil, fmt.Errorf("delete videos: %w", err)
	}
	ids := make([]uuid.UUID, 0, len(victims))
	for _, g := range victims {
		if err := outbox.Enqueue(ctx, tx, "media", "video.deleted", domain.DeletedEvent{
			VideoID: g.id.String(), OwnerID: g.owner.String(), RawBucket: g.rawBucket, RawKey: g.rawKey,
			MediaBucket: mediaBucket, MediaPrefix: "v/" + g.id.String() + "/",
		}); err != nil {
			return nil, err
		}
		ids = append(ids, g.id)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return ids, nil
}
