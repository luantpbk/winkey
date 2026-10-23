package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/services/transcoder/internal/av1up"
)

// The separate AV1 set (task ENC2 phase 2, ADR-041): media.videos.hls_av1_master_key and the codec='av1'
// rows of media.video_renditions. Written only by av1-upgrade (CommitAV1) and by master rewrites for audio
// tracks (MUX1), always under the video row lock.

var _ av1up.Store = (*Postgres)(nil)

// av1Window is the analytics window of the selection, in days of analytics.video_daily (Asia/Ho_Chi_Minh
// calendar days): today and the 6 days before.
const av1Window = 7

func (p *Postgres) SelectAV1(ctx context.Context, minStarts int64, limit int) ([]av1up.Candidate, error) {
	rows, err := p.Pool.Query(ctx, `
		WITH starts AS (
			SELECT video_id, sum(starts)::bigint AS starts
			FROM analytics.video_daily
			WHERE day > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - $3::int
			GROUP BY video_id
		)
		SELECT v.id, v.raw_bucket, v.raw_key, coalesce(s.starts, 0)
		FROM media.videos v LEFT JOIN starts s ON s.video_id = v.id
		WHERE v.status = 'READY' AND v.hls_av1_master_key IS NULL AND coalesce(s.starts, 0) >= $1
		ORDER BY coalesce(s.starts, 0) DESC, v.created_at DESC, v.id
		LIMIT $2`, minStarts, limit, av1Window)
	if err != nil {
		return nil, fmt.Errorf("select videos: %w", err)
	}
	defer rows.Close()
	var out []av1up.Candidate
	byID := map[uuid.UUID]int{}
	var ids []uuid.UUID
	for rows.Next() {
		var c av1up.Candidate
		if err := rows.Scan(&c.ID, &c.RawBucket, &c.RawKey, &c.Starts7d); err != nil {
			return nil, err
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
		SELECT video_id, name FROM media.video_renditions
		WHERE video_id = ANY($1) AND codec = 'h264' ORDER BY video_id, height DESC`, ids)
	if err != nil {
		return nil, fmt.Errorf("select renditions: %w", err)
	}
	defer rr.Close()
	for rr.Next() {
		var id uuid.UUID
		var name string
		if err := rr.Scan(&id, &name); err != nil {
			return nil, err
		}
		c := &out[byID[id]]
		c.H264Names = append(c.H264Names, name)
	}
	return out, rr.Err()
}

func (p *Postgres) CommitAV1(ctx context.Context, c av1up.Commit, rewrite func(ctx context.Context, masterKey string, ready []hlsmaster.Track) (string, error)) (string, bool, error) {
	if len(c.Renditions) == 0 || len(c.Renditions) != len(c.PlaylistKeys) {
		return "", false, fmt.Errorf("commit av1: %d renditions, %d playlists", len(c.Renditions), len(c.PlaylistKeys))
	}
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var status string
	var previous *string
	err = tx.QueryRow(ctx, `SELECT status::text, hls_av1_master_key FROM media.videos WHERE id = $1 FOR UPDATE`, c.VideoID).
		Scan(&status, &previous)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && status != "READY") {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("lock video: %w", err)
	}
	masterKey := c.MasterKey
	ready, err := readyTracks(ctx, tx, c.VideoID)
	if err != nil {
		return "", false, err
	}
	if len(ready) > 0 {
		if masterKey, err = rewrite(ctx, c.MasterKey, ready); err != nil {
			return "", false, fmt.Errorf("rewrite master: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM media.video_renditions WHERE video_id = $1 AND codec = 'av1'`, c.VideoID); err != nil {
		return "", false, fmt.Errorf("clear renditions: %w", err)
	}
	for i, rd := range c.Renditions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO media.video_renditions (video_id, codec, name, width, height, bitrate_kbps, playlist_key)
			VALUES ($1, 'av1', $2, $3, $4, $5, $6)`,
			c.VideoID, rd.Name, rd.Width, rd.Height, rd.TargetK, c.PlaylistKeys[i]); err != nil {
			return "", false, fmt.Errorf("insert rendition %s: %w", rd.Name, err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE media.videos SET hls_av1_master_key = $2 WHERE id = $1`, c.VideoID, masterKey); err != nil {
		return "", false, fmt.Errorf("store av1 master key: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, fmt.Errorf("commit: %w", err)
	}
	prev := ""
	if previous != nil {
		prev = *previous
	}
	return prev, true, nil
}

// RankAV1 implements av1up.PolicyStore: every READY video, most watched over the AV1 window first, then newest.
func (p *Postgres) RankAV1(ctx context.Context) ([]av1up.Rank, error) {
	rows, err := p.Pool.Query(ctx, `
		WITH starts AS (
			SELECT video_id, sum(starts)::bigint AS starts
			FROM analytics.video_daily
			WHERE day > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - $1::int
			GROUP BY video_id
		)
		SELECT v.id, coalesce(s.starts, 0), v.hls_av1_master_key IS NOT NULL
		FROM media.videos v LEFT JOIN starts s ON s.video_id = v.id
		WHERE v.status = 'READY'
		ORDER BY coalesce(s.starts, 0) DESC, v.created_at DESC, v.id`, av1Window)
	if err != nil {
		return nil, fmt.Errorf("rank videos: %w", err)
	}
	defer rows.Close()
	var out []av1up.Rank
	for rows.Next() {
		var r av1up.Rank
		if err := rows.Scan(&r.ID, &r.Starts7d, &r.HasAV1); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DropAV1 implements av1up.PolicyStore. The objects stay; the next av1-upgrade run deletes them.
func (p *Postgres) DropAV1(ctx context.Context, id uuid.UUID) (bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	var key *string
	if err := tx.QueryRow(ctx, `SELECT hls_av1_master_key FROM media.videos WHERE id = $1 FOR UPDATE`, id).Scan(&key); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("lock video: %w", err)
	}
	if key == nil {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `DELETE FROM media.video_renditions WHERE video_id = $1 AND codec = 'av1'`, id); err != nil {
		return false, fmt.Errorf("clear renditions: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE media.videos SET hls_av1_master_key = NULL WHERE id = $1`, id); err != nil {
		return false, fmt.Errorf("clear av1 master key: %w", err)
	}
	return true, tx.Commit(ctx)
}
