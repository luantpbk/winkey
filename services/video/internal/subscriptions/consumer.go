// Package subscriptions keeps media.subscriptions, video-svc's own copy of "who follows whom", in sync with
// social-svc (task R2-b, ADR-021). ADR-007 forbids reading social.subscriptions from here, so the projection
// is built from social.subscription.changed on the SOCIAL stream (durable video-subscriptions, deliver all);
// migration 000012 backfilled what happened before the stream's 7 days.
//
// subscribed = true is INSERT … ON CONFLICT DO NOTHING (subscribed_at = the event's occurred_at), false is
// DELETE. Both are idempotent, so redelivery, duplicates and the replay of the whole stream after the backfill
// are harmless as long as they are applied in stream order. That is why messages are processed strictly one at a
// time and transient database errors are retried in-process (like the like-count consumer) instead of being
// Nak'd, because a Nak'd message is redelivered after newer ones and an unsubscribe applied before the
// subscribe it follows would leave the wrong row behind.
//
// STRICT ORDER. That in-process retry only shrinks the window; what closes it is the consumer configuration:
// MaxAckPending = 1, so JetStream hands out the next message only when the current one is acknowledged, and a
// Nak'd message is therefore redelivered BEFORE any newer one; MaxDeliver = -1, so a transient failure is never
// turned into a dropped change (the queue waits for the database instead); Term is only for malformed events, which
// can never succeed. The price of a database that stays down is a queue that waits, by design.
package subscriptions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Consumer parameters (contracts/events/README.md, "Consumer của video-svc cho feed theo dõi").
const (
	Stream  = "SOCIAL"
	Durable = "video-subscriptions"
	Subject = "social.subscription.changed"
	AckWait = 30 * time.Second
	// MaxDeliver -1 = unlimited and MaxAckPending 1: see "STRICT ORDER" in the package comment. (The events README
	// still says max_deliver 5; that was written before this rule.)
	MaxDeliver    = -1
	MaxAckPending = 1
)

var eventsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "video_subscription_events_total", Help: "social.subscription.changed messages by result.",
}, []string{"result"}) // subscribed, unsubscribed, malformed, ignored_version, error

// Store applies one change to media.subscriptions.
type Store interface {
	// Subscribe adds the row (subscribed_at = at); an existing row is left as it is.
	Subscribe(ctx context.Context, subscriber, channel uuid.UUID, at time.Time) error
	// Unsubscribe removes the row; a missing row is not an error.
	Unsubscribe(ctx context.Context, subscriber, channel uuid.UUID) error
}

// Action is what the consumer does with a message.
type Action int

const (
	ActionAck   Action = iota // applied, or nothing to do (unknown version)
	ActionTerm                // poison: will never succeed, do not redeliver
	ActionRetry               // transient failure: Nak with delay
)

// Consumer pulls social.subscription.changed and applies it.
type Consumer struct {
	JS    jetstream.JetStream
	Store Store
	Log   *slog.Logger

	Attempts   int           // in-process attempts per message (default 3)
	RetryDelay time.Duration // first in-process retry delay, doubled each time (default 200ms)
	NakDelay   time.Duration // delay of a Nak after the attempts fail (default 10s)
	RetryEvery time.Duration // how often to look for the stream while it does not exist (default 10s)
}

func (c *Consumer) defaults() {
	if c.Attempts <= 0 {
		c.Attempts = 3
	}
	if c.RetryDelay <= 0 {
		c.RetryDelay = 200 * time.Millisecond
	}
	if c.NakDelay <= 0 {
		c.NakDelay = 10 * time.Second
	}
	if c.RetryEvery <= 0 {
		c.RetryEvery = 10 * time.Second
	}
}

// envelope and data follow envelope.schema.json and social.subscription.changed.schema.json, which additionally
// forbid unknown fields: a message that breaks either can never become valid, so it is terminated.
type envelope struct {
	EventID    *string         `json:"event_id"`
	Type       *string         `json:"type"`
	Version    *int            `json:"version"`
	OccurredAt *time.Time      `json:"occurred_at"`
	Producer   *string         `json:"producer"`
	Trace      *string         `json:"traceparent"`
	Data       json.RawMessage `json:"data"`
}

type change struct {
	SubscriberID    *string `json:"subscriber_id"`
	ChannelID       *string `json:"channel_id"`
	Subscribed      *bool   `json:"subscribed"`
	SubscriberCount *int64  `json:"subscriber_count"`
}

func strictUnmarshal(raw []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

// uuidOf accepts only the canonical 36 character form (the schema's `format: uuid`).
func uuidOf(s *string) (uuid.UUID, bool) {
	if s == nil || len(*s) != 36 {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(*s)
	return id, err == nil
}

// Decoded is a valid event.
type Decoded struct {
	Subscriber, Channel uuid.UUID
	Subscribed          bool
	At                  time.Time
}

// Decode validates a payload against the contract. ok is false for a malformed event (terminate);
// ignore is true for a version this code does not know (ack and skip, contracts/events/README.md).
func Decode(payload []byte) (d Decoded, ok, ignore bool) {
	var env envelope
	if strictUnmarshal(payload, &env) != nil || env.EventID == nil || env.Type == nil || *env.Type != Subject ||
		env.Version == nil || *env.Version < 1 || env.OccurredAt == nil || env.Producer == nil || len(env.Data) == 0 {
		return Decoded{}, false, false
	}
	if _, err := uuid.Parse(*env.EventID); err != nil || len(*env.EventID) != 36 {
		return Decoded{}, false, false
	}
	if *env.Version != 1 {
		return Decoded{}, false, true
	}
	var ch change
	if strictUnmarshal(env.Data, &ch) != nil || ch.Subscribed == nil || ch.SubscriberCount == nil || *ch.SubscriberCount < 0 {
		return Decoded{}, false, false
	}
	sub, ok1 := uuidOf(ch.SubscriberID)
	chn, ok2 := uuidOf(ch.ChannelID)
	if !ok1 || !ok2 || sub == chn { // a channel cannot follow itself (media_subscriptions_not_self)
		return Decoded{}, false, false
	}
	return Decoded{Subscriber: sub, Channel: chn, Subscribed: *ch.Subscribed, At: env.OccurredAt.UTC()}, true, false
}

// Process handles one message payload and reports what to do with the message. It never panics on bad input.
func (c *Consumer) Process(ctx context.Context, payload []byte) Action {
	c.defaults()
	d, ok, ignore := Decode(payload)
	switch {
	case ignore:
		c.Log.WarnContext(ctx, "subscription event with an unknown version; ignoring")
		eventsTotal.WithLabelValues("ignored_version").Inc()
		return ActionAck
	case !ok:
		c.Log.ErrorContext(ctx, "malformed subscription event; terminating")
		eventsTotal.WithLabelValues("malformed").Inc()
		return ActionTerm
	}

	apply := func() error {
		if d.Subscribed {
			return c.Store.Subscribe(ctx, d.Subscriber, d.Channel, d.At)
		}
		return c.Store.Unsubscribe(ctx, d.Subscriber, d.Channel)
	}
	var err error
	delay := c.RetryDelay
	for attempt := 1; ; attempt++ {
		if err = apply(); err == nil {
			break
		}
		if ctx.Err() != nil || attempt >= c.Attempts {
			c.Log.ErrorContext(ctx, "cannot apply subscription change; will retry later", "attempts", attempt, "error", err)
			eventsTotal.WithLabelValues("error").Inc()
			return ActionRetry
		}
		select {
		case <-ctx.Done():
			return ActionRetry
		case <-time.After(delay):
		}
		delay *= 2
	}
	if d.Subscribed {
		eventsTotal.WithLabelValues("subscribed").Inc()
	} else {
		eventsTotal.WithLabelValues("unsubscribed").Inc()
	}
	return ActionAck
}

// Run consumes until ctx is cancelled. It survives the SOCIAL stream not existing yet (social-svc not
// deployed): it keeps looking for it, so video-svc starts fine before it.
func (c *Consumer) Run(ctx context.Context) error {
	c.defaults()
	warned := false
	for ctx.Err() == nil {
		cons, err := c.JS.CreateOrUpdateConsumer(ctx, Stream, jetstream.ConsumerConfig{
			Durable:       Durable,
			FilterSubject: Subject,
			DeliverPolicy: jetstream.DeliverAllPolicy,
			AckPolicy:     jetstream.AckExplicitPolicy,
			AckWait:       AckWait,
			MaxDeliver:    MaxDeliver,
			MaxAckPending: MaxAckPending,
		})
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if !warned || !errors.Is(err, jetstream.ErrStreamNotFound) {
				c.Log.Warn("subscription consumer not started yet; retrying", "stream", Stream, "error", err, "retry_in", c.RetryEvery.String())
				warned = true
			}
			sleep(ctx, c.RetryEvery)
			continue
		}
		warned = false
		c.Log.Info("consuming subscription events", "stream", Stream, "durable", Durable)
		c.consume(ctx, cons)
	}
	return nil
}

// consume returns when ctx is cancelled or the consumer disappears (stream deleted or recreated), so Run can
// set it up again.
func (c *Consumer) consume(ctx context.Context, cons jetstream.Consumer) {
	for ctx.Err() == nil {
		batch, err := cons.Fetch(1, jetstream.FetchMaxWait(5*time.Second)) // one message at a time, like MaxAckPending
		if err != nil {
			c.Log.Warn("fetch failed; re-creating the consumer", "error", err)
			sleep(ctx, time.Second)
			return
		}
		for msg := range batch.Messages() { // strictly one at a time, in order
			c.handle(ctx, msg)
		}
		if err := batch.Error(); err != nil && (errors.Is(err, jetstream.ErrConsumerNotFound) || errors.Is(err, jetstream.ErrConsumerDeleted)) {
			return
		}
	}
}

func (c *Consumer) handle(ctx context.Context, msg jetstream.Msg) {
	switch c.Process(ctx, msg.Data()) {
	case ActionAck:
		_ = msg.Ack()
	case ActionTerm:
		_ = msg.Term()
	case ActionRetry:
		// Never Term on a transient failure, and never move on: with MaxAckPending 1 the same message comes back
		// after the delay, before any newer one, so the events of a pair are applied in stream order.
		_ = msg.NakWithDelay(c.NakDelay)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
