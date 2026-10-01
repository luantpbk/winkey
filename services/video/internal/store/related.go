package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Related videos (task R2-c, ADR-025). Every query applies the predicate of the public feed AND of the partial indexes
// (READY, PUBLIC, VISIBLE) and joins the owner profile view like listVideos (a suspended owner has no row there).

const relatedCols = `v.id, v.title, v.duration_ms, v.view_count, v.published_at, v.thumbnail_key,
		       p.id, p.handle, p.display_name, p.avatar_key`

// RelatedSimilarSQL is exported for the EXPLAIN test: $1 = the source id, $2 = the OR-ed words (folded in SQL),
// $3 = limit. The match is written on v.search_vector with the exact predicate of videos_search_fts, in an inner
// query on media.videos ALONE, so the planner starts from the partial GIN index instead of joining the (few, wide)
// profile rows first; the inner query over-fetches (2 x limit) because the owner join, applied afterwards,
// drops the videos of owners that are no longer active.
const RelatedSimilarSQL = `
		SELECT ` + relatedCols + `
		FROM (
			SELECT v.*, ts_rank(v.search_vector, to_tsquery('simple', public.winkey_fold($2))) AS rank
			FROM media.videos v
			WHERE ` + publicPredicate + `
			  AND v.id <> $1
			  AND v.search_vector @@ to_tsquery('simple', public.winkey_fold($2))
			ORDER BY rank DESC, v.published_at DESC, v.id
			LIMIT $3 * 2
		) v
		JOIN auth.public_profiles p ON p.id = v.owner_id
		ORDER BY v.rank DESC, v.published_at DESC, v.id
		LIMIT $3`

func scanSummaries(rows pgx.Rows) ([]domain.Summary, error) {
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

// RelatedSimilar implements domain.Store.
func (p *Postgres) RelatedSimilar(ctx context.Context, exclude uuid.UUID, tsquery string, limit int) ([]domain.Summary, error) {
	rows, err := p.Pool.Query(ctx, RelatedSimilarSQL, exclude, tsquery, limit)
	if err != nil {
		return nil, fmt.Errorf("related similar: %w", err)
	}
	return scanSummaries(rows)
}

// RelatedSameChannel implements domain.Store.
func (p *Postgres) RelatedSameChannel(ctx context.Context, owner, exclude uuid.UUID, limit int) ([]domain.Summary, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT `+relatedCols+`
		FROM media.videos v
		JOIN auth.public_profiles p ON p.id = v.owner_id
		WHERE `+publicPredicate+` AND v.owner_id = $1 AND v.id <> $2
		ORDER BY v.published_at DESC, v.id DESC
		LIMIT $3`, owner, exclude, limit)
	if err != nil {
		return nil, fmt.Errorf("related same channel: %w", err)
	}
	return scanSummaries(rows)
}

// RelatedTrending implements domain.Store.
func (p *Postgres) RelatedTrending(ctx context.Context, exclude uuid.UUID, limit int) ([]domain.Summary, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT `+relatedCols+`
		FROM media.trending t
		JOIN media.videos v ON v.id = t.video_id
		JOIN auth.public_profiles p ON p.id = v.owner_id
		WHERE `+publicPredicate+` AND v.id <> $1
		ORDER BY t.rank
		LIMIT $2`, exclude, limit)
	if err != nil {
		return nil, fmt.Errorf("related trending: %w", err)
	}
	return scanSummaries(rows)
}
