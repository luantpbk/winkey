package views

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// ViewsTotal counts view reports by outcome; the API increments it once per
	// answered report (counted, duplicate, below_threshold, rate_limited, valkey_down).
	ViewsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "video_views_total", Help: "View reports by result.",
	}, []string{"result"})
	flushSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "video_view_flush_seconds", Help: "Duration of one flush pass that had work to do.",
		Buckets: prometheus.ExponentialBuckets(0.005, 2, 12),
	})
	flushErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "video_view_flush_errors_total", Help: "Flush attempts that failed (the batch is kept and retried).",
	})
)

// Writer adds counted views to media.videos.view_count.
type Writer interface {
	// AddViews adds counts[i] to view_count of ids[i] in ONE transaction and returns
	// how many videos matched (deleted videos match no row).
	AddViews(ctx context.Context, ids []uuid.UUID, counts []int64) (matched int, err error)
}

// Flusher drains the pending hash into PostgreSQL. Run one per replica: it is
// safe with any number of them.
//
//	rotate   RENAME views:pending -> views:flush:{uuid}   (atomic; no such key = nothing to do)
//	claim    SET views:flushlock:{uuid} NX PX lockTTL     (one applier per batch)
//	apply    UPDATE media.videos ... FROM unnest(...)     (one transaction)
//	finish   DEL views:flush:{uuid}
//
// A failed apply keeps the flush key, so the batch is retried on the next pass;
// leftover flush keys (a crashed replica) are claimed the same way. A view is
// therefore never lost. The one window left is a crash between the database
// commit and the DEL, which would apply that batch once more (at most one
// batch of over-count per crash); the alternative order would lose views.
type Flusher struct {
	V        *Valkey
	DB       Writer
	Interval time.Duration // default 30 s
	LockTTL  time.Duration // default 2 min; must exceed DBTimeout
	// DBTimeout bounds one database write (default 30 s).
	DBTimeout time.Duration
	Log       *slog.Logger

	once sync.Once
}

// defaults fills unset fields once, so FlushOnce is safe to call from several goroutines.
func (f *Flusher) defaults() { f.once.Do(f.setDefaults) }

func (f *Flusher) setDefaults() {
	if f.Interval <= 0 {
		f.Interval = 30 * time.Second
	}
	if f.DBTimeout <= 0 {
		f.DBTimeout = 30 * time.Second
	}
	if f.LockTTL <= 0 {
		f.LockTTL = 2 * time.Minute
	}
}

// Run flushes immediately (which also picks up leftovers after a crash) and then
// every Interval until ctx is cancelled, with a last best-effort flush on the way out.
func (f *Flusher) Run(ctx context.Context) error {
	f.defaults()
	f.pass(ctx)
	t := time.NewTicker(f.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			// Whatever is still pending stays in Valkey for the other replicas.
			final, cancel := context.WithTimeout(context.WithoutCancel(ctx), f.DBTimeout)
			defer cancel()
			f.pass(final)
			return nil
		case <-t.C:
			f.pass(ctx)
		}
	}
}

func (f *Flusher) pass(ctx context.Context) {
	if _, err := f.FlushOnce(ctx); err != nil && ctx.Err() == nil {
		f.Log.ErrorContext(ctx, "view flush failed; the batch is kept and retried", "error", err)
	}
}

// FlushOnce applies every batch it can claim: leftovers first, then a fresh
// rotation. It returns the number of views applied (video rows matched) and the
// first error; a failing batch does not stop the others.
func (f *Flusher) FlushOnce(ctx context.Context) (applied int64, err error) {
	f.defaults()
	start := time.Now()
	var firstErr error
	fail := func(e error) {
		flushErrors.Inc()
		if firstErr == nil {
			firstErr = e
		}
	}

	keys, e := f.V.FlushKeys(ctx)
	if e != nil {
		fail(fmt.Errorf("list leftover batches: %w", e))
	}
	if key, ok, e := f.V.Rotate(ctx); e != nil {
		fail(fmt.Errorf("rotate pending: %w", e))
	} else if ok {
		keys = append(keys, key)
	}

	worked := false
	for _, key := range keys {
		n, took, e := f.apply(ctx, key)
		if took {
			worked = true
		}
		applied += n
		if e != nil {
			fail(e)
		}
	}
	if worked {
		flushSeconds.Observe(time.Since(start).Seconds())
	}
	return applied, firstErr
}

// apply claims one flush key and writes it. took is false when another replica
// holds it. On any failure the key is kept (and unlocked) for the next pass.
func (f *Flusher) apply(ctx context.Context, key string) (applied int64, took bool, err error) {
	locked, err := f.V.Lock(ctx, key, f.LockTTL)
	if err != nil {
		return 0, false, fmt.Errorf("lock %s: %w", key, err)
	}
	if !locked {
		return 0, false, nil // being applied by another replica
	}
	release := func() { _ = f.V.Unlock(context.WithoutCancel(ctx), key) }

	counts, bad, err := f.V.Batch(ctx, key)
	if err != nil {
		release()
		return 0, true, fmt.Errorf("read %s: %w", key, err)
	}
	for _, field := range bad {
		f.Log.ErrorContext(ctx, "dropping a malformed entry from a view batch", "batch", key, "field", field)
	}
	if len(counts) > 0 {
		ids := make([]uuid.UUID, 0, len(counts))
		ns := make([]int64, 0, len(counts))
		for id, n := range counts {
			ids, ns = append(ids, id), append(ns, n)
			applied += n
		}
		dbCtx, cancel := context.WithTimeout(ctx, f.DBTimeout)
		matched, werr := f.DB.AddViews(dbCtx, ids, ns)
		cancel()
		if werr != nil {
			release()
			return 0, true, fmt.Errorf("apply %s: %w", key, werr)
		}
		f.Log.InfoContext(ctx, "views flushed", "batch", key, "videos", len(ids), "matched", matched, "views", applied)
	}

	// The database write is committed: remove the batch. Retry the delete a few
	// times: if it stayed, the next pass would apply the batch a second time.
	var derr error
	for i := 0; i < 3; i++ {
		if derr = f.V.Done(context.WithoutCancel(ctx), key); derr == nil {
			return applied, true, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	f.Log.ErrorContext(ctx, "views were applied but the batch could not be deleted; delete it by hand to avoid a double count",
		"batch", key, "error", derr)
	return applied, true, errors.Join(errors.New("batch applied but not deleted: "+key), derr)
}
