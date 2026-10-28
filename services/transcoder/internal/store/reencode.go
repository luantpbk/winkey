package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// Re-encoding READY videos into the current HLS layout (ADR-042 addendum 2026-10-17, cmd/reencode).

// ReencodeCandidate is a READY video and the key of its current master.
type ReencodeCandidate struct {
	ID        uuid.UUID
	MasterKey string
}

// SelectReencode returns the READY videos, oldest first. ids, when not empty, restricts the selection.
func (p *Postgres) SelectReencode(ctx context.Context, ids []uuid.UUID) ([]ReencodeCandidate, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, hls_master_key FROM media.videos
		WHERE status = 'READY' AND purpose = 'FILM' AND hls_master_key IS NOT NULL AND (coalesce(cardinality($1::uuid[]), 0) = 0 OR id = ANY($1))
		ORDER BY created_at, id`, ids)
	if err != nil {
		return nil, fmt.Errorf("select videos: %w", err)
	}
	defer rows.Close()
	var out []ReencodeCandidate
	for rows.Next() {
		var c ReencodeCandidate
		if err := rows.Scan(&c.ID, &c.MasterKey); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// BeginReencode puts a READY video back to PROCESSING so the normal pipeline encodes it again from its raw
// source (BeginJob accepts PROCESSING), and drops its AV1 set (the codec='av1' rows and hls_av1_master_key):
// that set has the old layout, av1-upgrade selects the video again once it is READY. The event is what
// upload-svc published for the video. av1Prefix is the directory of the dropped AV1 set ("" when none), for
// the caller to delete once the re-encode succeeded. ok is false when the video is gone or not READY.
func (p *Postgres) BeginReencode(ctx context.Context, id uuid.UUID) (ev job.UploadedEvent, av1Prefix string, ok bool, err error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return ev, "", false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var owner uuid.UUID
	var status string
	var av1 *string
	err = tx.QueryRow(ctx, `
		SELECT owner_id, status::text, raw_bucket, raw_key, size_bytes, content_type, hls_av1_master_key
		FROM media.videos WHERE id = $1 FOR UPDATE`, id).
		Scan(&owner, &status, &ev.RawBucket, &ev.RawKey, &ev.SizeBytes, &ev.ContentType, &av1)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && status != "READY") {
		return job.UploadedEvent{}, "", false, nil
	}
	if err != nil {
		return job.UploadedEvent{}, "", false, fmt.Errorf("lock video: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE media.videos SET status = 'PROCESSING', hls_av1_master_key = NULL WHERE id = $1`, id); err != nil {
		return job.UploadedEvent{}, "", false, fmt.Errorf("mark processing: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM media.video_renditions WHERE video_id = $1 AND codec = 'av1'`, id); err != nil {
		return job.UploadedEvent{}, "", false, fmt.Errorf("drop av1 renditions: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return job.UploadedEvent{}, "", false, fmt.Errorf("commit: %w", err)
	}
	ev.VideoID, ev.OwnerID = id.String(), owner.String()
	if av1 != nil {
		av1Prefix = "v/" + id.String() + "/av1/"
	}
	return ev, av1Prefix, true, nil
}
