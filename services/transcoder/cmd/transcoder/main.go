// Command transcoder is the Winkey transcoding worker (ADR-003, ADR-015): a
// standalone pull worker that only opens outbound connections (NATS,
// PostgreSQL, Garage) and runs on Linux or Windows.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/obs"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/services/transcoder/internal/config"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/objects"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
	"github.com/luantpbk/winkey/services/transcoder/internal/worker"
)

const service = "transcoder"

type natsEvents struct{ nc *nats.Conn }

func (n natsEvents) Publish(subject string, data []byte) error { return n.nc.Publish(subject, data) }

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid configuration:\n"+err.Error())
		os.Exit(2)
	}
	log := obs.NewLogger(service, cfg.LogLevel)
	if err := run(cfg, log); err != nil {
		log.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run(cfg config.Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	shutdownTracing, err := obs.SetupTracing(ctx, service)
	if err != nil {
		return fmt.Errorf("tracing: %w", err)
	}
	defer func() { _ = shutdownTracing(context.Background()) }()

	tools := job.Tools{FFmpeg: cfg.FFmpegPath, FFprobe: cfg.FFprobePath}
	encoder, err := tools.ResolveEncoder(ctx, cfg.Encoder)
	if err != nil {
		return err
	}
	concurrency := cfg.WorkerConcurrency
	if concurrency <= 0 {
		concurrency = 1
		if encoder == media.EncoderNVENC {
			concurrency = 2
		}
	}
	if encoder == media.EncoderNVENC && concurrency*3 > 8 {
		log.Warn("WORKER_CONCURRENCY exceeds the GeForce NVENC session limit (about 8 sessions, 3 per job)",
			"concurrency", concurrency)
	}
	host, _ := os.Hostname()
	log.Info("starting", "encoder", encoder, "hwaccel_decode", cfg.HWAccelDecode, "concurrency", concurrency, "worker_id", host,
		"scratch_dir", cfg.ScratchDir, "archive_dir", cfg.ArchiveDir)

	if err := os.MkdirAll(cfg.ScratchDir, 0o755); err != nil {
		return fmt.Errorf("scratch dir: %w", err)
	}
	worker.CleanScratch(cfg.ScratchDir, log)

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	defer pool.Close()

	nc, err := nats.Connect(cfg.NATSURL, nats.Name(service+"@"+host), nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second))
	if err != nil {
		return fmt.Errorf("nats: %w", err)
	}
	defer nc.Close()
	js, err := jetstream.New(nc)
	if err != nil {
		return fmt.Errorf("jetstream: %w", err)
	}

	s3c, err := s3x.New(s3x.Config{
		Endpoint: cfg.S3Endpoint, Region: cfg.S3Region,
		AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretKey,
	})
	if err != nil {
		return fmt.Errorf("s3: %w", err)
	}
	s3 := objects.New(s3c)

	pipeline := &job.Pipeline{
		Store: &store.Postgres{Pool: pool}, Objects: s3, Events: natsEvents{nc}, Tools: tools, Log: log,
		Cfg: job.Config{
			ScratchDir: cfg.ScratchDir, ArchiveDir: cfg.ArchiveDir, MediaBucket: cfg.S3MediaBucket,
			Encoder: encoder, X264Preset: cfg.X264Preset, NoHWDecode: !cfg.HWAccelDecode, UploadParallelism: cfg.UploadParallelism,
			WorkerID: host,
		},
	}

	health := obs.NewHealth()
	health.AddCheck("postgres", pool.Ping)
	health.AddCheck("nats", func(context.Context) error {
		if !nc.IsConnected() {
			return errors.New("nats disconnected")
		}
		return nil
	})
	health.AddCheck("s3", func(ctx context.Context) error { return s3.Ping(ctx, cfg.S3MediaBucket) })
	router := httpx.NewRouter(service, log)
	health.Mount(router)
	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: router, ReadHeaderTimeout: 10 * time.Second}

	outbox.SetProducer(service)
	relay := &outbox.Relay{Pool: pool, Publisher: outbox.JetStreamPublisher{JS: js}, Schema: "media", Log: log, Listen: true}
	consumer := &worker.Consumer{JS: js, Pipeline: pipeline, Concurrency: concurrency, Grace: cfg.ShutdownGrace, Log: log}
	watcher := &worker.Watcher{NC: nc, JS: js, Store: pipeline.Store, Log: log}
	reconciler := &worker.Reconciler{Store: pipeline.Store, Interval: cfg.ReconcileInterval, StaleAfter: cfg.StaleJobAfter, MaxAttempts: cfg.MaxJobAttempts, Log: log}
	janitor := &worker.Janitor{JS: js, Objects: s3, MediaBucket: cfg.S3MediaBucket, RawBucket: cfg.S3RawBucket, Log: log}

	// The watcher must be subscribed before the consumer starts pulling: the
	// max-deliveries advisory is emitted when a puller asks for messages.
	if err := watcher.Start(ctx); err != nil {
		return err
	}

	var wg sync.WaitGroup
	errs := make(chan error, 6)
	start := func(name string, fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil && ctx.Err() == nil {
				errs <- fmt.Errorf("%s: %w", name, err)
				stop()
			}
		}()
	}
	start("http", func() error {
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	})
	start("outbox relay", func() error { return relay.Run(ctx) })
	start("consumer", func() error { return consumer.Run(ctx) })
	start("media janitor", func() error { return janitor.Run(ctx) })
	start("max-deliveries watcher", func() error { return watcher.Run(ctx) })
	start("stuck-job reconciler", func() error { return reconciler.Run(ctx) })

	<-ctx.Done()
	log.Info("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace+10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
	wg.Wait()
	select {
	case err := <-errs:
		return err
	default:
		return nil
	}
}
