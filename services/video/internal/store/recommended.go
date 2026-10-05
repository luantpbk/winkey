package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

var _ domain.RecommendationStore = (*Postgres)(nil)

// One statement gives history, co-view and subscription/trending signals one MVCC snapshot.
// ADR-028 R2-perf bounds the fully scored/ordered list before diversity; newest fill shares this bound.
const recommendationSQL = `WITH history AS (
 SELECT video_id, last_watched_at FROM analytics.viewer_history
 WHERE viewer_key = $1 AND $4::boolean ORDER BY last_watched_at DESC, video_id DESC LIMIT 50
), eligible AS (
 SELECT v.id, v.owner_id, v.published_at FROM media.videos v
 JOIN auth.public_profiles p ON p.id = v.owner_id
 WHERE ` + publicPredicate + ` AND v.owner_id <> $2
 AND NOT EXISTS (SELECT 1 FROM analytics.viewer_history h WHERE h.viewer_key=$1 AND h.video_id=v.id)
), coview AS (
 SELECT c.neighbor_id, sum(c.score::double precision *
 power(0.5::double precision, extract(epoch FROM ($3::timestamptz-h.last_watched_at))::double precision/604800)) AS raw
 FROM analytics.video_coview c JOIN history h ON h.video_id=c.video_id
 JOIN eligible e ON e.id=c.neighbor_id GROUP BY c.neighbor_id
), signals AS (
 SELECT e.*, coalesce(c.raw / nullif((SELECT max(raw) FROM coview),0),0) AS sc,
 CASE WHEN $4::boolean AND e.published_at >= $3::timestamptz - interval '14 days'
 AND EXISTS (SELECT 1 FROM media.subscriptions s WHERE s.subscriber_id=$2 AND s.channel_id=e.owner_id)
 THEN power(0.5::double precision, extract(epoch FROM ($3::timestamptz-e.published_at))::double precision/259200)
 ELSE 0 END AS ss,
 CASE WHEN t.rank BETWEEN 1 AND 200 THEN 1-(t.rank-1)::double precision/200 ELSE 0 END AS st
 FROM eligible e LEFT JOIN coview c ON c.neighbor_id=e.id
 LEFT JOIN media.trending t ON t.video_id=e.id
)
SELECT id, owner_id, (sc>0 OR ss>0) AS personal
FROM signals ORDER BY (sc+0.7*ss+0.3*st) DESC, published_at DESC, id DESC
LIMIT $5`

func (p *Postgres) RecommendationCandidates(ctx context.Context, key string, user uuid.UUID, now time.Time, personalize bool) ([]domain.RecommendationCandidate, error) {
	limit := p.RecommendationCandidateLimit
	if limit == 0 {
		limit = 2000
	}
	rows, err := p.Pool.Query(ctx, recommendationSQL, key, user, now, personalize, limit)
	if err != nil {
		return nil, fmt.Errorf("recommendation candidates: %w", err)
	}
	defer rows.Close()
	var out []domain.RecommendationCandidate
	for rows.Next() {
		var c domain.RecommendationCandidate
		if err := rows.Scan(&c.ID, &c.OwnerID, &c.Personal); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Recheck visibility, owner activity, ownership and ALL persisted history even on a cached-list page.
func (p *Postgres) RecommendationPage(ctx context.Context, ids []uuid.UUID, key string, user uuid.UUID) ([]domain.Summary, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT `+relatedCols+`
 FROM unnest($1::uuid[]) WITH ORDINALITY AS chosen(id,ord)
 JOIN media.videos v ON v.id=chosen.id JOIN auth.public_profiles p ON p.id=v.owner_id
 WHERE `+publicPredicate+` AND v.owner_id<>$3
 AND NOT EXISTS (SELECT 1 FROM analytics.viewer_history h WHERE h.viewer_key=$2 AND h.video_id=v.id)
 ORDER BY chosen.ord`, ids, key, user)
	if err != nil {
		return nil, fmt.Errorf("recommendation page: %w", err)
	}
	return scanSummaries(rows)
}
