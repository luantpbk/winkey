// Package store implements domain.Store on PostgreSQL (schemas media and, read
// only through the auth.public_profiles view, auth).
package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Postgres implements domain.Store.
type Postgres struct{ Pool *pgxpool.Pool }

var _ domain.Store = (*Postgres)(nil)

// videoCols joins the owner profile (LEFT: a suspended/deleted owner has no
// row in the view) and reads everything GetVideo/UpdateVideo return.
const videoSelect = `
	SELECT v.id, v.owner_id, v.title, v.description, v.visibility::text, v.status::text,
	       v.duration_ms, v.width, v.height, v.view_count, v.like_count, v.published_at, v.created_at,
	       v.hls_master_key, v.thumbnail_key, v.storyboard_key,
	       p.id IS NOT NULL, coalesce(p.handle, ''), coalesce(p.display_name, ''), p.avatar_key,
	       v.moderation_state::text, v.moderation_reason, v.moderated_by, v.moderated_at
	FROM media.videos v
	LEFT JOIN auth.public_profiles p ON p.id = v.owner_id`

func scanVideo(row pgx.Row) (domain.Video, error) {
	var v domain.Video
	var ownerActive bool
	err := row.Scan(&v.ID, &v.OwnerID, &v.Title, &v.Description, &v.Visibility, &v.Status,
		&v.DurationMs, &v.Width, &v.Height, &v.ViewCount, &v.LikeCount, &v.PublishedAt, &v.CreatedAt,
		&v.HLSMasterKey, &v.ThumbnailKey, &v.StoryboardKey,
		&ownerActive, &v.Owner.Handle, &v.Owner.DisplayName, &v.Owner.AvatarKey,
		&v.ModerationState, &v.ModerationReason, &v.ModeratedBy, &v.ModeratedAt)
	v.Owner.ID = v.OwnerID
	v.Owner.Missing = !ownerActive
	return v, err
}

func (p *Postgres) GetVideo(ctx context.Context, id uuid.UUID) (domain.Video, error) {
	v, err := scanVideo(p.Pool.QueryRow(ctx, videoSelect+` WHERE v.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Video{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Video{}, fmt.Errorf("get video: %w", err)
	}
	if err := p.loadRenditions(ctx, &v); err != nil {
		return domain.Video{}, err
	}
	return v, nil
}

func (p *Postgres) loadRenditions(ctx context.Context, v *domain.Video) error {
	v.Renditions = []domain.Rendition{}
	if v.Status != domain.StatusReady {
		return nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT name, width, height, bitrate_kbps FROM media.video_renditions
		WHERE video_id = $1 ORDER BY height DESC, width DESC, name`, v.ID)
	if err != nil {
		return fmt.Errorf("load renditions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var r domain.Rendition
		if err := rows.Scan(&r.Name, &r.Width, &r.Height, &r.BitrateKbps); err != nil {
			return err
		}
		v.Renditions = append(v.Renditions, r)
	}
	return rows.Err()
}

// ListFeed reads one page of the public feed with keyset pagination on
// (published_at DESC, id DESC), which is the order of the partial index
// media.videos_public_feed (status = READY AND visibility = PUBLIC). Owner
// profiles come from the same query (INNER JOIN: videos of owners who are not
// ACTIVE are not listed).
func (p *Postgres) ListFeed(ctx context.Context, q domain.FeedQuery) ([]domain.Summary, error) {
	sql, args := feedSQL(q)
	rows, err := p.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("list feed: %w", err)
	}
	defer rows.Close()
	var out []domain.Summary
	for rows.Next() {
		var s domain.Summary
		if err := rows.Scan(&s.ID, &s.Title, &s.DurationMs, &s.ViewCount, &s.PublishedAt, &s.ThumbnailKey,
			&s.Owner.ID, &s.Owner.Handle, &s.Owner.DisplayName, &s.Owner.AvatarKey); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func feedSQL(q domain.FeedQuery) (string, []any) {
	var sb strings.Builder
	sb.WriteString(`
		SELECT v.id, v.title, v.duration_ms, v.view_count, v.published_at, v.thumbnail_key,
		       p.id, p.handle, p.display_name, p.avatar_key
		FROM media.videos v
		JOIN auth.public_profiles p ON p.id = v.owner_id
		WHERE v.status = 'READY' AND v.visibility = 'PUBLIC' AND v.moderation_state = 'VISIBLE'`)
	var args []any
	arg := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
	if q.OwnerID != nil {
		sb.WriteString(" AND v.owner_id = " + arg(*q.OwnerID))
	}
	if q.After != nil {
		sb.WriteString(" AND (v.published_at, v.id) < (" + arg(q.After.T) + ", " + arg(q.After.ID) + ")")
	}
	sb.WriteString(" ORDER BY v.published_at DESC, v.id DESC LIMIT " + arg(q.Limit))
	return sb.String(), args
}

// ListStudio reads one page of a user's own videos (every status), keyset on
// (created_at DESC, id DESC) using media.videos_owner_created. Progress is the
// latest transcode job's progress (READY is reported as 100 by the API).
func (p *Postgres) ListStudio(ctx context.Context, q domain.StudioQuery) ([]domain.StudioItem, error) {
	sql, args := studioSQL(q)
	rows, err := p.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("list studio: %w", err)
	}
	defer rows.Close()
	var out []domain.StudioItem
	for rows.Next() {
		var s domain.StudioItem
		var progress float32
		if err := rows.Scan(&s.ID, &s.Title, &s.Visibility, &s.Status, &progress, &s.Error,
			&s.DurationMs, &s.CreatedAt, &s.ThumbnailKey,
			&s.ModerationState, &s.ModerationReason, &s.ModeratedAt, &s.OwnerActive); err != nil {
			return nil, err
		}
		s.Progress = float64(progress)
		out = append(out, s)
	}
	return out, rows.Err()
}

func studioSQL(q domain.StudioQuery) (string, []any) {
	var sb strings.Builder
	sb.WriteString(`
		SELECT v.id, v.title, v.visibility::text, v.status::text, coalesce(j.progress, 0), v.error,
		       v.duration_ms, v.created_at, v.thumbnail_key,
		       v.moderation_state::text, v.moderation_reason, v.moderated_at, p.id IS NOT NULL
		FROM media.videos v
		LEFT JOIN auth.public_profiles p ON p.id = v.owner_id
		LEFT JOIN LATERAL (
		    SELECT progress FROM media.transcode_jobs WHERE video_id = v.id ORDER BY attempt DESC LIMIT 1
		) j ON true
		WHERE v.owner_id = `)
	var args []any
	arg := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
	sb.WriteString(arg(q.UserID))
	if q.Status != "" {
		sb.WriteString(" AND v.status = " + arg(q.Status) + "::media.video_status")
	}
	if q.After != nil {
		sb.WriteString(" AND (v.created_at, v.id) < (" + arg(q.After.T) + ", " + arg(q.After.ID) + ")")
	}
	sb.WriteString(" ORDER BY v.created_at DESC, v.id DESC LIMIT " + arg(q.Limit))
	return sb.String(), args
}

// MediaPublic answers mediaAccess (task SEC1) with one primary-key lookup joined to
// auth.public_profiles. Keep it in step with domain.PubliclyWatchable.
func (p *Postgres) MediaPublic(ctx context.Context, id uuid.UUID) (bool, error) {
	var ok bool
	err := p.Pool.QueryRow(ctx, `
		SELECT true
		FROM media.videos v
		JOIN auth.public_profiles p ON p.id = v.owner_id
		WHERE v.id = $1 AND v.status = 'READY' AND v.visibility IN ('PUBLIC', 'UNLISTED')
		  AND v.moderation_state = 'VISIBLE'`, id).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("media access: %w", err)
	}
	return ok, nil
}

// UpdateVideo edits the metadata in ONE transaction: the row is locked (FOR UPDATE) so the old
// visibility read here is the one the UPDATE replaces, the change and, when the visibility really
// changed, the video.visibility_changed outbox row (ADR-008, task C4) commit together or not at all.
func (p *Postgres) UpdateVideo(ctx context.Context, id, ownerID uuid.UUID, u domain.Update) (domain.Video, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return domain.Video{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var before string
	err = tx.QueryRow(ctx, `SELECT visibility::text FROM media.videos WHERE id = $1 AND owner_id = $2 FOR UPDATE`, id, ownerID).Scan(&before)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Video{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Video{}, fmt.Errorf("update video: lock: %w", err)
	}
	var after string
	if err := tx.QueryRow(ctx, `
		UPDATE media.videos SET
			title       = coalesce($3, title),
			description = coalesce($4, description),
			visibility  = coalesce($5::media.visibility, visibility)
		WHERE id = $1 AND owner_id = $2
		RETURNING visibility::text`, id, ownerID, u.Title, u.Description, u.Visibility).Scan(&after); err != nil {
		return domain.Video{}, fmt.Errorf("update video: %w", err)
	}
	if after != before {
		if err := outbox.Enqueue(ctx, tx, "media", "video.visibility_changed", domain.VisibilityChangedEvent{
			VideoID: id.String(), OwnerID: ownerID.String(), Visibility: after,
		}); err != nil {
			return domain.Video{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Video{}, fmt.Errorf("commit: %w", err)
	}
	return p.GetVideo(ctx, id)
}

func (p *Postgres) DeleteVideo(ctx context.Context, id uuid.UUID, mediaBucket string) (bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var owner uuid.UUID
	var rawBucket, rawKey string
	// The cascade removes video_renditions and transcode_jobs.
	err = tx.QueryRow(ctx, `DELETE FROM media.videos WHERE id = $1 RETURNING owner_id, raw_bucket, raw_key`, id).
		Scan(&owner, &rawBucket, &rawKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("delete video: %w", err)
	}
	if err := outbox.Enqueue(ctx, tx, "media", "video.deleted", domain.DeletedEvent{
		VideoID: id.String(), OwnerID: owner.String(), RawBucket: rawBucket, RawKey: rawKey,
		MediaBucket: mediaBucket, MediaPrefix: "v/" + id.String() + "/",
	}); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

// ModerateVideo hides or restores a video. The row is locked (FOR UPDATE), the
// change and the video.moderated outbox row are written in ONE transaction
// (ADR-008), and a request that does not change the state writes nothing.
func (p *Postgres) ModerateVideo(ctx context.Context, id, moderatorID uuid.UUID, state string, reason *string) (domain.Video, bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return domain.Video{}, false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var owner uuid.UUID
	var current string
	err = tx.QueryRow(ctx, `SELECT owner_id, moderation_state::text FROM media.videos WHERE id = $1 FOR UPDATE`, id).Scan(&owner, &current)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Video{}, false, domain.ErrNotFound
	}
	if err != nil {
		return domain.Video{}, false, fmt.Errorf("moderate video: lock: %w", err)
	}
	if current == state {
		if err := tx.Commit(ctx); err != nil {
			return domain.Video{}, false, fmt.Errorf("commit: %w", err)
		}
		v, err := p.GetVideo(ctx, id)
		return v, false, err
	}

	if state == domain.ModHidden {
		_, err = tx.Exec(ctx, `UPDATE media.videos SET moderation_state = 'HIDDEN', moderation_reason = $2,
			moderated_by = $3, moderated_at = now() WHERE id = $1`, id, reason, moderatorID)
	} else {
		// VISIBLE clears the reason (constraint videos_moderation_consistent); who and when stay as the audit trail.
		_, err = tx.Exec(ctx, `UPDATE media.videos SET moderation_state = 'VISIBLE', moderation_reason = NULL,
			moderated_by = $2, moderated_at = now() WHERE id = $1`, id, moderatorID)
	}
	if err != nil {
		return domain.Video{}, false, fmt.Errorf("moderate video: update: %w", err)
	}
	if err := outbox.Enqueue(ctx, tx, "media", "video.moderated", domain.ModeratedEvent{
		VideoID: id.String(), OwnerID: owner.String(), State: state, ModeratorID: moderatorID.String(),
	}); err != nil {
		return domain.Video{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Video{}, false, fmt.Errorf("commit: %w", err)
	}
	v, err := p.GetVideo(ctx, id)
	return v, true, err
}

// SetLikeCount sets the absolute like count copied from social-svc. Rows whose
// count already equals the value are not written (no WAL churn, no updated_at
// bump), so a redelivered event is a no-op.
func (p *Postgres) SetLikeCount(ctx context.Context, id uuid.UUID, count int64) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `UPDATE media.videos SET like_count = $2 WHERE id = $1 AND like_count <> $2`, id, count)
	if err != nil {
		return false, fmt.Errorf("set like count: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// AddViews adds counted views to media.videos.view_count in ONE transaction
// (a single statement). Deleted videos match no row. updated_at is bumped by
// the set_updated_at trigger of the table; that cannot be avoided without a migration.
func (p *Postgres) AddViews(ctx context.Context, ids []uuid.UUID, counts []int64) (int, error) {
	if len(ids) != len(counts) {
		return 0, errors.New("add views: ids and counts differ in length")
	}
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := p.Pool.Exec(ctx, `UPDATE media.videos v SET view_count = v.view_count + d.n
FROM unnest($1::uuid[], $2::bigint[]) AS d(id, n) WHERE v.id = d.id`, ids, counts)
	if err != nil {
		return 0, fmt.Errorf("add views: %w", err)
	}
	return int(tag.RowsAffected()), nil
}
