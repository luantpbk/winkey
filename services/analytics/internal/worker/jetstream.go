package worker

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// Consumer parameters (contracts/events/README.md, "Consumer analytics-worker").
const (
	Stream        = "ANALYTICS"
	Durable       = "analytics-clickhouse"
	Subject       = "analytics.playback"
	AckWait       = 60 * time.Second
	MaxDeliver    = -1
	MaxAckPending = 20000
)

type jsMsg struct {
	m           jetstream.Msg
	seq         uint64
	redelivered bool
}

func (j jsMsg) Data() []byte      { return j.m.Data() }
func (j jsMsg) Seq() uint64       { return j.seq }
func (j jsMsg) Redelivered() bool { return j.redelivered }
func (j jsMsg) Ack() error        { return j.m.Ack() }
func (j jsMsg) Nak() error        { return j.m.Nak() }
func (j jsMsg) Term() error       { return j.m.Term() }
func (j jsMsg) InProgress() error { return j.m.InProgress() }

// Stream consumption: it creates (or updates) the durable, waits for the stream while it does not exist, fetches
// batches from it, and starts over when the consumer disappears.
type JetStreamSource struct {
	JS  jetstream.JetStream
	Log *slog.Logger
	// RetryEvery is how often to look for the stream while it does not exist (default 10 s).
	RetryEvery time.Duration

	mu   sync.RWMutex
	cons jetstream.Consumer
}

func (s *JetStreamSource) get() jetstream.Consumer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cons
}

func (s *JetStreamSource) set(c jetstream.Consumer) {
	s.mu.Lock()
	s.cons = c
	s.mu.Unlock()
}

func (s *JetStreamSource) ensure(ctx context.Context) error {
	if s.RetryEvery <= 0 {
		s.RetryEvery = 10 * time.Second
	}
	warned := false
	for ctx.Err() == nil {
		cons, err := s.JS.CreateOrUpdateConsumer(ctx, Stream, jetstream.ConsumerConfig{
			Durable:       Durable,
			FilterSubject: Subject,
			DeliverPolicy: jetstream.DeliverAllPolicy,
			AckPolicy:     jetstream.AckExplicitPolicy,
			AckWait:       AckWait,
			MaxDeliver:    MaxDeliver,
			MaxAckPending: MaxAckPending,
		})
		if err == nil {
			s.set(cons)
			s.Log.Info("consuming analytics events", "stream", Stream, "durable", Durable)
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !warned || !errors.Is(err, jetstream.ErrStreamNotFound) {
			s.Log.Warn("analytics consumer not started yet; retrying", "stream", Stream, "error", err, "retry_in", s.RetryEvery.String())
			warned = true
		}
		select {
		case <-ctx.Done():
		case <-time.After(s.RetryEvery):
		}
	}
	return ctx.Err()
}

// Fetch implements Source.
func (s *JetStreamSource) Fetch(ctx context.Context, max int, wait time.Duration) ([]Msg, error) {
	for {
		if s.get() == nil {
			if err := s.ensure(ctx); err != nil {
				return nil, err
			}
		}
		batch, err := s.get().Fetch(max, jetstream.FetchMaxWait(wait))
		if err != nil {
			s.Log.Warn("fetch failed; re-creating the consumer", "error", err)
			s.set(nil)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Second):
			}
			continue
		}
		var out []Msg
		for m := range batch.Messages() {
			md, err := m.Metadata()
			if err != nil {
				_ = m.Term() // a message without metadata is not one of ours
				continue
			}
			out = append(out, jsMsg{m: m, seq: md.Sequence.Stream, redelivered: md.NumDelivered > 1})
		}
		if err := batch.Error(); err != nil && (errors.Is(err, jetstream.ErrConsumerNotFound) || errors.Is(err, jetstream.ErrConsumerDeleted)) {
			s.set(nil)
		}
		return out, nil
	}
}

// WatchPending sets the analytics_consumer_pending gauge every interval until ctx is cancelled.
func (s *JetStreamSource) WatchPending(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c := s.get()
			if c == nil {
				continue
			}
			info, err := c.Info(ctx)
			if err != nil {
				continue
			}
			Pending.Set(float64(info.NumPending) + float64(info.NumAckPending))
		}
	}
}
