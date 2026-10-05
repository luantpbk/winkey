// Package reco builds the ADR-028 recommendation projections independently of ingestion.
package reco

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

type Pair struct {
	VideoID, NeighborID uuid.UUID
	CoViewers           int32
	Score               float64
}

type Watch struct {
	ViewerKey     string
	VideoID       uuid.UUID
	LastWatchedAt time.Time
	WatchedMs     int64
}

type Options struct{ WindowDays, MinWatchMs, Neighbors, History, CoviewMax int }

type Source interface {
	Read(context.Context, time.Time, Options) ([]Pair, []Watch, uint64, error)
}
type Sink interface {
	Replace(context.Context, []Pair, []Watch, time.Time) error
}

var (
	runs        = promauto.NewCounterVec(prometheus.CounterOpts{Name: "analytics_reco_runs_total", Help: "Recommendation runs by result."}, []string{"result"})
	errorsTotal = promauto.NewCounter(prometheus.CounterOpts{Name: "analytics_reco_errors_total", Help: "Failed recommendation runs."})
	lastSuccess = promauto.NewGauge(prometheus.GaugeOpts{Name: "analytics_reco_last_success_timestamp_seconds", Help: "Last successful recommendation run."})
	duration    = promauto.NewHistogram(prometheus.HistogramOpts{Name: "analytics_reco_duration_seconds", Help: "Recommendation run duration.", Buckets: prometheus.ExponentialBuckets(.01, 2, 18)})
	rowCount    = promauto.NewGaugeVec(prometheus.GaugeOpts{Name: "analytics_reco_rows", Help: "Rows in the last committed recommendation projection."}, []string{"table"})
	// ADR-028 names this _total, but requires the number in the last run, rather than a cumulative counter.
	viewersCapped = promauto.NewGauge(prometheus.GaugeOpts{Name: "analytics_reco_viewers_capped_total", Help: "Viewers whose qualified co-view set was truncated in the last successful recommendation run."})
)

type Runner struct {
	Source   Source
	Sink     Sink
	Log      *slog.Logger
	Interval time.Duration
	Options  Options
	Now      func() time.Time
}

// Run owns one goroutine: refreshes cannot overlap, including the immediate startup run.
func (r *Runner) Run(ctx context.Context) {
	r.RunOnce(ctx)
	ticker := time.NewTicker(r.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.RunOnce(ctx)
		}
	}
}

func (r *Runner) RunOnce(ctx context.Context) bool {
	started := time.Now()
	defer func() { duration.Observe(time.Since(started).Seconds()) }()
	now := started.UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	pairs, history, capped, err := r.Source.Read(ctx, now, r.Options)
	step := "read clickhouse"
	if err == nil {
		step = "replace postgres"
		err = r.Sink.Replace(ctx, pairs, history, now)
	}
	if err != nil {
		runs.WithLabelValues("error").Inc()
		errorsTotal.Inc()
		// Driver errors can contain COPY row contents (including viewer_key). Never log them.
		r.Log.Error("recommendation refresh failed; retrying at next tick", "step", step)
		return false
	}
	runs.WithLabelValues("success").Inc()
	lastSuccess.SetToCurrentTime()
	viewersCapped.Set(float64(capped))
	rowCount.WithLabelValues("video_coview").Set(float64(len(pairs)))
	rowCount.WithLabelValues("viewer_history").Set(float64(len(history)))
	r.Log.Info("recommendation refresh done", "pairs", len(pairs), "history_rows", len(history), "duration_seconds", time.Since(started).Seconds())
	return true
}
