// Package trending computes the trending ranking of task R2-a (ADR-020): the score of a video is the sum of
// its hourly view counts decayed with a half life of 24 hours over the last 72 hours; the top 200 videos the
// public feed would show replace media.trending as a whole, every few minutes, on ONE replica.
package trending

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// The formula and its limits (ADR-020).
const (
	HalfLife  = 24 * time.Hour
	Window    = 72 * time.Hour // buckets older than this do not count
	MinScore  = 1.0            // videos scoring less are dropped
	TopN      = 200
	Retention = 8 * 24 * time.Hour // buckets older than this are deleted

	// lockKey is the pg_try_advisory_xact_lock key: "winkey" + 1 (ascii), so nothing else picks it by accident.
	lockKey int64 = 0x77696e6b65790001

	retentionBatch = 5000
)

var (
	recomputeSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "video_trending_recompute_seconds", Help: "Duration of one trending recompute that ran (the replica that got the lock).",
		Buckets: prometheus.ExponentialBuckets(0.005, 2, 12),
	})
	trendingSize = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "video_trending_size", Help: "Videos in media.trending after the last recompute of this replica.",
	})
	recomputeErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "video_trending_recompute_errors_total", Help: "Trending recomputes that failed (the previous ranking stays).",
	})
)

// Score is the contribution of `views` counted in a bucket that is `age` old: views * 0.5^(age / 24 h). A view
// counted now is worth 1.0, one counted 24 hours ago 0.5. Callers exclude buckets older than Window.
// The SQL of the job computes the same expression (a test compares them).
func Score(views int64, age time.Duration) float64 {
	return float64(views) * math.Pow(0.5, age.Seconds()/HalfLife.Seconds())
}

// recomputeSQL replaces media.trending; $1 is the number of videos to keep. It runs in a transaction that
// already holds the advisory lock.
//
// Eligible = exactly the public-feed predicate (PUBLIC, READY, VISIBLE, owner in auth.public_profiles), the same
// text as the partial index media.videos_public_feed. Ordering `score DESC, id DESC` makes ties stable.
const (
	deleteTrendingSQL = `DELETE FROM media.trending`
	insertTrendingSQL = `
INSERT INTO media.trending (video_id, rank, score, computed_at)
SELECT s.video_id, row_number() OVER (ORDER BY s.score DESC, s.video_id DESC), s.score, now()
FROM (
	SELECT h.video_id,
	       sum(h.views * power(0.5, extract(epoch FROM (now() - h.hour)) / 86400.0)) AS score
	FROM media.video_views_hourly h
	JOIN media.videos v ON v.id = h.video_id
	JOIN auth.public_profiles p ON p.id = v.owner_id
	WHERE h.hour >= now() - interval '72 hours'
	  AND v.status = 'READY' AND v.visibility = 'PUBLIC' AND v.moderation_state = 'VISIBLE'
	GROUP BY h.video_id
	HAVING sum(h.views * power(0.5, extract(epoch FROM (now() - h.hour)) / 86400.0)) >= 1
	ORDER BY score DESC, h.video_id DESC
	LIMIT $1
) s`
	// retentionSQL deletes one batch of old buckets; run until it deletes nothing.
	retentionSQL = `
DELETE FROM media.video_views_hourly
WHERE (video_id, hour) IN (
	SELECT video_id, hour FROM media.video_views_hourly
	WHERE hour < now() - interval '8 days' ORDER BY hour LIMIT $1
)`
)

// Result is what one RunOnce did.
type Result struct {
	Ran      bool          // false: another replica held the lock, nothing was done
	Size     int           // rows of the new ranking
	Duration time.Duration // of the recompute (without the retention)
	Retired  int64         // buckets deleted by the retention pass
}

// Job recomputes the ranking. Run one per replica: the advisory lock lets exactly one of them work at a time.
type Job struct {
	Pool     *pgxpool.Pool
	Interval time.Duration // default 10 minutes
	Log      *slog.Logger

	running atomic.Bool
}

// Run computes at once (a fresh replica or a restart must not wait ten minutes) and then every Interval until
// ctx is cancelled.
func (j *Job) Run(ctx context.Context) error {
	iv := j.Interval
	if iv <= 0 {
		iv = 10 * time.Minute
	}
	j.tick(ctx)
	t := time.NewTicker(iv)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			j.tick(ctx)
		}
	}
}

func (j *Job) tick(ctx context.Context) {
	res, err := j.RunOnce(ctx)
	switch {
	case err != nil:
		if ctx.Err() == nil {
			recomputeErrors.Inc()
			j.Log.ErrorContext(ctx, "trending recompute failed; the previous ranking stays", "error", err)
		}
	case !res.Ran:
		j.Log.DebugContext(ctx, "trending recompute skipped: another replica is computing it")
	default:
		j.Log.InfoContext(ctx, "trending recomputed", "videos", res.Size, "duration", res.Duration.Round(time.Millisecond).String(), "retired_buckets", res.Retired)
	}
}

// RunOnce recomputes the ranking if this replica gets the advisory lock, then applies the retention. The
// ranking is replaced in ONE transaction (DELETE + INSERT), so a reader in another transaction sees the old
// ranking or the new one, never an empty or mixed table; a failure rolls back and the old ranking stays.
func (j *Job) RunOnce(ctx context.Context) (Result, error) {
	// The retention below runs after the commit and must not overlap with itself either, so one run at a
	// time per replica; the advisory lock takes care of the other replicas.
	if !j.running.CompareAndSwap(false, true) {
		return Result{}, nil
	}
	defer j.running.Store(false)

	start := time.Now()
	tx, err := j.Pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var got bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, lockKey).Scan(&got); err != nil {
		return Result{}, fmt.Errorf("advisory lock: %w", err)
	}
	if !got {
		return Result{}, nil // another replica is on it; the lock would have been released with our transaction anyway
	}
	if _, err := tx.Exec(ctx, deleteTrendingSQL); err != nil {
		return Result{}, fmt.Errorf("clear trending: %w", err)
	}
	tag, err := tx.Exec(ctx, insertTrendingSQL, TopN)
	if err != nil {
		return Result{}, fmt.Errorf("insert trending: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, fmt.Errorf("commit: %w", err)
	}
	res := Result{Ran: true, Size: int(tag.RowsAffected()), Duration: time.Since(start)}
	recomputeSeconds.Observe(res.Duration.Seconds())
	trendingSize.Set(float64(res.Size))

	// Retention, in batches so a large backlog never holds a long lock. A failure here is not a failure of the
	// ranking, which is already committed.
	for {
		tag, err := j.Pool.Exec(ctx, retentionSQL, retentionBatch)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				j.Log.WarnContext(ctx, "trending retention failed; it is retried on the next run", "error", err)
			}
			break
		}
		res.Retired += tag.RowsAffected()
		if tag.RowsAffected() < retentionBatch {
			break
		}
	}
	return res, nil
}
