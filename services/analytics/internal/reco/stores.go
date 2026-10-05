package reco

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ClickHouse struct{ Conn driver.Conn }

// FINAL collapses the raw sorting key before aggregation, including unmerged duplicate parts.
// Never use the hourly materialized view for per-viewer qualification.
const qualifiedSQL = `SELECT viewer_key, video_id, max(received_at) AS last_watched_at
 FROM winkey.playback_events FINAL
 WHERE received_at >= ? AND received_at < ?
 GROUP BY viewer_key, video_id HAVING sum(toUInt64(watched_ms)) >= ?`

const cappedCountSQL = `WITH qualified AS (` + qualifiedSQL + `)
SELECT count() FROM (SELECT viewer_key FROM qualified GROUP BY viewer_key HAVING count() > ?)`

const pairsSQL = `WITH qualified AS (` + qualifiedSQL + `), capped AS (
 SELECT viewer_key, video_id FROM qualified
 ORDER BY viewer_key, last_watched_at DESC, video_id ASC
 LIMIT ? BY viewer_key
), viewers AS (
 SELECT video_id, count() AS viewers FROM capped GROUP BY video_id
), shared AS (
 SELECT a.video_id AS video_id, b.video_id AS neighbor_id, count() AS co_viewers
 FROM capped AS a INNER JOIN capped AS b ON a.viewer_key = b.viewer_key
 WHERE a.video_id != b.video_id
 GROUP BY a.video_id, b.video_id HAVING co_viewers >= 3
)
SELECT s.video_id, s.neighbor_id, toInt32(s.co_viewers),
       s.co_viewers / sqrt(toFloat64(a.viewers) * toFloat64(b.viewers)) AS score
FROM shared AS s
INNER JOIN viewers AS a ON s.video_id = a.video_id
INNER JOIN viewers AS b ON s.neighbor_id = b.video_id
ORDER BY s.video_id, score DESC, s.co_viewers DESC, s.neighbor_id
LIMIT ? BY s.video_id`

const historySQL = `SELECT toString(viewer_key), video_id, max(received_at) AS last_watched_at,
 toInt64(sum(toUInt64(watched_ms))) AS watched
FROM winkey.playback_events FINAL
WHERE received_at >= ? AND received_at < ? AND authenticated = true
GROUP BY viewer_key, video_id HAVING watched >= ?
ORDER BY viewer_key, last_watched_at DESC, video_id ASC
LIMIT ? BY viewer_key`

func (c *ClickHouse) Read(ctx context.Context, now time.Time, o Options) ([]Pair, []Watch, uint64, error) {
	since := now.AddDate(0, 0, -o.WindowDays)
	var capped uint64
	if err := c.Conn.QueryRow(ctx, cappedCountSQL, since, now, o.MinWatchMs, o.CoviewMax).Scan(&capped); err != nil {
		return nil, nil, 0, fmt.Errorf("capped viewers query: %w", err)
	}
	rows, err := c.Conn.Query(ctx, pairsSQL, since, now, o.MinWatchMs, o.CoviewMax, o.Neighbors)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("coview query: %w", err)
	}
	var pairs []Pair
	for rows.Next() {
		var p Pair
		if err := rows.Scan(&p.VideoID, &p.NeighborID, &p.CoViewers, &p.Score); err != nil {
			_ = rows.Close()
			return nil, nil, 0, fmt.Errorf("coview scan: %w", err)
		}
		pairs = append(pairs, p)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, nil, 0, err
	}
	rows, err = c.Conn.Query(ctx, historySQL, since, now, o.MinWatchMs, o.History)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("history query: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var history []Watch
	for rows.Next() {
		var w Watch
		if err := rows.Scan(&w.ViewerKey, &w.VideoID, &w.LastWatchedAt, &w.WatchedMs); err != nil {
			return nil, nil, 0, fmt.Errorf("history scan: %w", err)
		}
		history = append(history, w)
	}
	return pairs, history, capped, rows.Err()
}

type Postgres struct{ Pool *pgxpool.Pool }

// Replace publishes both projections atomically, including empty results. COPY avoids per-row SQL overhead.
func (p *Postgres) Replace(ctx context.Context, pairs []Pair, history []Watch, refreshed time.Time) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err = tx.Exec(ctx, `DELETE FROM analytics.video_coview; DELETE FROM analytics.viewer_history`); err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	_, err = tx.CopyFrom(ctx, pgx.Identifier{"analytics", "video_coview"}, []string{"video_id", "neighbor_id", "co_viewers", "score", "refreshed_at"}, pgx.CopyFromSlice(len(pairs), func(i int) ([]any, error) {
		r := pairs[i]
		return []any{r.VideoID, r.NeighborID, r.CoViewers, r.Score, refreshed}, nil
	}))
	if err != nil {
		return fmt.Errorf("copy coview: %w", err)
	}
	_, err = tx.CopyFrom(ctx, pgx.Identifier{"analytics", "viewer_history"}, []string{"viewer_key", "video_id", "last_watched_at", "watched_ms", "refreshed_at"}, pgx.CopyFromSlice(len(history), func(i int) ([]any, error) {
		r := history[i]
		return []any{r.ViewerKey, r.VideoID, r.LastWatchedAt, r.WatchedMs, refreshed}, nil
	}))
	if err != nil {
		return fmt.Errorf("copy history: %w", err)
	}
	return tx.Commit(ctx)
}
