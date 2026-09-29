package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/outbox"
)

// ReplayOptions control ReplayDLQ.
type ReplayOptions struct {
	Max     int    // stop after this many messages (0 = all)
	VideoID string // only replay messages for this video (empty = all)
	DryRun  bool   // list without publishing or acknowledging
}

// ReplayReport summarises a ReplayDLQ run.
type ReplayReport struct {
	Seen     int      // DLQ messages examined
	Matched  int      // messages that passed the filter
	Replayed int      // republished to video.uploaded
	VideoIDs []string // videos of matched messages
}

// ReplayDLQ re-publishes dlq.video.uploaded messages to video.uploaded once a
// fix is deployed. A durable consumer remembers what was replayed: replayed
// messages are acked and not offered again, while the transcoder writes a new
// DLQ copy if they fail again. The re-published message keeps the original
// payload (same event_id: the transcoder is idempotent) but gets a fresh
// Nats-Msg-Id so JetStream's duplicate window does not swallow it.
func ReplayDLQ(ctx context.Context, js jetstream.JetStream, opt ReplayOptions) (ReplayReport, error) {
	var rep ReplayReport
	cons, err := js.CreateOrUpdateConsumer(ctx, StreamDLQ, jetstream.ConsumerConfig{
		Durable:       "replay-dlq",
		FilterSubject: SubjectDLQ,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
	})
	if err != nil {
		return rep, fmt.Errorf("create replay consumer: %w", err)
	}

	seen := map[uint64]bool{}
	for opt.Max == 0 || rep.Matched < opt.Max {
		batch, err := cons.Fetch(10, jetstream.FetchMaxWait(2*time.Second))
		if err != nil {
			return rep, err
		}
		progressed := false
		for msg := range batch.Messages() {
			md, err := msg.Metadata()
			if err != nil {
				_ = msg.Term()
				continue
			}
			if seen[md.Sequence.Stream] {
				_ = msg.Nak()
				continue
			}
			seen[md.Sequence.Stream] = true
			progressed = true
			rep.Seen++

			var env outbox.Envelope
			var ev struct {
				VideoID string `json:"video_id"`
			}
			if json.Unmarshal(msg.Data(), &env) != nil || json.Unmarshal(env.Data, &ev) != nil {
				_ = msg.Nak() // leave malformed messages for a human
				continue
			}
			if (opt.VideoID != "" && ev.VideoID != opt.VideoID) || (opt.Max > 0 && rep.Matched >= opt.Max) {
				_ = msg.Nak()
				continue
			}
			rep.Matched++
			rep.VideoIDs = append(rep.VideoIDs, ev.VideoID)
			if opt.DryRun {
				_ = msg.Nak()
				continue
			}
			out := &nats.Msg{Subject: SubjectUploaded, Data: msg.Data(), Header: nats.Header{}}
			id := fmt.Sprintf("%s:replay:%d", env.EventID, time.Now().UnixNano())
			if _, err := js.PublishMsg(ctx, out, jetstream.WithMsgID(id)); err != nil {
				_ = msg.Nak()
				return rep, fmt.Errorf("republish %s: %w", ev.VideoID, err)
			}
			if err := msg.Ack(); err != nil {
				return rep, err
			}
			rep.Replayed++
		}
		if !progressed {
			break
		}
	}
	return rep, nil
}
