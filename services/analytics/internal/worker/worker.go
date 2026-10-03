// Package worker moves analytics.playback messages from JetStream into ClickHouse (task R1, ADR-022).
//
// A batch is up to MaxBatch messages or MaxWait, written with ONE INSERT; the messages are acknowledged only after
// that INSERT succeeded. Exactness of the hourly sums needs two things from the INSERT (db/clickhouse/0001_playback.sql):
//
//	SETTINGS insert_deduplication_token = '<first stream seq>-<last stream seq>',
//	         deduplicate_blocks_in_dependent_materialized_views = 1
//
// so a block that was already inserted is dropped by the base table AND by video_qoe_hourly. A token only identifies a
// block if the SAME messages make the SAME block every time, so a failed INSERT is retried in this process with the
// very same batch (same rows, same token) until it succeeds; the messages are kept alive with InProgress meanwhile.
// Re-fetching instead (Nak and receive them again) could return a longer batch with the same first sequence, which
// would get another token and count the overlap twice. Only a crash between a committed INSERT and the acks can make
// JetStream redeliver an already inserted batch. A redelivered batch checks which event IDs are already persisted
// before inserting its missing rows, so a different batch boundary cannot count a committed overlap twice.
package worker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/services/analytics/internal/event"
)

var (
	batchesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "analytics_batches_total", Help: "Batches by result: inserted, error (one per failed attempt), empty (nothing valid in it).",
	}, []string{"result"})
	rowsInserted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "analytics_rows_inserted_total", Help: "Rows written to winkey.playback_events.",
	})
	batchSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "analytics_batch_seconds", Help: "Duration of the INSERT of a batch (successful attempts).",
		Buckets: prometheus.ExponentialBuckets(0.005, 2, 14),
	})
	messagesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "analytics_messages_total", Help: "Messages by outcome: inserted, duplicate (same event_id in the batch), malformed, unknown_version.",
	}, []string{"result"})
	// Pending is the number of messages the durable has not acknowledged (pending + ack pending); set by the consumer.
	Pending = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "analytics_consumer_pending", Help: "Messages of the durable not yet acknowledged, read every 30 s.",
	})
)

// MessagesMalformed is the counter of terminated malformed messages (for tests).
func MessagesMalformed() prometheus.Counter { return messagesTotal.WithLabelValues("malformed") }

// Msg is one JetStream message as the worker sees it.
type Msg interface {
	Data() []byte
	Seq() uint64 // stream sequence
	Redelivered() bool
	Ack() error
	Nak() error
	Term() error
	InProgress() error
}

// Source delivers the next batch: up to max messages, returning when max is reached or wait has passed (possibly
// with none).
type Source interface {
	Fetch(ctx context.Context, max int, wait time.Duration) ([]Msg, error)
}

// Inserter writes rows with ONE INSERT carrying the deduplication token.
type Inserter interface {
	InsertBatch(ctx context.Context, rows []event.Row, token string) error
	// Unwritten returns rows whose event IDs are not yet persisted. Used once per redelivered batch;
	// after a successful lookup, INSERT retries keep exactly the same rows and token.
	Unwritten(ctx context.Context, rows []event.Row) ([]event.Row, error)
}

// Worker is the batching loop.
type Worker struct {
	Source   Source
	Inserter Inserter
	Log      *slog.Logger

	MaxBatch int           // default 5000
	MaxWait  time.Duration // default 2 s
	// Backoff is the wait after the attempt-th failed INSERT of a batch: 5 s x attempt, at most 60 s.
	Backoff func(attempt int) time.Duration
	// KeepAliveEvery is how often InProgress is sent for a batch that is waiting for the database (the ack wait of the
	// durable is 60 s). Default 20 s.
	KeepAliveEvery time.Duration
	// InsertTimeout bounds ONE INSERT attempt; it must stay below ack_wait/2 so a hung connection cannot let the
	// messages expire before the retry starts. Default 30 s (CLICKHOUSE_INSERT_TIMEOUT).
	InsertTimeout time.Duration
}

// DefaultBackoff is 5 s x attempt, capped at 60 s.
func DefaultBackoff(attempt int) time.Duration {
	return min(time.Duration(attempt)*5*time.Second, time.Minute)
}

func (w *Worker) defaults() {
	if w.MaxBatch <= 0 {
		w.MaxBatch = 5000
	}
	if w.MaxWait <= 0 {
		w.MaxWait = 2 * time.Second
	}
	if w.Backoff == nil {
		w.Backoff = DefaultBackoff
	}
	if w.InsertTimeout <= 0 {
		w.InsertTimeout = 30 * time.Second
	}
	if w.KeepAliveEvery <= 0 {
		w.KeepAliveEvery = 20 * time.Second
	}
}

// Run processes batches until ctx is cancelled. A batch that is being written when ctx is cancelled is abandoned
// without acknowledgement and NAKed for immediate redelivery.
func (w *Worker) Run(ctx context.Context) error {
	w.defaults()
	for ctx.Err() == nil {
		msgs, err := w.Source.Fetch(ctx, w.MaxBatch, w.MaxWait)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if len(msgs) == 0 {
			continue
		}
		if err := w.ProcessBatch(ctx, msgs); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
	return nil
}

type entry struct {
	msg Msg
	row event.Row
}

// ProcessBatch handles one fetched batch. It returns only when every valid message was written and acknowledged, or
// when ctx was cancelled (then nothing more is acknowledged).
func (w *Worker) ProcessBatch(ctx context.Context, msgs []Msg) error {
	w.defaults()
	var keep []entry
	var dups []Msg
	seen := map[uuid.UUID]bool{}
	for _, m := range msgs {
		row, res := event.Decode(m.Data())
		switch res {
		case event.Malformed:
			messagesTotal.WithLabelValues("malformed").Inc()
			w.Log.Error("malformed analytics message; terminating", "seq", m.Seq())
			_ = m.Term()
		case event.UnknownVersion:
			messagesTotal.WithLabelValues("unknown_version").Inc()
			w.Log.Warn("analytics message of an unknown version; terminating", "seq", m.Seq())
			_ = m.Term()
		default:
			if seen[row.EventID] { // the same sample twice in one block would be summed twice by the hourly view
				dups = append(dups, m)
				continue
			}
			seen[row.EventID] = true
			keep = append(keep, entry{m, row})
		}
	}
	if len(keep) == 0 {
		batchesTotal.WithLabelValues("empty").Inc()
		for _, m := range dups {
			_ = m.Ack()
		}
		return nil
	}

	rows := make([]event.Row, len(keep))
	all := make([]Msg, 0, len(keep)+len(dups))
	first, last := keep[0].msg.Seq(), keep[0].msg.Seq()
	for i, e := range keep {
		rows[i] = e.row
		all = append(all, e.msg)
		first, last = min(first, e.msg.Seq()), max(last, e.msg.Seq())
	}
	all = append(all, dups...)
	acknowledged := false
	defer func() {
		if !acknowledged && ctx.Err() != nil {
			for _, m := range all {
				if err := m.Nak(); err != nil {
					w.Log.Warn("could not release analytics message on shutdown", "seq", m.Seq(), "error", err)
				}
			}
		}
	}()
	recovered := true
	for _, m := range all {
		if m.Redelivered() {
			recovered = false
			break
		}
	}
	token := fmt.Sprintf("%d-%d", first, last)

	for attempt := 1; ; attempt++ {
		start := time.Now()
		timeout := w.InsertTimeout
		if timeout <= 0 {
			timeout = 30 * time.Second
		}
		attemptCtx, cancel := context.WithTimeout(ctx, timeout)
		var err error
		if !recovered {
			var unwritten []event.Row
			unwritten, err = w.Inserter.Unwritten(attemptCtx, rows)
			if err == nil {
				rows = unwritten
				if len(rows) > 0 {
					ids := make(map[uuid.UUID]bool, len(rows))
					for _, row := range rows {
						ids[row.EventID] = true
					}
					first, last = ^uint64(0), 0
					for _, e := range keep {
						if ids[e.row.EventID] {
							first, last = min(first, e.msg.Seq()), max(last, e.msg.Seq())
						}
					}
					token = fmt.Sprintf("%d-%d", first, last)
				}
				recovered = true
			}
		}
		if err == nil && len(rows) > 0 {
			err = w.Inserter.InsertBatch(attemptCtx, rows, token)
		}
		cancel()
		if err == nil {
			batchSeconds.Observe(time.Since(start).Seconds())
			batchesTotal.WithLabelValues("inserted").Inc()
			rowsInserted.Add(float64(len(rows)))
			messagesTotal.WithLabelValues("inserted").Add(float64(len(keep)))
			messagesTotal.WithLabelValues("duplicate").Add(float64(len(dups)))
			for _, m := range all {
				_ = m.Ack() // only now: a message is never acknowledged before its rows are in ClickHouse
			}
			acknowledged = true
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err() // shutting down: abandon the batch, no ack
		}
		batchesTotal.WithLabelValues("error").Inc()
		wait := w.Backoff(attempt)
		w.Log.Error("clickhouse insert failed; retrying the same batch", "token", token, "rows", len(rows), "attempt", attempt, "retry_in", wait.String(), "error", err)
		if !w.wait(ctx, wait, all) {
			return ctx.Err()
		}
	}
}

// wait sleeps d, telling JetStream every KeepAliveEvery that the messages are still being worked on. It returns
// false when ctx was cancelled.
func (w *Worker) wait(ctx context.Context, d time.Duration, msgs []Msg) bool {
	deadline := time.NewTimer(d)
	defer deadline.Stop()
	tick := time.NewTicker(w.KeepAliveEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return true
		case <-tick.C:
			for _, m := range msgs {
				_ = m.InProgress()
			}
		}
	}
}
