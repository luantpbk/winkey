// Package worker binds the pipeline to NATS JetStream.
package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// Consumer parameters from contracts/events/README.md.
const (
	StreamVideo     = "VIDEO"
	StreamDLQ       = "DLQ"
	ConsumerName    = "transcoder"
	SubjectUploaded = "video.uploaded"
	SubjectDLQ      = "dlq.video.uploaded"
	AckWait         = 2 * time.Minute
	MaxDeliver      = 3
	HeartbeatEvery  = 30 * time.Second
	fetchWait       = 5 * time.Second
)

var (
	jobsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "transcoder_jobs_total", Help: "Processed video.uploaded messages by outcome.",
	}, []string{"outcome"})
	jobsInFlight = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "transcoder_jobs_in_flight", Help: "Jobs currently being processed.",
	})
	realtimeRatio = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "transcoder_encode_realtime_ratio", Help: "Media seconds encoded per wall second.",
		Buckets: []float64{0.5, 1, 2, 4, 6, 8, 12, 16, 24, 32},
	}, []string{"encoder"})
)

// Consumer pulls video.uploaded and runs the pipeline.
type Consumer struct {
	JS          jetstream.JetStream
	Pipeline    *job.Pipeline
	Concurrency int
	Grace       time.Duration // running jobs get this long after shutdown starts (default 30s)
	Log         *slog.Logger
}

// Run blocks until ctx is cancelled and every worker has finished. On
// cancellation it stops fetching, lets running jobs finish for Grace, then
// cancels them; cancelled jobs are Nak'd (Process maps interruption to Nak).
func (c *Consumer) Run(ctx context.Context) error {
	cons, err := c.JS.CreateOrUpdateConsumer(ctx, StreamVideo, jetstream.ConsumerConfig{
		Durable:       ConsumerName,
		FilterSubject: SubjectUploaded,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       AckWait,
		MaxDeliver:    MaxDeliver,
		// No Backoff: it would override AckWait and fight the heartbeat.
	})
	if err != nil {
		return fmt.Errorf("create consumer: %w", err)
	}
	grace := c.Grace
	if grace <= 0 {
		grace = 30 * time.Second
	}
	n := max(1, c.Concurrency)

	jobCtx, cancelJobs := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelJobs()

	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.loop(ctx, jobCtx, cons)
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()

	select {
	case <-done:
	case <-ctx.Done():
		c.Log.Info("shutdown: waiting for running jobs", "grace", grace.String())
		select {
		case <-done:
		case <-time.After(grace):
			c.Log.Warn("shutdown grace expired; interrupting running jobs")
			cancelJobs()
			<-done
		}
	}
	return nil
}

func (c *Consumer) loop(fetchCtx, jobCtx context.Context, cons jetstream.Consumer) {
	for fetchCtx.Err() == nil {
		batch, err := cons.Fetch(1, jetstream.FetchMaxWait(fetchWait))
		if err != nil {
			c.Log.Warn("fetch failed", "error", err)
			sleep(fetchCtx, time.Second)
			continue
		}
		for msg := range batch.Messages() {
			if fetchCtx.Err() != nil { // shutting down: hand it straight back
				_ = msg.Nak()
				continue
			}
			c.handle(jobCtx, msg)
		}
		if err := batch.Error(); err != nil {
			c.Log.Debug("fetch batch ended", "error", err)
		}
	}
}

func (c *Consumer) handle(ctx context.Context, msg jetstream.Msg) {
	md, err := msg.Metadata()
	if err != nil {
		c.Log.Error("message without metadata; terminating", "error", err)
		_ = msg.Term()
		return
	}
	d := job.Delivery{Num: int(md.NumDelivered), Max: MaxDeliver}

	var env outbox.Envelope
	var ev job.UploadedEvent
	if err := json.Unmarshal(msg.Data(), &env); err != nil || env.Type != SubjectUploaded ||
		json.Unmarshal(env.Data, &ev) != nil {
		c.Log.Error("malformed video.uploaded; terminating", "error", err, "seq", md.Sequence.Stream)
		jobsTotal.WithLabelValues("malformed").Inc()
		_ = msg.Term()
		return
	}
	if env.Version != 1 {
		// Consumers ignore versions they do not know.
		c.Log.Warn("unknown video.uploaded version; skipping", "version", env.Version)
		_ = msg.Term()
		return
	}

	// The pipeline sends InProgress (and stamps heartbeat_at) every HeartbeatEvery
	// while the job runs, so JetStream and the reconciler both see it is alive.
	d.InProgress = msg.InProgress
	jobsInFlight.Inc()
	res := c.Pipeline.Process(ctx, ev, d)
	jobsInFlight.Dec()

	observeResult(res)
	if res.Stats != nil && res.Stats.MediaSec > 0 {
		realtimeRatio.WithLabelValues(res.Stats.Encoder).Observe(res.Stats.XRealtime())
	}
	c.apply(ctx, msg, env, res)
}

func (c *Consumer) apply(ctx context.Context, msg jetstream.Msg, env outbox.Envelope, res job.Result) {
	switch res.Action {
	case job.ActionAck:
		jobsTotal.WithLabelValues("ack").Inc()
		if err := msg.Ack(); err != nil {
			c.Log.Error("ack failed", "error", err)
		}
	case job.ActionNak:
		jobsTotal.WithLabelValues("nak").Inc()
		if err := msg.NakWithDelay(res.Delay); err != nil {
			c.Log.Error("nak failed", "error", err)
		}
	case job.ActionTerm:
		jobsTotal.WithLabelValues("term").Inc()
		if err := msg.Term(); err != nil {
			c.Log.Error("term failed", "error", err)
		}
	case job.ActionTermDLQ:
		jobsTotal.WithLabelValues("term_dlq").Inc()
		c.toDLQ(ctx, msg, env)
		if err := msg.Term(); err != nil {
			c.Log.Error("term failed", "error", err)
		}
	}
}

// toDLQ copies the original message to dlq.video.uploaded for the replay tool.
func (c *Consumer) toDLQ(ctx context.Context, msg jetstream.Msg, env outbox.Envelope) {
	publishDLQ(ctx, c.JS, c.Log, msg.Data(), env.EventID)
}

// publishDLQ publishes data to dlq.video.uploaded. The Nats-Msg-Id is derived
// from the event id, so the consumer path and the max-deliveries watcher
// cannot create two copies within JetStream's duplicate window.
func publishDLQ(ctx context.Context, js jetstream.JetStream, log *slog.Logger, data []byte, eventID string) bool {
	out := &nats.Msg{Subject: SubjectDLQ, Data: data, Header: nats.Header{}}
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		_, err = js.PublishMsg(pctx, out, jetstream.WithMsgID(eventID+":dlq"))
		cancel()
		if err == nil {
			return true
		}
		time.Sleep(time.Second)
	}
	log.Error("DLQ copy failed; message will be lost", "event_id", eventID, "error", err)
	return false
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
