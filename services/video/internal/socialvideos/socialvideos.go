// Package socialvideos manages the short videos of posts (SOC-2b, ADR-049).
//
// A video uploaded with purpose SOCIAL belongs to a post. social-svc reports it through two events on the SOCIAL
// stream:
//   - social.post.video_attached: a post was created with the video; video-svc sets media.videos.attached_at;
//   - social.post.video_released: the post was deleted; video-svc deletes the video (video.deleted, the media
//     janitor removes the files).
//
// Both are idempotent and act only on a SOCIAL video owned by the post author. The Janitor deletes SOCIAL videos
// never attached to a post within 48 hours.
package socialvideos

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

// Consumer parameters (contracts/events/README.md).
const (
	Stream          = "SOCIAL"
	Durable         = "video-social-posts"
	SubjectAttached = "social.post.video_attached"
	SubjectReleased = "social.post.video_released"
	AckWait         = 30 * time.Second
	MaxDeliver      = 10
)

var (
	eventsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "video_social_post_events_total", Help: "social.post.video_attached/released messages by type and result.",
	}, []string{"type", "result"})
	janitorDeleted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "video_social_unattached_deleted_total", Help: "SOCIAL videos deleted because no post attached them.",
	})
	janitorErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "video_social_janitor_errors_total", Help: "Failed runs of the unattached social video janitor.",
	})
)

// Store is what the consumer and the janitor need (store.Postgres).
type Store interface {
	AttachSocialVideo(ctx context.Context, videoID, authorID uuid.UUID) (bool, error)
	ReleaseSocialVideo(ctx context.Context, videoID, authorID uuid.UUID, mediaBucket string) (bool, error)
	DeleteUnattachedSocialVideos(ctx context.Context, olderThan time.Duration, limit int, mediaBucket string) ([]uuid.UUID, error)
}

// Action is what the consumer does with a message.
type Action int

const (
	ActionAck   Action = iota // applied, or nothing to do (unknown video, unknown version)
	ActionTerm                // poison: will never succeed, do not redeliver
	ActionRetry               // transient failure: Nak with delay
)

// Consumer pulls the two post events and applies them.
type Consumer struct {
	JS          jetstream.JetStream
	Store       Store
	Cache       domain.Cache // optional; the entry of a deleted video is invalidated
	MediaBucket string
	Log         *slog.Logger

	NakDelay   time.Duration // default 10s
	RetryEvery time.Duration // how often to look for the stream while it does not exist (default 10s)
}

func (c *Consumer) defaults() {
	if c.NakDelay <= 0 {
		c.NakDelay = 10 * time.Second
	}
	if c.RetryEvery <= 0 {
		c.RetryEvery = 10 * time.Second
	}
}

type postVideo struct {
	PostID   string `json:"post_id"`
	VideoID  string `json:"video_id"`
	AuthorID string `json:"author_id"`
}

// Process handles one message payload (the event envelope). It never panics on bad input.
func (c *Consumer) Process(ctx context.Context, payload []byte) Action {
	var env outbox.Envelope
	if err := json.Unmarshal(payload, &env); err != nil || (env.Type != SubjectAttached && env.Type != SubjectReleased) {
		c.Log.ErrorContext(ctx, "malformed post video event envelope; terminating", "error", err, "type", env.Type)
		eventsTotal.WithLabelValues("unknown", "malformed").Inc()
		return ActionTerm
	}
	if env.Version != 1 {
		// Consumers ignore versions they do not know (contracts/events/README.md).
		c.Log.WarnContext(ctx, "post video event with an unknown version; ignoring", "type", env.Type, "version", env.Version)
		eventsTotal.WithLabelValues(env.Type, "ignored_version").Inc()
		return ActionAck
	}
	var d postVideo
	if err := json.Unmarshal(env.Data, &d); err != nil {
		c.Log.ErrorContext(ctx, "malformed post video event data; terminating", "type", env.Type, "error", err)
		eventsTotal.WithLabelValues(env.Type, "malformed").Inc()
		return ActionTerm
	}
	videoID, err1 := uuid.Parse(d.VideoID)
	authorID, err2 := uuid.Parse(d.AuthorID)
	if err1 != nil || err2 != nil || len(d.VideoID) != 36 || len(d.AuthorID) != 36 {
		c.Log.ErrorContext(ctx, "invalid post video event data; terminating", "type", env.Type, "video_id", d.VideoID)
		eventsTotal.WithLabelValues(env.Type, "malformed").Inc()
		return ActionTerm
	}

	var found bool
	var err error
	if env.Type == SubjectAttached {
		found, err = c.Store.AttachSocialVideo(ctx, videoID, authorID)
	} else {
		found, err = c.Store.ReleaseSocialVideo(ctx, videoID, authorID, c.MediaBucket)
	}
	if err != nil {
		c.Log.ErrorContext(ctx, "cannot apply post video event; will retry", "type", env.Type, "video_id", videoID, "error", err)
		eventsTotal.WithLabelValues(env.Type, "error").Inc()
		return ActionRetry
	}
	if !found {
		// Already deleted, not a SOCIAL video, or not the author's: nothing to do.
		c.Log.InfoContext(ctx, "post video event for no matching social video; ignoring", "type", env.Type, "video_id", videoID, "post_id", d.PostID)
		eventsTotal.WithLabelValues(env.Type, "ignored").Inc()
		return ActionAck
	}
	if env.Type == SubjectReleased {
		if c.Cache != nil {
			c.Cache.Invalidate(ctx, videoID)
		}
		c.Log.InfoContext(ctx, "social video released by its post; deleted", "video_id", videoID, "post_id", d.PostID)
	}
	eventsTotal.WithLabelValues(env.Type, "applied").Inc()
	return ActionAck
}

// Run consumes until ctx is cancelled. It survives the SOCIAL stream not existing yet.
func (c *Consumer) Run(ctx context.Context) error {
	c.defaults()
	warned := false
	for ctx.Err() == nil {
		cons, err := c.JS.CreateOrUpdateConsumer(ctx, Stream, jetstream.ConsumerConfig{
			Durable:        Durable,
			FilterSubjects: []string{SubjectAttached, SubjectReleased},
			AckPolicy:      jetstream.AckExplicitPolicy,
			AckWait:        AckWait,
			MaxDeliver:     MaxDeliver,
		})
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if !warned || !errors.Is(err, jetstream.ErrStreamNotFound) {
				c.Log.Warn("post video consumer not started yet; retrying", "stream", Stream, "error", err, "retry_in", c.RetryEvery.String())
				warned = true
			}
			sleep(ctx, c.RetryEvery)
			continue
		}
		warned = false
		c.Log.Info("consuming post video events", "stream", Stream, "durable", Durable)
		c.consume(ctx, cons)
	}
	return nil
}

// consume returns when ctx is cancelled or the consumer disappears, so Run can set it up again.
func (c *Consumer) consume(ctx context.Context, cons jetstream.Consumer) {
	for ctx.Err() == nil {
		batch, err := cons.Fetch(10, jetstream.FetchMaxWait(5*time.Second))
		if err != nil {
			c.Log.Warn("fetch failed; re-creating the consumer", "error", err)
			sleep(ctx, time.Second)
			return
		}
		n := 0
		for msg := range batch.Messages() {
			c.handle(ctx, msg)
			n++
		}
		if err := batch.Error(); err != nil && gone(err) {
			return
		}
		// An empty pull on a deleted stream does not always fail: ask whether the durable still exists.
		if n == 0 && ctx.Err() == nil {
			if _, err := cons.Info(ctx); err != nil && gone(err) {
				c.Log.Warn("post video consumer is gone; re-creating it", "error", err)
				return
			}
		}
	}
}

func gone(err error) bool {
	return errors.Is(err, jetstream.ErrConsumerNotFound) || errors.Is(err, jetstream.ErrConsumerDeleted) ||
		errors.Is(err, jetstream.ErrStreamNotFound)
}

func (c *Consumer) handle(ctx context.Context, msg jetstream.Msg) {
	switch c.Process(ctx, msg.Data()) {
	case ActionAck:
		_ = msg.Ack()
	case ActionTerm:
		_ = msg.Term()
	case ActionRetry:
		if md, err := msg.Metadata(); err == nil && md.NumDelivered >= MaxDeliver {
			// An unattached video is still caught by the janitor; a released one stays until someone deletes it.
			c.Log.ErrorContext(ctx, "giving up on a post video event after the last delivery", "seq", md.Sequence.Stream)
			_ = msg.Term()
			return
		}
		_ = msg.NakWithDelay(c.NakDelay)
	}
}

// Janitor deletes SOCIAL videos that no post attached within MaxAge of becoming READY (or of being created, for a
// FAILED one). Every replica runs it; rows locked by another replica are skipped.
type Janitor struct {
	Store       Store
	Cache       domain.Cache // optional
	MediaBucket string
	Log         *slog.Logger

	MaxAge   time.Duration // default 48h (ADR-049)
	Interval time.Duration // default 10m
	Batch    int           // videos per transaction, default 100
}

// RunOnce deletes every expired video, one batch at a time, and returns how many it deleted.
func (j *Janitor) RunOnce(ctx context.Context) (int, error) {
	maxAge, batch := j.MaxAge, j.Batch
	if maxAge <= 0 {
		maxAge = 48 * time.Hour
	}
	if batch <= 0 {
		batch = 100
	}
	total := 0
	for ctx.Err() == nil {
		ids, err := j.Store.DeleteUnattachedSocialVideos(ctx, maxAge, batch, j.MediaBucket)
		if err != nil {
			return total, err
		}
		for _, id := range ids {
			if j.Cache != nil {
				j.Cache.Invalidate(ctx, id)
			}
		}
		total += len(ids)
		janitorDeleted.Add(float64(len(ids)))
		if len(ids) < batch {
			break
		}
	}
	return total, ctx.Err()
}

// Run calls RunOnce now and every Interval until ctx is cancelled.
func (j *Janitor) Run(ctx context.Context) error {
	iv := j.Interval
	if iv <= 0 {
		iv = 10 * time.Minute
	}
	t := time.NewTicker(iv)
	defer t.Stop()
	for {
		n, err := j.RunOnce(ctx)
		switch {
		case ctx.Err() != nil:
			return nil
		case err != nil:
			janitorErrors.Inc()
			j.Log.ErrorContext(ctx, "unattached social video janitor failed", "error", err)
		case n > 0:
			j.Log.InfoContext(ctx, "deleted social videos never attached to a post", "count", n)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
