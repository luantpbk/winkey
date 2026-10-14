package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Extra audio tracks (task MUX1, ADR-042). Rows are created by upload-svc and moved to READY by the
// transcoder; video-svc lists, renames, re-defaults and deletes them.

const audioCols = `id, lang, label, kind, is_default, status, coalesce(error, ''), coalesce(playlist_key, ''), updated_at`

// audioOrder is bytewise (COLLATE "C"), like the subtitles: independent of the database collation.
const audioOrder = ` ORDER BY lang COLLATE "C", kind`

func scanAudio(row pgx.Row) (domain.AudioTrack, error) {
	var t domain.AudioTrack
	err := row.Scan(&t.ID, &t.Lang, &t.Label, &t.Kind, &t.IsDefault, &t.Status, &t.Error, &t.PlaylistKey, &t.UpdatedAt)
	return t, err
}

func collectAudio(rows pgx.Rows) ([]domain.AudioTrack, error) {
	defer rows.Close()
	out := []domain.AudioTrack{}
	for rows.Next() {
		t, err := scanAudio(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// loadAudioTracks reads the READY tracks of a READY video with ONE query. The slice is never nil.
func (p *Postgres) loadAudioTracks(ctx context.Context, v *domain.Video) error {
	v.AudioTracks = []domain.AudioTrack{}
	if v.Status != domain.StatusReady {
		return nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT `+audioCols+` FROM media.video_audio_tracks
		WHERE video_id = $1 AND status = 'READY'`+audioOrder, v.ID)
	if err != nil {
		return fmt.Errorf("load audio tracks: %w", err)
	}
	ts, err := collectAudio(rows)
	if err != nil {
		return fmt.Errorf("load audio tracks: %w", err)
	}
	v.AudioTracks = ts
	return nil
}

func (p *Postgres) ListAudioTracks(ctx context.Context, videoID uuid.UUID) ([]domain.AudioTrack, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+audioCols+` FROM media.video_audio_tracks WHERE video_id = $1`+audioOrder, videoID)
	if err != nil {
		return nil, fmt.Errorf("list audio tracks: %w", err)
	}
	ts, err := collectAudio(rows)
	if err != nil {
		return nil, fmt.Errorf("list audio tracks: %w", err)
	}
	return ts, nil
}

func (p *Postgres) UpdateAudioTrack(ctx context.Context, videoID, trackID uuid.UUID, u domain.AudioTrackUpdate,
	rewrite domain.MasterRewrite) (domain.AudioTrack, error) {
	return p.changeAudio(ctx, videoID, trackID, rewrite, func(tx pgx.Tx, cur domain.AudioTrack) (domain.AudioTrack, error) {
		if u.MakeDefault {
			if _, err := tx.Exec(ctx, `
				UPDATE media.video_audio_tracks SET is_default = false, updated_at = now()
				WHERE video_id = $1 AND is_default AND id <> $2`, videoID, trackID); err != nil {
				return domain.AudioTrack{}, fmt.Errorf("clear default: %w", err)
			}
		}
		t, err := scanAudio(tx.QueryRow(ctx, `
			UPDATE media.video_audio_tracks
			SET label = coalesce($3, label), is_default = is_default OR $4, updated_at = now()
			WHERE id = $1 AND video_id = $2
			RETURNING `+audioCols, trackID, videoID, u.Label, u.MakeDefault))
		if err != nil {
			return domain.AudioTrack{}, fmt.Errorf("update audio track: %w", err)
		}
		return t, nil
	})
}

func (p *Postgres) DeleteAudioTrack(ctx context.Context, videoID, trackID uuid.UUID, rewrite domain.MasterRewrite) (domain.AudioTrack, error) {
	return p.changeAudio(ctx, videoID, trackID, rewrite, func(tx pgx.Tx, cur domain.AudioTrack) (domain.AudioTrack, error) {
		if cur.Status == domain.StatusUploading {
			return domain.AudioTrack{}, domain.ErrAudioTrackUploading
		}
		if _, err := tx.Exec(ctx, `DELETE FROM media.video_audio_tracks WHERE id = $1`, trackID); err != nil {
			return domain.AudioTrack{}, fmt.Errorf("delete audio track: %w", err)
		}
		return cur, nil
	})
}

// changeAudio runs change on the track inside ONE transaction that holds the video row lock (FOR UPDATE, the
// same lock the transcoder takes when a track becomes READY), then rewrites the master when the video has one
// and READY tracks before or after the change: a renamed, re-defaulted or deleted READY track changes the
// audio group, and so can a default moved away from a READY track.
func (p *Postgres) changeAudio(ctx context.Context, videoID, trackID uuid.UUID, rewrite domain.MasterRewrite,
	change func(pgx.Tx, domain.AudioTrack) (domain.AudioTrack, error)) (domain.AudioTrack, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return domain.AudioTrack{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var master *string
	err = tx.QueryRow(ctx, `SELECT hls_master_key FROM media.videos WHERE id = $1 FOR UPDATE`, videoID).Scan(&master)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.AudioTrack{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.AudioTrack{}, fmt.Errorf("lock video: %w", err)
	}
	cur, err := scanAudio(tx.QueryRow(ctx, `SELECT `+audioCols+` FROM media.video_audio_tracks WHERE id = $1 AND video_id = $2`, trackID, videoID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.AudioTrack{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.AudioTrack{}, fmt.Errorf("get audio track: %w", err)
	}
	readyBefore, err := p.readyTracks(ctx, tx, videoID)
	if err != nil {
		return domain.AudioTrack{}, err
	}
	res, err := change(tx, cur)
	if err != nil {
		return domain.AudioTrack{}, err
	}
	readyAfter, err := p.readyTracks(ctx, tx, videoID)
	if err != nil {
		return domain.AudioTrack{}, err
	}
	if master != nil && *master != "" && (len(readyBefore) > 0 || len(readyAfter) > 0) {
		newKey, err := rewrite(ctx, videoID, *master, readyAfter)
		if err != nil {
			return domain.AudioTrack{}, fmt.Errorf("rewrite master: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE media.videos SET hls_master_key = $2 WHERE id = $1`, videoID, newKey); err != nil {
			return domain.AudioTrack{}, fmt.Errorf("store master key: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.AudioTrack{}, fmt.Errorf("commit: %w", err)
	}
	return res, nil
}

func (p *Postgres) readyTracks(ctx context.Context, tx pgx.Tx, videoID uuid.UUID) ([]domain.AudioTrack, error) {
	rows, err := tx.Query(ctx, `SELECT `+audioCols+` FROM media.video_audio_tracks WHERE video_id = $1 AND status = 'READY'`+audioOrder, videoID)
	if err != nil {
		return nil, fmt.Errorf("ready audio tracks: %w", err)
	}
	ts, err := collectAudio(rows)
	if err != nil {
		return nil, fmt.Errorf("ready audio tracks: %w", err)
	}
	return ts, nil
}
