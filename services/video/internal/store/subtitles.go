package store

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// loadSubtitles reads the tracks of a READY video with ONE query (playback is only sent for READY
// videos; a track can exist earlier, but nothing shows it before). The slice is never nil.
func (p *Postgres) loadSubtitles(ctx context.Context, v *domain.Video) error {
	v.Subtitles = []domain.Subtitle{}
	if v.Status != domain.StatusReady {
		return nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT lang, label, kind, source, is_default, object_key, size_bytes, updated_at
		FROM media.video_subtitles WHERE video_id = $1`, v.ID)
	if err != nil {
		return fmt.Errorf("load subtitles: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var s domain.Subtitle
		if err := rows.Scan(&s.Lang, &s.Label, &s.Kind, &s.Source, &s.IsDefault, &s.ObjectKey, &s.SizeBytes, &s.UpdatedAt); err != nil {
			return err
		}
		v.Subtitles = append(v.Subtitles, s)
	}
	// Sorted in Go, bytewise: independent of the database collation ("en" < "en-US" < "vi").
	sort.Slice(v.Subtitles, func(i, j int) bool { return v.Subtitles[i].Lang < v.Subtitles[j].Lang })
	return rows.Err()
}

// PutSubtitle upserts one track. The row of the VIDEO is locked for the whole transaction, so two
// uploads of the same video cannot both see 19 tracks and both add the 20th and 21st, and a delete
// of the video cannot slip in between the check and the insert.
func (p *Postgres) PutSubtitle(ctx context.Context, w domain.SubtitleWrite) (domain.SubtitleResult, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return domain.SubtitleResult{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var status string
	err = tx.QueryRow(ctx, `SELECT status::text FROM media.videos WHERE id = $1 FOR UPDATE`, w.VideoID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.SubtitleResult{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.SubtitleResult{}, fmt.Errorf("put subtitle: lock: %w", err)
	}
	if status == domain.StatusFailed {
		return domain.SubtitleResult{}, domain.ErrVideoFailed
	}

	var previous *string
	err = tx.QueryRow(ctx, `SELECT object_key FROM media.video_subtitles WHERE video_id = $1 AND lang = $2`, w.VideoID, w.Lang).Scan(&previous)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return domain.SubtitleResult{}, fmt.Errorf("put subtitle: existing: %w", err)
	}
	if previous == nil { // a new language: at most MaxSubtitles
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM media.video_subtitles WHERE video_id = $1`, w.VideoID).Scan(&n); err != nil {
			return domain.SubtitleResult{}, fmt.Errorf("put subtitle: count: %w", err)
		}
		if n >= domain.MaxSubtitles {
			return domain.SubtitleResult{}, domain.ErrTooManySubtitles
		}
	}

	if err := clearOtherDefaults(ctx, tx, w.VideoID, w.Lang, w.Default); err != nil {
		return domain.SubtitleResult{}, err
	}
	var res domain.SubtitleResult
	// $7 NULL: a new track is not the default, a replaced one keeps its flag.
	err = tx.QueryRow(ctx, `
		INSERT INTO media.video_subtitles (video_id, lang, label, kind, source, object_key, size_bytes, is_default)
		VALUES ($1, $2, $3, $4, 'UPLOAD', $5, $6, coalesce($7::boolean, false))
		ON CONFLICT (video_id, lang) DO UPDATE SET
			label = EXCLUDED.label, kind = EXCLUDED.kind, source = 'UPLOAD', object_key = EXCLUDED.object_key,
			size_bytes = EXCLUDED.size_bytes, is_default = coalesce($7::boolean, media.video_subtitles.is_default),
			updated_at = now()
		RETURNING (xmax = 0), `+subtitleCols,
		w.VideoID, w.Lang, w.Label, w.Kind, w.ObjectKey, w.SizeBytes, w.Default).
		Scan(&res.Created, &res.Track.Lang, &res.Track.Label, &res.Track.Kind, &res.Track.Source, &res.Track.IsDefault, &res.Track.ObjectKey, &res.Track.SizeBytes, &res.Track.UpdatedAt)
	if err != nil {
		var pe *pgconn.PgError
		if errors.As(err, &pe) && pe.Code == "23503" { // the video was deleted (foreign key)
			return domain.SubtitleResult{}, domain.ErrNotFound
		}
		return domain.SubtitleResult{}, fmt.Errorf("put subtitle: upsert: %w", err)
	}
	if !res.Created && previous != nil {
		res.PreviousKey = *previous
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.SubtitleResult{}, fmt.Errorf("commit: %w", err)
	}
	return res, nil
}

// subtitleCols are the columns scanned into a domain.Subtitle, in its field order.
const subtitleCols = `lang, label, kind, source, is_default, object_key, size_bytes, updated_at`

// clearOtherDefaults unsets the default of the video's other tracks when def is true, so the partial unique
// index video_subtitles_one_default never fires. The caller holds the video row lock.
func clearOtherDefaults(ctx context.Context, tx pgx.Tx, videoID uuid.UUID, lang string, def *bool) error {
	if def == nil || !*def {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE media.video_subtitles SET is_default = false, updated_at = now()
		WHERE video_id = $1 AND is_default AND lang <> $2`, videoID, lang); err != nil {
		return fmt.Errorf("clear default subtitle: %w", err)
	}
	return nil
}

// UpdateSubtitle changes the label and/or the default flag of a track under the video row lock (the same
// lock PutSubtitle takes, so two calls cannot both leave a default).
func (p *Postgres) UpdateSubtitle(ctx context.Context, videoID uuid.UUID, lang string, u domain.SubtitleUpdate) (domain.Subtitle, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return domain.Subtitle{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var one int
	err = tx.QueryRow(ctx, `SELECT 1 FROM media.videos WHERE id = $1 FOR UPDATE`, videoID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Subtitle{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Subtitle{}, fmt.Errorf("update subtitle: lock: %w", err)
	}
	if err := clearOtherDefaults(ctx, tx, videoID, lang, u.Default); err != nil {
		return domain.Subtitle{}, err
	}
	var s domain.Subtitle
	err = tx.QueryRow(ctx, `
		UPDATE media.video_subtitles
		SET label = coalesce($3, label), is_default = coalesce($4::boolean, is_default), updated_at = now()
		WHERE video_id = $1 AND lang = $2
		RETURNING `+subtitleCols, videoID, lang, u.Label, u.Default).
		Scan(&s.Lang, &s.Label, &s.Kind, &s.Source, &s.IsDefault, &s.ObjectKey, &s.SizeBytes, &s.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Subtitle{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Subtitle{}, fmt.Errorf("update subtitle: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Subtitle{}, fmt.Errorf("commit: %w", err)
	}
	return s, nil
}

func (p *Postgres) DeleteSubtitle(ctx context.Context, videoID uuid.UUID, lang string) (string, error) {
	var key string
	err := p.Pool.QueryRow(ctx, `DELETE FROM media.video_subtitles WHERE video_id = $1 AND lang = $2 RETURNING object_key`, videoID, lang).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("delete subtitle: %w", err)
	}
	return key, nil
}
