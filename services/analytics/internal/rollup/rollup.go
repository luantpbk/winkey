// Package rollup copies the hourly player statistics of ClickHouse into analytics.video_daily in PostgreSQL
// (task R1-b, ADR-022 addendum): video-svc reads only PostgreSQL, so the studio statistics keep working while gpu-01
// (ClickHouse) is off. Days are calendar days in Asia/Ho_Chi_Minh (UTC+7, no DST).
package rollup

import (
	"context"
	"log/slog"
	"math"
	"time"
	_ "time/tzdata" // the image is distroless: it has no zoneinfo

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const (
	Timezone = "Asia/Ho_Chi_Minh"
	// RetentionDays is how long a day row is kept (the sweep deletes older ones).
	RetentionDays = 730
)

var location = mustLocation(Timezone)

func mustLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic("zoneinfo " + name + ": " + err.Error())
	}
	return loc
}

var (
	lastSuccess = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "analytics_rollup_last_success_timestamp_seconds", Help: "Unix time of the last successful rollup run.",
	})
	runSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "analytics_rollup_duration_seconds", Help: "Duration of a rollup run (successful or not).",
		Buckets: prometheus.ExponentialBuckets(0.01, 2, 14),
	})
	rowsUpserted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "analytics_rollup_rows_upserted_total", Help: "Rows of analytics.video_daily inserted or changed.",
	})
	runErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "analytics_rollup_errors_total", Help: "Rollup runs (or sweeps) that failed; they are retried at the next tick.",
	})
)

// Day is one analytics.video_daily row.
type Day struct {
	VideoID, OwnerID uuid.UUID
	Day              time.Time // the calendar date, midnight UTC
	Starts           int64
	WatchedMs        int64
	RebufferMs       int64
	Errors           int64
	Viewers          int64
	StartupP50Ms     *int32 // nil when the day had no start with a startup time
	StartupP95Ms     *int32
}

// Percentiles maps the two quantiles ClickHouse returns to the nullable integer columns: nan (an empty state) is
// NULL, the values are rounded, and p50 is never above p95 (the table has a CHECK).
func Percentiles(p50, p95 float64) (*int32, *int32) {
	conv := func(v float64) *int32 {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return nil
		}
		r := int32(math.Min(math.Round(v), math.MaxInt32))
		return &r
	}
	a, b := conv(p50), conv(p95)
	if a != nil && b != nil && *a > *b {
		a = b
	}
	return a, b
}

// Source reads the daily rows from ClickHouse: every (video, day) with hours at or after since (UTC).
type Source interface {
	Days(ctx context.Context, since time.Time) ([]Day, error)
}

// Sink writes them to PostgreSQL.
type Sink interface {
	// Apply upserts rows in ONE transaction and returns how many rows were inserted or really changed.
	Apply(ctx context.Context, rows []Day) (changed int64, err error)
	// Sweep deletes the rows of days before the given date and returns how many.
	Sweep(ctx context.Context, before time.Time) (int64, error)
}

// Runner recomputes the recent days every Interval. One goroutine, so runs never overlap; a failed run is logged,
// counted and retried at the next tick; it never stops anything else.
type Runner struct {
	Source       Source
	Sink         Sink
	Log          *slog.Logger
	Interval     time.Duration
	WindowDays   int
	BackfillDays int // the window of the first successful run
	Now          func() time.Time

	backfilled bool
	swept      time.Time // the date of the last successful sweep
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Today is the calendar date in Asia/Ho_Chi_Minh of t, as midnight UTC.
func Today(t time.Time) time.Time {
	y, m, d := t.In(location).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// WindowStart is the UTC instant at which the first of the last n days (today included) begins in Ho Chi Minh.
func WindowStart(now time.Time, n int) time.Time {
	first := Today(now).AddDate(0, 0, -(n - 1))
	return time.Date(first.Year(), first.Month(), first.Day(), 0, 0, 0, 0, location).UTC()
}

// Run does one run now (the backfill window) and then one per Interval until ctx is cancelled.
func (r *Runner) Run(ctx context.Context) {
	r.RunOnce(ctx)
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.RunOnce(ctx)
		}
	}
}

// RunOnce is one rollup run; it returns whether it succeeded.
func (r *Runner) RunOnce(ctx context.Context) bool {
	start := time.Now()
	defer func() { runSeconds.Observe(time.Since(start).Seconds()) }()
	days := r.WindowDays
	if !r.backfilled {
		days = r.BackfillDays
	}
	now := r.now()
	since := WindowStart(now, days)
	rows, err := r.Source.Days(ctx, since)
	if err != nil {
		return r.failed("read clickhouse", err)
	}
	changed, err := r.Sink.Apply(ctx, rows)
	if err != nil {
		return r.failed("write postgres", err)
	}
	r.backfilled = true
	rowsUpserted.Add(float64(changed))
	lastSuccess.SetToCurrentTime()
	r.Log.Info("rollup done", "days", days, "since", since.Format(time.RFC3339), "rows", len(rows), "changed", changed,
		"took", time.Since(start).Round(time.Millisecond).String())

	if today := Today(now); !today.Equal(r.swept) { // the first run of each day
		deleted, err := r.Sink.Sweep(ctx, today.AddDate(0, 0, -RetentionDays))
		if err != nil {
			return r.failed("sweep", err)
		}
		r.swept = today
		if deleted > 0 {
			r.Log.Info("retention sweep", "deleted", deleted)
		}
	}
	return true
}

func (r *Runner) failed(what string, err error) bool {
	runErrors.Inc()
	r.Log.Error("rollup failed; retrying at the next tick", "step", what, "error", err)
	return false
}
