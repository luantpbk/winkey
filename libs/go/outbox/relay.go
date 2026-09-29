package outbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Publisher publishes one persistent message. msgID is sent as Nats-Msg-Id so
// JetStream de-duplicates retries (duplicate window 2m).
type Publisher interface {
	Publish(ctx context.Context, subject string, data []byte, msgID string) error
}

// JetStreamPublisher adapts a jetstream.JetStream to Publisher.
type JetStreamPublisher struct{ JS jetstream.JetStream }

// Publish waits for the stream ack.
func (p JetStreamPublisher) Publish(ctx context.Context, subject string, data []byte, msgID string) error {
	msg := &nats.Msg{Subject: subject, Data: data, Header: nats.Header{}}
	_, err := p.JS.PublishMsg(ctx, msg, jetstream.WithMsgID(msgID))
	return err
}

// Relay moves rows of <Schema>.outbox to the Publisher.
type Relay struct {
	Pool      *pgxpool.Pool
	Publisher Publisher
	Schema    string
	Log       *slog.Logger

	// Zero values pick the defaults noted below.
	PollInterval    time.Duration // 500ms
	BatchSize       int           // 100
	Retention       time.Duration // 7 days: published rows older than this are deleted
	CleanupInterval time.Duration // 10 minutes
	// Listen wakes the relay as soon as Enqueue's transaction commits, in
	// addition to polling. It holds one dedicated connection.
	Listen bool
}

func (r *Relay) defaults() error {
	if !identRe.MatchString(r.Schema) {
		return fmt.Errorf("outbox: invalid schema name %q", r.Schema)
	}
	if r.Pool == nil || r.Publisher == nil {
		return errors.New("outbox: relay needs Pool and Publisher")
	}
	if r.Log == nil {
		r.Log = slog.Default()
	}
	if r.PollInterval <= 0 {
		r.PollInterval = 500 * time.Millisecond
	}
	if r.BatchSize <= 0 {
		r.BatchSize = 100
	}
	if r.Retention <= 0 {
		r.Retention = 7 * 24 * time.Hour
	}
	if r.CleanupInterval <= 0 {
		r.CleanupInterval = 10 * time.Minute
	}
	return nil
}

// Run blocks until ctx is cancelled. Errors are logged and retried on the
// next tick; only invalid configuration is returned.
func (r *Relay) Run(ctx context.Context) error {
	if err := r.defaults(); err != nil {
		return err
	}
	wake := make(chan struct{}, 1)
	if r.Listen {
		go r.listen(ctx, wake)
	}
	poll := time.NewTicker(r.PollInterval)
	defer poll.Stop()
	cleanup := time.NewTicker(r.CleanupInterval)
	defer cleanup.Stop()

	for {
		r.drain(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-poll.C:
		case <-wake:
		case <-cleanup.C:
			r.cleanup(ctx)
		}
	}
}

// drain publishes batches until one comes back short or fails.
func (r *Relay) drain(ctx context.Context) {
	for ctx.Err() == nil {
		n, err := r.PublishBatch(ctx)
		if err != nil {
			r.Log.ErrorContext(ctx, "outbox relay batch failed", "schema", r.Schema, "error", err)
			return
		}
		if n < r.BatchSize {
			return
		}
	}
}

// PublishBatch publishes up to BatchSize pending rows in id order and marks
// them published. Rows are locked with FOR UPDATE SKIP LOCKED so several
// relay replicas can run concurrently (ordering across replicas is then
// best-effort; consumers must be idempotent). If a publish fails, the rows
// already published in this batch are still marked, the rest are retried.
func (r *Relay) PublishBatch(ctx context.Context) (int, error) {
	if err := r.defaults(); err != nil {
		return 0, err
	}
	table := pgx.Identifier{r.Schema, "outbox"}.Sanitize()

	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	rows, err := tx.Query(ctx, `SELECT id, event_id::text, subject, payload::text FROM `+table+
		` WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, r.BatchSize)
	if err != nil {
		return 0, err
	}
	type row struct {
		id            int64
		eventID, subj string
		payload       string
	}
	var batch []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.id, &x.eventID, &x.subj, &x.payload); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	var done []int64
	var pubErr error
	for _, x := range batch {
		if pubErr = r.Publisher.Publish(ctx, x.subj, []byte(x.payload), x.eventID); pubErr != nil {
			break
		}
		done = append(done, x.id)
	}
	if len(done) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE `+table+` SET published_at = now() WHERE id = ANY($1)`, done); err != nil {
			return 0, err
		}
		if err := tx.Commit(ctx); err != nil {
			// Rows were published but not marked: they are re-published and
			// de-duplicated by Nats-Msg-Id.
			return 0, err
		}
	}
	if pubErr != nil {
		return len(done), fmt.Errorf("publish: %w", pubErr)
	}
	return len(done), nil
}

func (r *Relay) cleanup(ctx context.Context) {
	table := pgx.Identifier{r.Schema, "outbox"}.Sanitize()
	tag, err := r.Pool.Exec(ctx, `DELETE FROM `+table+
		` WHERE published_at IS NOT NULL AND published_at < now() - make_interval(secs => $1)`, r.Retention.Seconds())
	if err != nil {
		r.Log.ErrorContext(ctx, "outbox cleanup failed", "schema", r.Schema, "error", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		r.Log.InfoContext(ctx, "outbox cleanup", "schema", r.Schema, "deleted", n)
	}
}

// listen forwards NOTIFY wake-ups; it reconnects with a fixed backoff and
// never fails the relay (polling still works).
func (r *Relay) listen(ctx context.Context, wake chan<- struct{}) {
	for ctx.Err() == nil {
		if err := r.listenOnce(ctx, wake); err != nil && ctx.Err() == nil {
			r.Log.WarnContext(ctx, "outbox listen failed; falling back to polling", "error", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

func (r *Relay) listenOnce(ctx context.Context, wake chan<- struct{}) error {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// The connection carries LISTEN state, so take it out of the pool for good.
	pc := conn.Hijack()
	defer func() { _ = pc.Close(context.WithoutCancel(ctx)) }()
	if _, err := pc.Exec(ctx, "LISTEN "+pgx.Identifier{NotifyChannel(r.Schema)}.Sanitize()); err != nil {
		return err
	}
	for {
		if _, err := pc.WaitForNotification(ctx); err != nil {
			return err
		}
		select {
		case wake <- struct{}{}:
		default:
		}
	}
}
