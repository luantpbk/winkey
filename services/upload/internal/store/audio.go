package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

var _ domain.AudioStore = (*Postgres)(nil)

const audioCols = `t.id, t.video_id, v.owner_id, t.lang, t.label, t.kind, t.is_default, t.status,
	t.raw_bucket, t.raw_key, coalesce(t.s3_upload_id, ''), t.content_type, t.size_bytes,
	coalesce(t.error, ''), t.updated_at`

const audioFrom = ` FROM media.video_audio_tracks t JOIN media.videos v ON v.id = t.video_id`

func scanAudio(row pgx.Row) (domain.AudioTrack, error) {
	var t domain.AudioTrack
	err := row.Scan(&t.ID, &t.VideoID, &t.OwnerID, &t.Lang, &t.Label, &t.Kind, &t.IsDefault, &t.Status,
		&t.RawBucket, &t.RawKey, &t.S3UploadID, &t.ContentType, &t.SizeBytes, &t.Error, &t.UpdatedAt)
	return t, err
}

func (p *Postgres) CreateAudioTrack(ctx context.Context, t domain.AudioTrack, check func(domain.Usage) error,
	startUpload func(context.Context) (string, error)) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	// Owner lock first (quota), then the video lock: always in this order.
	if err := checkQuota(ctx, tx, t.OwnerID, check); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('audio-tracks:' || $1::text, 0))`, t.VideoID.String()); err != nil {
		return fmt.Errorf("video lock: %w", err)
	}
	var total int
	var dup bool
	if err := tx.QueryRow(ctx, `
		SELECT count(*), coalesce(bool_or(lang = $2 AND kind = $3), false)
		FROM media.video_audio_tracks WHERE video_id = $1`, t.VideoID, t.Lang, t.Kind).Scan(&total, &dup); err != nil {
		return fmt.Errorf("count audio tracks: %w", err)
	}
	switch {
	case dup:
		return domain.ErrAudioTrackExists
	case total >= domain.MaxAudioTracks:
		return domain.ErrTooManyAudioTracks
	}
	if t.IsDefault {
		if _, err := tx.Exec(ctx, `
			UPDATE media.video_audio_tracks SET is_default = false, updated_at = now()
			WHERE video_id = $1 AND is_default`, t.VideoID); err != nil {
			return fmt.Errorf("clear default: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO media.video_audio_tracks
			(id, video_id, lang, label, kind, is_default, status, raw_bucket, raw_key, content_type, size_bytes)
		VALUES ($1, $2, $3, $4, $5, $6, 'UPLOADING', $7, $8, $9, $10)`,
		t.ID, t.VideoID, t.Lang, t.Label, t.Kind, t.IsDefault, t.RawBucket, t.RawKey, t.ContentType, t.SizeBytes); err != nil {
		var pe *pgconn.PgError
		if errors.As(err, &pe) && pe.Code == "23505" && pe.ConstraintName == "video_audio_tracks_lang_kind" {
			return domain.ErrAudioTrackExists
		}
		if errors.As(err, &pe) && pe.Code == "23503" { // the video was deleted meanwhile
			return domain.ErrNotFound
		}
		return fmt.Errorf("insert audio track: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes) VALUES ($1, $2, $3)`,
		t.ID, t.OwnerID, t.SizeBytes); err != nil {
		return fmt.Errorf("insert ledger: %w", err)
	}
	uploadID, err := startUpload(ctx)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE media.video_audio_tracks SET s3_upload_id = $2 WHERE id = $1`, t.ID, uploadID); err != nil {
		return fmt.Errorf("store upload id: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func (p *Postgres) GetAudioTrack(ctx context.Context, videoID, trackID uuid.UUID) (domain.AudioTrack, error) {
	t, err := scanAudio(p.Pool.QueryRow(ctx, `SELECT `+audioCols+audioFrom+` WHERE t.id = $1 AND t.video_id = $2`, trackID, videoID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.AudioTrack{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.AudioTrack{}, fmt.Errorf("get audio track: %w", err)
	}
	return t, nil
}

func (p *Postgres) MarkAudioUploaded(ctx context.Context, t domain.AudioTrack) (bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	tag, err := tx.Exec(ctx, `
		UPDATE media.video_audio_tracks SET status = 'UPLOADED', s3_upload_id = NULL, updated_at = now()
		WHERE id = $1 AND status = 'UPLOADING'`, t.ID)
	if err != nil {
		return false, fmt.Errorf("mark audio uploaded: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if err := outbox.Enqueue(ctx, tx, "media", "video.audio_uploaded", domain.AudioUploadedEvent{
		VideoID: t.VideoID.String(), OwnerID: t.OwnerID.String(), TrackID: t.ID.String(),
		Lang: t.Lang, Kind: t.Kind, RawBucket: t.RawBucket, RawKey: t.RawKey,
		SizeBytes: t.SizeBytes, ContentType: t.ContentType,
	}); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

func (p *Postgres) MarkAudioFailed(ctx context.Context, trackID uuid.UUID, code string) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE media.video_audio_tracks SET status = 'FAILED', s3_upload_id = NULL, error = $2, updated_at = now()
		WHERE id = $1 AND status = 'UPLOADING'`, trackID, code)
	if err != nil {
		return false, fmt.Errorf("mark audio failed: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (p *Postgres) DeleteUploadingAudio(ctx context.Context, trackID uuid.UUID) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `DELETE FROM media.video_audio_tracks WHERE id = $1 AND status = 'UPLOADING'`, trackID)
	if err != nil {
		return false, fmt.Errorf("delete audio track: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (p *Postgres) StaleAudioUploads(ctx context.Context, olderThan time.Duration, limit int) ([]domain.AudioTrack, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT `+audioCols+audioFrom+`
		WHERE t.status = 'UPLOADING' AND t.created_at < now() - make_interval(secs => $1)
		ORDER BY t.created_at LIMIT $2`, olderThan.Seconds(), limit)
	if err != nil {
		return nil, fmt.Errorf("stale audio uploads: %w", err)
	}
	defer rows.Close()
	var out []domain.AudioTrack
	for rows.Next() {
		t, err := scanAudio(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
