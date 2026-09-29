package worker

import (
	"context"
	"log/slog"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

var reconciledTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "transcoder_reconciled_jobs_total", Help: "Lost jobs handled by the reconciler, by action.",
}, []string{"action"})

// Reconciler finds RUNNING jobs whose worker vanished (no heartbeat for
// StaleAfter: crash, power loss, network partition) and either retries the
// video or, once MaxAttempts is reached, fails it. It complements the
// max-deliveries watcher: it does not depend on JetStream advisories, so it
// also covers workers that died while no watcher was subscribed.
//
// Every worker runs one. The store handles each job exactly once even when
// several reconcilers sweep at the same moment (see Store.ReconcileStale).
type Reconciler struct {
	Store       job.Store
	Interval    time.Duration // default 60s
	StaleAfter  time.Duration // default 10m
	MaxAttempts int           // default 3
	Batch       int           // default 20 jobs per sweep
	Log         *slog.Logger
}

// Run sweeps immediately and then every Interval until ctx is cancelled.
func (r *Reconciler) Run(ctx context.Context) error {
	if r.Interval <= 0 {
		r.Interval = 60 * time.Second
	}
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	for {
		r.Sweep(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// Sweep runs one reconciliation pass and logs what it did.
func (r *Reconciler) Sweep(ctx context.Context) []job.Reconciled {
	stale, attempts, batch := r.StaleAfter, r.MaxAttempts, r.Batch
	if stale <= 0 {
		stale = 10 * time.Minute
	}
	if attempts <= 0 {
		attempts = 3
	}
	if batch <= 0 {
		batch = 20
	}
	out, err := r.Store.ReconcileStale(ctx, stale, attempts, batch)
	if err != nil && ctx.Err() == nil {
		r.Log.ErrorContext(ctx, "reconcile lost jobs failed", "error", err)
	}
	for _, x := range out {
		action := "closed"
		switch {
		case x.Retried:
			action = "retried"
		case x.Failed:
			action = "failed"
		}
		reconciledTotal.WithLabelValues(action).Inc()
		r.Log.WarnContext(ctx, "reconciled lost job (worker lost, no heartbeat)",
			"video_id", x.VideoID, "job_id", x.JobID, "attempt", x.Attempt, "action", action)
	}
	return out
}
