package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// tagsSQL aggregates the tags of public videos (same predicate as the feed, owner ACTIVE) by slug. The slugs come
// from the generated column media.videos.tag_slugs (migration 000021), aligned with tags, so unnest(tag_slugs, tags)
// pairs each slug with the spelling it came from. Name = the most used spelling, ties broken alphabetically. One
// filter ($1, may be NULL) restricts it to one slug; empty slugs are never tags.
const tagsSQL = `
	WITH t AS (
		SELECT u.slug, u.name, v.id, v.published_at
		FROM media.videos v
		JOIN auth.public_profiles p ON p.id = v.owner_id
		CROSS JOIN LATERAL unnest(v.tag_slugs, v.tags) AS u(slug, name)
		WHERE v.status = 'READY' AND v.visibility = 'PUBLIC' AND v.moderation_state = 'VISIBLE'
		  AND u.slug <> ''
		  AND ($1::text IS NULL OR (v.tag_slugs @> ARRAY[public.winkey_tag_slug($1::text)]
		                            AND u.slug = public.winkey_tag_slug($1::text)))
	), names AS (
		SELECT slug, name, count(*) AS uses FROM t GROUP BY slug, name
	), agg AS (
		SELECT slug, count(DISTINCT id) AS video_count, max(published_at) AS latest FROM t GROUP BY slug
	)
	SELECT a.slug,
	       (SELECT n.name FROM names n WHERE n.slug = a.slug ORDER BY n.uses DESC, n.name ASC LIMIT 1),
	       a.video_count, a.latest
	FROM agg a
	WHERE a.video_count >= $2
	ORDER BY a.video_count DESC, a.slug ASC
	LIMIT $3`

// ListTags ranks the tags of public videos by video count (task SEO2). It scans the public videos' tags; fine at
// beta scale, and the API answers with Cache-Control: public, max-age=300 (ADR-037 lists the follow-up if it grows).
func (p *Postgres) ListTags(ctx context.Context, limit, minVideos int) ([]domain.Tag, error) {
	rows, err := p.Pool.Query(ctx, tagsSQL, nil, minVideos, limit)
	if err != nil {
		return nil, fmt.Errorf("list tags: %w", err)
	}
	defer rows.Close()
	out := []domain.Tag{}
	for rows.Next() {
		var t domain.Tag
		if err := rows.Scan(&t.Slug, &t.Name, &t.VideoCount, &t.LatestPublishedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetTag returns one tag by slug or tag text (the database derives the slug); ErrNotFound when no public video
// carries it or its slug is empty.
func (p *Postgres) GetTag(ctx context.Context, tag string) (domain.Tag, error) {
	var t domain.Tag
	err := p.Pool.QueryRow(ctx, tagsSQL, tag, 1, 1).Scan(&t.Slug, &t.Name, &t.VideoCount, &t.LatestPublishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Tag{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Tag{}, fmt.Errorf("get tag: %w", err)
	}
	return t, nil
}
