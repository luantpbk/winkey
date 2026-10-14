package audio

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/outbox"
)

// Consumer parameters (contracts/events/README.md: video.audio_uploaded on the VIDEO stream).
const (
	Stream       = "VIDEO"
	ConsumerName = "transcoder-audio"
	Subject      = "video.audio_uploaded"
	AckWait      = 2 * time.Minute
	heartbeat    = 30 * time.Second
	fetchWait    = 5 * time.Second
)

// Consumer pulls video.audio_uploaded and runs the Job, one message at a time (an audio encode is cheap
// next to a video's). Redeliveries are bounded by MaxDeliveries in the job, not by JetStream, because
// waiting for a video that is still processing must not use them up.
type Consumer struct {
	JS  jetstream.JetStream
	Job *Job
	Log *slog.Logger
}

// Run blocks until ctx is cancelled. A job interrupted by the shutdown is Nak'd and resumes elsewhere.
func (c *Consumer) Run(ctx context.Context) error {
	cons, err := c.JS.CreateOrUpdateConsumer(ctx, Stream, jetstream.ConsumerConfig{
		Durable:       ConsumerName,
		FilterSubject: Subject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       AckWait,
		MaxDeliver:    -1,
	})
	if err != nil {
		return fmt.Errorf("create audio consumer: %w", err)
	}
	for ctx.Err() == nil {
		batch, err := cons.Fetch(1, jetstream.FetchMaxWait(fetchWait))
		if err != nil {
			c.Log.Warn("audio fetch failed", "error", err)
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
			continue
		}
		for msg := range batch.Messages() {
			c.handle(ctx, msg)
		}
	}
	return nil
}

func (c *Consumer) handle(ctx context.Context, msg jetstream.Msg) {
	md, err := msg.Metadata()
	if err != nil {
		c.Log.Error("audio message without metadata; terminating", "error", err)
		_ = msg.Term()
		return
	}
	var env outbox.Envelope
	var ev UploadedEvent
	if err := json.Unmarshal(msg.Data(), &env); err != nil || env.Type != Subject || json.Unmarshal(env.Data, &ev) != nil {
		c.Log.Error("malformed video.audio_uploaded; terminating", "error", err, "seq", md.Sequence.Stream)
		_ = msg.Term()
		return
	}

	// Keep the message ours while the job runs (AckWait is shorter than a long encode).
	hbCtx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		t := time.NewTicker(heartbeat)
		defer t.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-t.C:
				_ = msg.InProgress()
			}
		}
	}()

	res := c.Job.Process(ctx, ev, int(min(md.NumDelivered, uint64(MaxDeliveries))))
	stop()
	switch res.Action {
	case Ack:
		_ = msg.Ack()
	default:
		_ = msg.NakWithDelay(res.Delay)
	}
}
