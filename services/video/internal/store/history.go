package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Watch history (task HIST1, ADR-044): media.watch_history, written on view reports that pass the threshold.

func (p *Postgres) RecordWatch(ctx context.Context, user, video uuid.UUID, watchedMs int64) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO media.watch_history (user_id, video_id, watched_at, watched_ms) VALUES ($1, $2, now(), $3)
		ON CONFLICT (user_id, video_id) DO UPDATE SET watched_at = now(), watched_ms = EXCLUDED.watched_ms`,
		user, video, watchedMs); err != nil {
		var pe *pgconn.PgError
		if errors.As(err, &pe) && pe.Code == "23503" { // the video was deleted (foreign key)
			return nil
		}
		return fmt.Errorf("record watch: %w", err)
	}
	// Keep the newest MaxHistory rows: everything older than the MaxHistory-th goes (none when there are fewer).
	if _, err := tx.Exec(ctx, `
		DELETE FROM media.watch_history
		WHERE user_id = $1 AND (watched_at, video_id) < (
			SELECT watched_at, video_id FROM media.watch_history WHERE user_id = $1
			ORDER BY watched_at DESC, video_id DESC OFFSET $2 - 1 LIMIT 1)`, user, domain.MaxHistory); err != nil {
		return fmt.Errorf("prune history: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func (p *Postgres) ListHistory(ctx context.Context, q domain.HistoryQuery) ([]domain.HistoryEntry, error) {
	args := []any{q.User, q.Limit}
	cursor := ""
	if q.After != nil {
		cursor = " AND (h.watched_at, h.video_id) < ($3, $4)"
		args = append(args, q.After.T, q.After.ID)
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT v.id, v.title, v.duration_ms, v.view_count, coalesce(v.published_at, v.created_at), v.thumbnail_key,
		       p.id, p.handle, p.display_name, p.avatar_key, h.watched_at, h.watched_ms
		FROM media.watch_history h
		JOIN media.videos v ON v.id = h.video_id
		JOIN auth.public_profiles p ON p.id = v.owner_id
		WHERE h.user_id = $1
		  AND v.status = 'READY' AND v.visibility IN ('PUBLIC', 'UNLISTED') AND v.moderation_state <> 'HIDDEN'`+cursor+`
		ORDER BY h.watched_at DESC, h.video_id DESC
		LIMIT $2`, args...)
	if err != nil {
		return nil, fmt.Errorf("list history: %w", err)
	}
	defer rows.Close()
	var out []domain.HistoryEntry
	for rows.Next() {
		var e domain.HistoryEntry
		s := &e.Video
		if err := rows.Scan(&s.ID, &s.Title, &s.DurationMs, &s.ViewCount, &s.PublishedAt, &s.ThumbnailKey,
			&s.Owner.ID, &s.Owner.Handle, &s.Owner.DisplayName, &s.Owner.AvatarKey, &e.WatchedAt, &e.WatchedMs); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (p *Postgres) RemoveFromHistory(ctx context.Context, user, video uuid.UUID) error {
	if _, err := p.Pool.Exec(ctx, `DELETE FROM media.watch_history WHERE user_id = $1 AND video_id = $2`, user, video); err != nil {
		return fmt.Errorf("remove from history: %w", err)
	}
	return nil
}

func (p *Postgres) ClearHistory(ctx context.Context, user uuid.UUID) error {
	if _, err := p.Pool.Exec(ctx, `DELETE FROM media.watch_history WHERE user_id = $1`, user); err != nil {
		return fmt.Errorf("clear history: %w", err)
	}
	return nil
}
