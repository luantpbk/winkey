package rollup

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// batchSize is the most rows one statement carries.
const batchSize = 1000

// ClickHouse reads winkey.video_qoe_hourly with the -Merge combinators (no FINAL: the sums and the merges are
// correct over unmerged parts).
type ClickHouse struct{ Conn driver.Conn }

const daysQuery = `
SELECT video_id, any(owner_id), toString(toDate(hour, 'Asia/Ho_Chi_Minh')) AS day,
       sum(starts), sum(watched_ms), sum(rebuffer_ms), sum(errors), uniqMerge(viewers),
       quantilesMerge(0.5, 0.95)(startup_ms_q)
FROM winkey.video_qoe_hourly
WHERE hour >= ?
GROUP BY video_id, day
ORDER BY video_id, day`

// Days implements Source.
func (c *ClickHouse) Days(ctx context.Context, since time.Time) ([]Day, error) {
	rows, err := c.Conn.Query(ctx, daysQuery, since.UTC())
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()
	var out []Day
	for rows.Next() {
		var (
			d                                       Day
			dayStr                                  string
			starts, watched, rebuffer, errs, viewrs uint64
			q                                       []float64
		)
		if err := rows.Scan(&d.VideoID, &d.OwnerID, &dayStr, &starts, &watched, &rebuffer, &errs, &viewrs, &q); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		if d.Day, err = time.Parse("2006-01-02", dayStr); err != nil {
			return nil, fmt.Errorf("day %q: %w", dayStr, err)
		}
		d.Starts, d.WatchedMs, d.RebufferMs, d.Errors, d.Viewers = int64(starts), int64(watched), int64(rebuffer), int64(errs), int64(viewrs)
		if len(q) == 2 {
			d.StartupP50Ms, d.StartupP95Ms = Percentiles(q[0], q[1])
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Postgres writes analytics.video_daily.
type Postgres struct{ Pool *pgxpool.Pool }

// refreshed_at is set only when a value changed, so it means "last change".
const upsertSQL = `
INSERT INTO analytics.video_daily AS d
    (video_id, owner_id, day, starts, watched_ms, rebuffer_ms, errors, viewers, startup_p50_ms, startup_p95_ms, refreshed_at)
SELECT t.video_id, t.owner_id, t.day, t.starts, t.watched_ms, t.rebuffer_ms, t.errors, t.viewers, t.p50, t.p95, now()
FROM unnest($1::uuid[], $2::uuid[], $3::date[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[],
            $9::int[], $10::int[])
     AS t(video_id, owner_id, day, starts, watched_ms, rebuffer_ms, errors, viewers, p50, p95)
ON CONFLICT (video_id, day) DO UPDATE SET
    owner_id = EXCLUDED.owner_id, starts = EXCLUDED.starts, watched_ms = EXCLUDED.watched_ms,
    rebuffer_ms = EXCLUDED.rebuffer_ms, errors = EXCLUDED.errors, viewers = EXCLUDED.viewers,
    startup_p50_ms = EXCLUDED.startup_p50_ms, startup_p95_ms = EXCLUDED.startup_p95_ms,
    refreshed_at = EXCLUDED.refreshed_at
WHERE (d.owner_id, d.starts, d.watched_ms, d.rebuffer_ms, d.errors, d.viewers, d.startup_p50_ms, d.startup_p95_ms)
      IS DISTINCT FROM
      (EXCLUDED.owner_id, EXCLUDED.starts, EXCLUDED.watched_ms, EXCLUDED.rebuffer_ms, EXCLUDED.errors, EXCLUDED.viewers,
       EXCLUDED.startup_p50_ms, EXCLUDED.startup_p95_ms)`

// Apply implements Sink: batches of at most 1000 rows, one statement each, all in one transaction.
func (p *Postgres) Apply(ctx context.Context, rows []Day) (int64, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var changed int64
	for start := 0; start < len(rows); start += batchSize {
		batch := rows[start:min(start+batchSize, len(rows))]
		n := len(batch)
		vid, oid := make([]uuid.UUID, n), make([]uuid.UUID, n)
		day := make([]time.Time, n)
		starts, watched, rebuffer, errs, viewers := make([]int64, n), make([]int64, n), make([]int64, n), make([]int64, n), make([]int64, n)
		p50, p95 := make([]*int32, n), make([]*int32, n)
		for i, r := range batch {
			vid[i], oid[i], day[i] = r.VideoID, r.OwnerID, r.Day
			starts[i], watched[i], rebuffer[i], errs[i], viewers[i] = r.Starts, r.WatchedMs, r.RebufferMs, r.Errors, r.Viewers
			p50[i], p95[i] = r.StartupP50Ms, r.StartupP95Ms
		}
		tag, err := tx.Exec(ctx, upsertSQL, vid, oid, day, starts, watched, rebuffer, errs, viewers, p50, p95)
		if err != nil {
			return 0, fmt.Errorf("upsert: %w", err)
		}
		changed += tag.RowsAffected()
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return changed, nil
}

// Sweep implements Sink.
func (p *Postgres) Sweep(ctx context.Context, before time.Time) (int64, error) {
	tag, err := p.Pool.Exec(ctx, `DELETE FROM analytics.video_daily WHERE day < $1`, before)
	if err != nil {
		return 0, fmt.Errorf("sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}
