package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/transcoder/internal/audio"
)

// Extra audio tracks (task MUX1, ADR-042). Every write here takes the video row lock first (SELECT ... FOR
// UPDATE), the same lock video-svc takes when it renames, re-defaults or deletes a track, so master
// rewrites from both services never interleave.

var _ audio.Store = (*Postgres)(nil)

func (p *Postgres) BeginAudio(ctx context.Context, trackID uuid.UUID) (audio.Outcome, audio.Track, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return 0, audio.Track{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var t audio.Track
	var status string
	err = tx.QueryRow(ctx, `SELECT video_id, status FROM media.video_audio_tracks WHERE id = $1`, trackID).Scan(&t.VideoID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return audio.Skip, audio.Track{}, nil
	}
	if err != nil {
		return 0, audio.Track{}, fmt.Errorf("get audio track: %w", err)
	}
	var videoStatus string
	var dur *int
	err = tx.QueryRow(ctx, `SELECT owner_id, status::text, duration_ms FROM media.videos WHERE id = $1 FOR UPDATE`, t.VideoID).
		Scan(&t.OwnerID, &videoStatus, &dur)
	if errors.Is(err, pgx.ErrNoRows) {
		return audio.Skip, audio.Track{}, nil
	}
	if err != nil {
		return 0, audio.Track{}, fmt.Errorf("lock video: %w", err)
	}
	// Read the track again under the lock: video-svc may have deleted it in the meantime.
	err = tx.QueryRow(ctx, `
		SELECT id, lang, kind, status, raw_bucket, raw_key FROM media.video_audio_tracks WHERE id = $1`, trackID).
		Scan(&t.ID, &t.Lang, &t.Kind, &status, &t.RawBucket, &t.RawKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return audio.Skip, audio.Track{}, nil
	}
	if err != nil {
		return 0, audio.Track{}, fmt.Errorf("get audio track: %w", err)
	}
	switch {
	case status != "UPLOADED" && status != "PROCESSING":
		return audio.Skip, t, nil // UPLOADING (not complete), READY or FAILED
	case videoStatus == "FAILED":
		return audio.VideoFailed, t, nil
	case videoStatus != "READY" || dur == nil:
		return audio.Wait, t, nil
	}
	t.VideoDurationMs = *dur
	if _, err := tx.Exec(ctx, `
		UPDATE media.video_audio_tracks SET status = 'PROCESSING', error = NULL, updated_at = now() WHERE id = $1`, trackID); err != nil {
		return 0, audio.Track{}, fmt.Errorf("mark processing: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, audio.Track{}, fmt.Errorf("commit: %w", err)
	}
	return audio.Run, t, nil
}

type audioReadyEvent struct {
	VideoID      string `json:"video_id"`
	OwnerID      string `json:"owner_id"`
	TrackID      string `json:"track_id"`
	Lang         string `json:"lang"`
	Kind         string `json:"kind"`
	HLSMasterKey string `json:"hls_master_key"`
	DurationMs   int    `json:"duration_ms"`
}

type audioFailedEvent struct {
	VideoID   string `json:"video_id"`
	OwnerID   string `json:"owner_id"`
	TrackID   string `json:"track_id"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (p *Postgres) CompleteAudio(ctx context.Context, trackID uuid.UUID, playlistKey string, durationMs int, rewrite audio.Rewrite) (bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var videoID, ownerID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT video_id FROM media.video_audio_tracks WHERE id = $1`, trackID).Scan(&videoID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get audio track: %w", err)
	}
	var videoStatus string
	var master *string
	err = tx.QueryRow(ctx, `SELECT owner_id, status::text, hls_master_key FROM media.videos WHERE id = $1 FOR UPDATE`, videoID).
		Scan(&ownerID, &videoStatus, &master)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("lock video: %w", err)
	}
	var lang, kind string
	err = tx.QueryRow(ctx, `
		UPDATE media.video_audio_tracks
		SET status = 'READY', playlist_key = $2, duration_ms = $3, error = NULL, updated_at = now()
		WHERE id = $1 AND status = 'PROCESSING'
		RETURNING lang, kind`, trackID, playlistKey, durationMs).Scan(&lang, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // deleted (or failed) meanwhile
	}
	if err != nil {
		return false, fmt.Errorf("mark ready: %w", err)
	}
	key := ""
	if master != nil {
		key = *master
	}
	if videoStatus == "READY" && key != "" {
		ready, err := readyTracks(ctx, tx, videoID)
		if err != nil {
			return false, err
		}
		if key, err = rewrite(ctx, key, ready); err != nil {
			return false, fmt.Errorf("rewrite master: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE media.videos SET hls_master_key = $2 WHERE id = $1`, videoID, key); err != nil {
			return false, fmt.Errorf("store master key: %w", err)
		}
	}
	if err := outbox.Enqueue(ctx, tx, "media", "video.audio_ready", audioReadyEvent{
		VideoID: videoID.String(), OwnerID: ownerID.String(), TrackID: trackID.String(),
		Lang: lang, Kind: kind, HLSMasterKey: key, DurationMs: durationMs,
	}); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

func (p *Postgres) FailAudio(ctx context.Context, trackID uuid.UUID, f audio.Failure) (bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var videoID, ownerID uuid.UUID
	err = tx.QueryRow(ctx, `
		UPDATE media.video_audio_tracks t SET status = 'FAILED', error = $2, s3_upload_id = NULL, updated_at = now()
		FROM media.videos v
		WHERE t.id = $1 AND v.id = t.video_id AND t.status IN ('UPLOADED', 'PROCESSING')
		RETURNING t.video_id, v.owner_id`, trackID, f.Reason).Scan(&videoID, &ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("fail audio track: %w", err)
	}
	if err := outbox.Enqueue(ctx, tx, "media", "video.audio_failed", audioFailedEvent{
		VideoID: videoID.String(), OwnerID: ownerID.String(), TrackID: trackID.String(),
		Reason: f.Reason, Message: f.Message, Retryable: f.Retryable,
	}); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

// readyTracks reads the READY tracks of a video in master order (lang, then kind; bytewise).
func readyTracks(ctx context.Context, tx pgx.Tx, videoID uuid.UUID) ([]hlsmaster.Track, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, lang, label, kind, is_default, playlist_key FROM media.video_audio_tracks
		WHERE video_id = $1 AND status = 'READY' ORDER BY lang COLLATE "C", kind`, videoID)
	if err != nil {
		return nil, fmt.Errorf("ready audio tracks: %w", err)
	}
	defer rows.Close()
	var out []hlsmaster.Track
	for rows.Next() {
		var t hlsmaster.Track
		var id uuid.UUID
		if err := rows.Scan(&id, &t.Lang, &t.Label, &t.Kind, &t.Default, &t.PlaylistKey); err != nil {
			return nil, err
		}
		t.ID = id.String()
		out = append(out, t)
	}
	return out, rows.Err()
}
