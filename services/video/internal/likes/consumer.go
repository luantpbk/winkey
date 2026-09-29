// Package likes keeps media.videos.like_count in sync with social-svc.
//
// social-svc owns likes and publishes social.video.like_changed with the
// ABSOLUTE like_count after each change. video-svc copies that number into
// media.videos.like_count. The consumer therefore SETS the value instead of
// incrementing it: redelivery and duplicates are harmless.
//
// Ordering. The count is absolute, so a stale event applied after a newer one
// would move the number backwards until the next like/unlike corrects it. To
// keep that window closed the consumer processes messages strictly one at a
// time and retries transient database errors in-process (a few short
// attempts) instead of Nak-ing right away, because a Nak'd message is
// redelivered after newer ones. Only when the attempts are exhausted is the
// message Nak'd with a delay, which can reorder it; the next event for that
// video fixes the value.
package likes

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Consumer parameters (contracts/events/README.md, brief S2).
const (
	Stream     = "SOCIAL"
	Durable    = "video-likes"
	Subject    = "social.video.like_changed"
	AckWait    = 30 * time.Second
	MaxDeliver = 5
)

var eventsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "video_like_events_total", Help: "social.video.like_changed messages by result.",
}, []string{"result"})

// Store applies the absolute count.
type Store interface {
	// SetLikeCount sets media.videos.like_count = count for the video. changed is
	// false when the video does not exist or already had that value.
	SetLikeCount(ctx context.Context, videoID uuid.UUID, count int64) (changed bool, err error)
}

// Action is what the consumer does with a message.
type Action int

const (
	ActionAck   Action = iota // applied, unchanged, or nothing to do (unknown video, unknown version)
	ActionTerm                // poison: will never succeed, do not redeliver
	ActionRetry               // transient failure: Nak with delay
)

// Consumer pulls social.video.like_changed and applies it.
type Consumer struct {
	JS    jetstream.JetStream
	Store Store
	Cache domain.Cache // optional; the entry of the video is invalidated after a change
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

type likeChanged struct {
	VideoID   string `json:"video_id"`
	UserID    string `json:"user_id"`
	Liked     *bool  `json:"liked"`
	LikeCount *int64 `json:"like_count"`
}

// Process handles one message payload (the event envelope) and reports what to
// do with the message. It never panics on bad input.
func (c *Consumer) Process(ctx context.Context, payload []byte) Action {
	c.defaults()
	var env outbox.Envelope
	if err := json.Unmarshal(payload, &env); err != nil || env.Type != Subject {
		c.Log.ErrorContext(ctx, "malformed like event envelope; terminating", "error", err, "type", env.Type)
		eventsTotal.WithLabelValues("malformed").Inc()
		return ActionTerm
	}
	if env.Version != 1 {
		// Consumers ignore versions they do not know (contracts/events/README.md).
		c.Log.WarnContext(ctx, "like event with an unknown version; ignoring", "version", env.Version)
		eventsTotal.WithLabelValues("ignored_version").Inc()
		return ActionAck
	}
	var d likeChanged
	if err := json.Unmarshal(env.Data, &d); err != nil {
		c.Log.ErrorContext(ctx, "malformed like event data; terminating", "error", err)
		eventsTotal.WithLabelValues("malformed").Inc()
		return ActionTerm
	}
	videoID, err := uuid.Parse(d.VideoID)
	if err != nil || len(d.VideoID) != 36 || d.LikeCount == nil || *d.LikeCount < 0 || d.Liked == nil {
		c.Log.ErrorContext(ctx, "invalid like event data; terminating", "video_id", d.VideoID)
		eventsTotal.WithLabelValues("malformed").Inc()
		return ActionTerm
	}

	var changed bool
	delay := c.RetryDelay
	for attempt := 1; ; attempt++ {
		changed, err = c.Store.SetLikeCount(ctx, videoID, *d.LikeCount)
		if err == nil {
			break
		}
		if ctx.Err() != nil || attempt >= c.Attempts {
			c.Log.ErrorContext(ctx, "cannot apply like count; will retry later", "video_id", videoID, "attempts", attempt, "error", err)
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

	if !changed {
		// Unknown video (deleted, or not ours) or the same value again.
		eventsTotal.WithLabelValues("unchanged").Inc()
		return ActionAck
	}
	if c.Cache != nil {
		c.Cache.Invalidate(ctx, videoID)
	}
	eventsTotal.WithLabelValues("applied").Inc()
	return ActionAck
}

// Run consumes until ctx is cancelled. It survives the SOCIAL stream not
// existing yet (social-svc not deployed): it keeps looking for it, so video-svc
// starts fine before C1 lands.
func (c *Consumer) Run(ctx context.Context) error {
	c.defaults()
	warned := false
	for ctx.Err() == nil {
		cons, err := c.JS.CreateOrUpdateConsumer(ctx, Stream, jetstream.ConsumerConfig{
			Durable:       Durable,
			FilterSubject: Subject,
			AckPolicy:     jetstream.AckExplicitPolicy,
			AckWait:       AckWait,
			MaxDeliver:    MaxDeliver,
		})
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if !warned || !errors.Is(err, jetstream.ErrStreamNotFound) {
				c.Log.Warn("like consumer not started yet; retrying", "stream", Stream, "error", err, "retry_in", c.RetryEvery.String())
				warned = true
			}
			sleep(ctx, c.RetryEvery)
			continue
		}
		warned = false
		c.Log.Info("consuming like events", "stream", Stream, "durable", Durable)
		c.consume(ctx, cons)
	}
	return nil
}

// consume returns when ctx is cancelled or the consumer disappears (stream
// deleted or recreated), so Run can set it up again.
func (c *Consumer) consume(ctx context.Context, cons jetstream.Consumer) {
	for ctx.Err() == nil {
		batch, err := cons.Fetch(10, jetstream.FetchMaxWait(5*time.Second))
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
		if md, err := msg.Metadata(); err == nil && md.NumDelivered >= MaxDeliver {
			// Out of deliveries: the next like event for this video carries a new absolute count.
			c.Log.ErrorContext(ctx, "giving up on a like event after the last delivery", "seq", md.Sequence.Stream)
			_ = msg.Term()
			return
		}
		_ = msg.NakWithDelay(c.NakDelay)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
