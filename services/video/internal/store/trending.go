package store

import (
	"context"
	"fmt"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// ListTrending reads one page of media.trending by rank. The ranking is only refreshed every few minutes, so
// a video can have been made PRIVATE, hidden, or lost its owner since: the exact predicate of the public
// feed (and of the partial indexes) is applied again here, together with the owner join, in the SAME
// statement. A row dropped this way leaves a gap in the ranks, which the cursor (the last rank returned)
// handles like any other position.
func (p *Postgres) ListTrending(ctx context.Context, q domain.TrendingQuery) ([]domain.TrendingItem, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT v.id, v.title, v.duration_ms, v.view_count, v.published_at, v.thumbnail_key,
		       p.id, p.handle, p.display_name, p.avatar_key, t.rank
		FROM media.trending t
		JOIN media.videos v ON v.id = t.video_id
		JOIN auth.public_profiles p ON p.id = v.owner_id
		WHERE v.status = 'READY' AND v.visibility = 'PUBLIC' AND v.moderation_state = 'VISIBLE'
		  AND t.rank > $1
		ORDER BY t.rank
		LIMIT $2`, q.AfterRank, q.Limit)
	if err != nil {
		return nil, fmt.Errorf("list trending: %w", err)
	}
	defer rows.Close()
	var out []domain.TrendingItem
	for rows.Next() {
		var it domain.TrendingItem
		if err := rows.Scan(&it.ID, &it.Title, &it.DurationMs, &it.ViewCount, &it.PublishedAt, &it.ThumbnailKey,
			&it.Owner.ID, &it.Owner.Handle, &it.Owner.DisplayName, &it.Owner.AvatarKey, &it.Rank); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}
