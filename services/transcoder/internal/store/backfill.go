package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/backfill"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

var _ backfill.Store = (*Postgres)(nil)

// SelectBackfill returns up to limit READY videos without a storyboard, newest first
// (created_at DESC, id DESC), strictly after the cursor. A zero cursor starts at the newest video.
// Each video carries its renditions with their playlist keys.
func (p *Postgres) SelectBackfill(ctx context.Context, after backfill.Cursor, limit int) ([]backfill.Candidate, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, created_at, hls_master_key, duration_ms
		FROM media.videos
		WHERE status = 'READY' AND storyboard_key IS NULL
		  AND ($1::timestamptz IS NULL OR (created_at, id) < ($1, $2))
		ORDER BY created_at DESC, id DESC
		LIMIT $3`, nullTime(after.CreatedAt), after.ID, limit)
	if err != nil {
		return nil, fmt.Errorf("select videos: %w", err)
	}
	defer rows.Close()
	var out []backfill.Candidate
	byID := map[uuid.UUID]int{}
	var ids []uuid.UUID
	for rows.Next() {
		var c backfill.Candidate
		var master *string
		var dur *int
		if err := rows.Scan(&c.ID, &c.CreatedAt, &master, &dur); err != nil {
			return nil, err
		}
		if master != nil {
			c.MasterKey = *master
		}
		if dur != nil {
			c.DurationMs = *dur
		}
		byID[c.ID] = len(out)
		ids = append(ids, c.ID)
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	rr, err := p.Pool.Query(ctx, `
		SELECT video_id, name, width, height, bitrate_kbps, playlist_key
		FROM media.video_renditions WHERE video_id = ANY($1) ORDER BY video_id, height DESC`, ids)
	if err != nil {
		return nil, fmt.Errorf("select renditions: %w", err)
	}
	defer rr.Close()
	for rr.Next() {
		var id uuid.UUID
		var r media.Rendition
		var key string
		if err := rr.Scan(&id, &r.Name, &r.Width, &r.Height, &r.TargetK, &key); err != nil {
			return nil, err
		}
		c := &out[byID[id]]
		c.Renditions = append(c.Renditions, r)
		if c.PlaylistKeys == nil {
			c.PlaylistKeys = map[string]string{}
		}
		c.PlaylistKeys[r.Name] = key
	}
	return out, rr.Err()
}

// SetStoryboardKey stores the key of storyboard.vtt, only while the video is still READY and has
// none. ok is false when no row changed (the video is gone, not READY any more, or already has one).
func (p *Postgres) SetStoryboardKey(ctx context.Context, id uuid.UUID, key string) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE media.videos SET storyboard_key = $2
		WHERE id = $1 AND status = 'READY' AND storyboard_key IS NULL`, id, key)
	if err != nil {
		return false, fmt.Errorf("set storyboard key: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func nullTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}
