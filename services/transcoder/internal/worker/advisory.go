package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// MaxDeliveriesSubject returns the core-NATS subject on which JetStream
// announces that a message of the consumer reached max_deliver without being
// acknowledged (worker died repeatedly, or the last delivery ended in a Nak).
func MaxDeliveriesSubject(stream, consumer string) string {
	return "$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES." + stream + "." + consumer
}

// Advisory is the part of the max-deliveries advisory we use
// (type io.nats.jetstream.advisory.v1.max_deliver).
type Advisory struct {
	Stream     string `json:"stream"`
	Consumer   string `json:"consumer"`
	StreamSeq  uint64 `json:"stream_seq"`
	Deliveries uint64 `json:"deliveries"`
}

// GaveUpFailure is recorded for videos whose message JetStream gave up on.
var GaveUpFailure = job.GaveUpFailure

// Watcher closes the gap left by the consumer: when every delivery of a
// message ends without an ack (worker crash, power loss, lost heartbeat),
// nothing runs on the last delivery, so the video would stay PROCESSING
// forever and the owner would never hear about it. On the advisory the watcher
// loads the original message from the stream, fails the video (job FAILED,
// video FAILED, video.failed in the outbox) and copies the message to
// dlq.video.uploaded for replay-dlq. It is idempotent, so it may run in every
// worker and see the same advisory more than once.
//
// Advisories are core-NATS (not persisted) and are emitted when a puller asks
// for messages after the last ack_wait expired, so they arrive when a worker
// is running. One published while no watcher is subscribed is missed; such a
// video stays PROCESSING until an operator resets or replays it.
type Watcher struct {
	NC       *nats.Conn
	JS       jetstream.JetStream
	Store    job.Store
	Stream   string // default StreamVideo
	Consumer string // default ConsumerName
	Log      *slog.Logger

	// GetMsg loads a stream message by sequence; defaults to a JetStream lookup.
	GetMsg func(ctx context.Context, seq uint64) (subject string, data []byte, err error)
	// DLQ publishes the copy; defaults to publishDLQ on JS.
	DLQ func(ctx context.Context, data []byte, eventID string) bool

	sub *nats.Subscription
}

// Start subscribes to the advisory and returns once the server has the
// subscription (so no later advisory can be missed). Call it before starting
// the consumer: JetStream emits the advisory when a puller asks for messages
// after the last ack_wait expired, which is exactly when a worker starts up.
func (w *Watcher) Start(ctx context.Context) error {
	if w.Stream == "" {
		w.Stream = StreamVideo
	}
	if w.Consumer == "" {
		w.Consumer = ConsumerName
	}
	if w.GetMsg == nil {
		w.GetMsg = w.getFromStream
	}
	if w.DLQ == nil {
		w.DLQ = func(ctx context.Context, data []byte, eventID string) bool {
			return publishDLQ(ctx, w.JS, w.Log, data, eventID)
		}
	}
	sub, err := w.NC.Subscribe(MaxDeliveriesSubject(w.Stream, w.Consumer), func(m *nats.Msg) {
		w.HandleAdvisory(ctx, m.Data)
	})
	if err != nil {
		return fmt.Errorf("subscribe max-deliveries advisory: %w", err)
	}
	if err := w.NC.Flush(); err != nil {
		_ = sub.Unsubscribe()
		return fmt.Errorf("flush advisory subscription: %w", err)
	}
	w.sub = sub
	return nil
}

// Run blocks until ctx is cancelled, then unsubscribes. Start must have been
// called.
func (w *Watcher) Run(ctx context.Context) error {
	if w.sub == nil {
		return fmt.Errorf("watcher not started")
	}
	<-ctx.Done()
	return w.sub.Unsubscribe()
}

func (w *Watcher) getFromStream(ctx context.Context, seq uint64) (string, []byte, error) {
	s, err := w.JS.Stream(ctx, w.Stream)
	if err != nil {
		return "", nil, err
	}
	m, err := s.GetMsg(ctx, seq)
	if err != nil {
		return "", nil, err
	}
	return m.Subject, m.Data, nil
}

// HandleAdvisory processes one advisory payload.
func (w *Watcher) HandleAdvisory(ctx context.Context, payload []byte) {
	var adv Advisory
	if err := json.Unmarshal(payload, &adv); err != nil || adv.StreamSeq == 0 {
		w.Log.Warn("unreadable max-deliveries advisory", "error", err)
		return
	}
	log := w.Log.With("stream_seq", adv.StreamSeq, "deliveries", adv.Deliveries)
	log.Debug("max-deliveries advisory received", "consumer", adv.Consumer)

	subject, data, err := w.GetMsg(ctx, adv.StreamSeq)
	if err != nil {
		// The message may have aged out of the stream (max age 7d) or the
		// server is briefly unavailable; there is nothing else to key on.
		log.Error("cannot load message behind max-deliveries advisory", "error", err)
		return
	}
	if subject != SubjectUploaded {
		return // the advisory is per consumer, but stay defensive
	}
	var env outbox.Envelope
	var ev job.UploadedEvent
	if json.Unmarshal(data, &env) != nil || json.Unmarshal(env.Data, &ev) != nil {
		log.Error("malformed video.uploaded behind advisory")
		return
	}
	videoID, err := uuid.Parse(ev.VideoID)
	if err != nil {
		log.Error("video.uploaded with invalid video_id behind advisory")
		return
	}

	rec, ok, err := w.Store.FailStuck(ctx, videoID, GaveUpFailure)
	if err != nil {
		log.Error("fail stuck video", "video_id", videoID, "error", err)
		return
	}
	if !ok {
		log.Info("max-deliveries advisory: video already resolved", "video_id", videoID)
		return
	}
	log.Warn("gave up on video after max deliveries", "video_id", videoID, "job_id", rec.JobID, "attempt", rec.Attempt)
	w.DLQ(ctx, data, env.EventID)
}
