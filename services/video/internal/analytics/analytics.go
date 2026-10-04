// Package analytics builds and publishes the analytics.playback events of task R1 (ADR-022): one event per
// accepted player sample, published DIRECTLY to the JetStream stream ANALYTICS (telemetry, a deliberate exception
// to the outbox of ADR-008: an outbox would turn every heartbeat into a PostgreSQL write).
//
// Privacy. The event never holds an IP address or a user agent. The viewer is identified by
// viewer_key = hex(HMAC-SHA256(ANALYTICS_VIEWER_SALT, viewer)), where viewer is "u:<user id>" or the anonymous
// hash of the view counter (C3); the salt is a secret of video-svc, so ClickHouse never holds a user id in clear.
package analytics

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/libs/go/outbox"
)

// Event constants (contracts/events/analytics.playback.schema.json).
const (
	Subject  = "analytics.playback"
	Producer = "video-svc"
	Version  = 1
)

// Namespace is the fixed UUID under which event ids are derived: event_id = UUIDv5(Namespace, "<playback_id>:<seq>").
// It is part of the contract with the deduplication of JetStream and ClickHouse; never change it.
var Namespace = uuid.MustParse("7c1f6a2e-4b9d-5e83-a0d4-2f8b1c6e9a35")

// EventID is the id of the sample seq of a playback: the same for a sample the client sends again, so JetStream
// (Nats-Msg-Id) and ClickHouse collapse the copies.
func EventID(playbackID uuid.UUID, seq int) uuid.UUID {
	return uuid.NewSHA1(Namespace, []byte(playbackID.String()+":"+strconv.Itoa(seq)))
}

// ViewerKey is hex(HMAC-SHA256(salt, viewer)): 64 lower-case hex characters, stable for the same viewer and salt.
func ViewerKey(salt []byte, viewer string) string {
	m := hmac.New(sha256.New, salt)
	m.Write([]byte(viewer))
	return hex.EncodeToString(m.Sum(nil))
}

// Sample is one validated player sample (PlaybackSample of video.v1.yaml).
type Sample struct {
	PlaybackID    uuid.UUID
	VideoID       uuid.UUID
	Kind          string // start | heartbeat | end
	Seq           int
	SentAt        time.Time
	PositionMs    int
	WatchedMs     int
	RebufferMs    int
	RebufferCount int
	StartupMs     *int
	Rendition     *string
	BitrateKbps   *int
	ErrorCode     *string
	Client        string // web | ios | android | other
}

// data is the `data` of analytics.playback v1; every field of the schema is present (nullable ones as null).
type data struct {
	PlaybackID    string  `json:"playback_id"`
	VideoID       string  `json:"video_id"`
	OwnerID       string  `json:"owner_id"`
	ViewerKey     string  `json:"viewer_key"`
	Authenticated bool    `json:"authenticated"`
	Kind          string  `json:"kind"`
	Seq           int     `json:"seq"`
	ReceivedAt    string  `json:"received_at"`
	SentAt        string  `json:"sent_at"`
	PositionMs    int     `json:"position_ms"`
	WatchedMs     int     `json:"watched_ms"`
	RebufferMs    int     `json:"rebuffer_ms"`
	RebufferCount int     `json:"rebuffer_count"`
	StartupMs     *int    `json:"startup_ms"`
	Rendition     *string `json:"rendition"`
	BitrateKbps   *int    `json:"bitrate_kbps"`
	ErrorCode     *string `json:"error_code"`
	Client        string  `json:"client"`
	Country       *string `json:"country"` // reserved (GeoIP later): null in v1
}

// Message is what is published: the JetStream message id and the JSON payload.
type Message struct {
	ID      string // Nats-Msg-Id = event_id
	Payload []byte
}

// Build makes the event of a sample. ownerID is the channel of the video at receive time, viewerKey comes from
// ViewerKey, now is the receive time (UTC, used by ClickHouse for bucketing).
func Build(s Sample, ownerID uuid.UUID, viewerKey string, authenticated bool, now time.Time) (Message, error) {
	id := EventID(s.PlaybackID, s.Seq)
	now = now.UTC().Truncate(time.Millisecond)
	env := outbox.Envelope{
		EventID: id.String(), Type: Subject, Version: Version, OccurredAt: now, Producer: Producer,
	}
	var err error
	env.Data, err = json.Marshal(data{
		PlaybackID: s.PlaybackID.String(), VideoID: s.VideoID.String(), OwnerID: ownerID.String(),
		ViewerKey: viewerKey, Authenticated: authenticated, Kind: s.Kind, Seq: s.Seq,
		ReceivedAt: now.Format(time.RFC3339Nano), SentAt: s.SentAt.UTC().Format(time.RFC3339Nano),
		PositionMs: s.PositionMs, WatchedMs: s.WatchedMs, RebufferMs: s.RebufferMs, RebufferCount: s.RebufferCount,
		StartupMs: s.StartupMs, Rendition: s.Rendition, BitrateKbps: s.BitrateKbps, ErrorCode: s.ErrorCode, Client: s.Client,
	})
	if err != nil {
		return Message{}, err
	}
	payload, err := json.Marshal(env)
	if err != nil {
		return Message{}, err
	}
	return Message{ID: id.String(), Payload: payload}, nil
}

// SamplesTotal counts player samples by result: published (handed to the stream client), dropped_invalid_video (the
// video is unknown or not readable by the caller), publish_error (refused when handed over, or later by the stream:
// no stream, no space, timeout; such a sample was counted as published first), dropped_lookup_error (the video lookup
// failed and the batch was dropped).
var SamplesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "video_analytics_samples_total", Help: "Player samples by result.",
}, []string{"result"})

// CountPublishError is called for a message the stream did not accept after it was handed over.
func CountPublishError() { SamplesTotal.WithLabelValues("publish_error").Inc() }

// Publisher hands an event to the stream. Publish never blocks for long and reports a failure to hand it over; the
// caller drops the sample and counts it (a publish error is never an error for the player).
type Publisher interface {
	Publish(ctx context.Context, m Message) error
}

// ErrDropped is returned by publishers that refuse a message without trying (the window is full).
var ErrDropped = errors.New("analytics: publish window full")

// JetStreamPublisher publishes asynchronously with a bounded number of unacknowledged messages in flight: a handler
// only waits to put the message on the wire, never for the stream's acknowledgement. Acknowledgement failures (no
// stream, no space, timeout) arrive later through OnError.
type JetStreamPublisher struct {
	js jetstream.JetStream
}

// NewJetStreamPublisher wraps js, which must have been created with WithPublishAsyncMaxPending and
// WithPublishAsyncErrHandler (see JetStreamOptions).
func NewJetStreamPublisher(js jetstream.JetStream) *JetStreamPublisher {
	return &JetStreamPublisher{js: js}
}

// MaxInFlight is the window of unacknowledged messages.
const MaxInFlight = 2000

// JetStreamOptions returns the options to create the JetStream context the publisher needs: a bounded in-flight
// window that fails fast instead of stalling requests, and onError called for a message the stream did not accept.
func JetStreamOptions(onError func(msgID string, err error)) []jetstream.JetStreamOpt {
	return []jetstream.JetStreamOpt{
		jetstream.WithPublishAsyncMaxPending(MaxInFlight),
		jetstream.WithPublishAsyncErrHandler(func(_ jetstream.JetStream, msg *nats.Msg, err error) {
			onError(msg.Header.Get(nats.MsgIdHdr), err)
		}),
	}
}

func (p *JetStreamPublisher) Publish(_ context.Context, m Message) error {
	msg := &nats.Msg{Subject: Subject, Data: m.Payload, Header: nats.Header{}}
	msg.Header.Set(nats.MsgIdHdr, m.ID)
	if _, err := p.js.PublishMsgAsync(msg); err != nil {
		if errors.Is(err, jetstream.ErrTooManyStalledMsgs) {
			return fmt.Errorf("%w: %w", ErrDropped, err)
		}
		return err
	}
	return nil
}
