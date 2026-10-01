// Command upload is the Winkey upload-svc.
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
	"github.com/luantpbk/winkey/services/upload/internal/api"
	"github.com/luantpbk/winkey/services/upload/internal/config"
	"github.com/luantpbk/winkey/services/upload/internal/janitor"
	"github.com/luantpbk/winkey/services/upload/internal/quota"
	"github.com/luantpbk/winkey/services/upload/internal/storage"
	"github.com/luantpbk/winkey/services/upload/internal/store"
)

const service = "upload-svc"

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

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	defer pool.Close()

	nc, err := nats.Connect(cfg.NATSURL, nats.Name(service), nats.MaxReconnects(-1))
	if err != nil {
		return fmt.Errorf("nats: %w", err)
	}
	defer nc.Close()
	js, err := jetstream.New(nc)
	if err != nil {
		return fmt.Errorf("jetstream: %w", err)
	}

	s3c, err := s3x.New(s3x.Config{
		Endpoint: cfg.S3Endpoint, PublicEndpoint: cfg.S3PublicEndpoint, Region: cfg.S3Region,
		AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretKey,
	})
	if err != nil {
		return fmt.Errorf("s3: %w", err)
	}
	s3 := storage.New(s3c)
	st := &store.Postgres{Pool: pool}

	outbox.SetProducer(service)
	relay := &outbox.Relay{
		Pool: pool, Publisher: outbox.JetStreamPublisher{JS: js}, Schema: "media",
		Log: log, Listen: true,
	}
	jan := &janitor.Janitor{
		Store: st, Storage: s3, Log: log,
		Interval: cfg.JanitorInterval, StaleAfter: cfg.StaleAfter,
	}

	health := obs.NewHealth()
	health.AddCheck("postgres", pool.Ping)
	health.AddCheck("nats", func(context.Context) error {
		if !nc.IsConnected() {
			return errors.New("nats disconnected")
		}
		return nil
	})
	health.AddCheck("s3", func(ctx context.Context) error { return s3.Ping(ctx, cfg.S3RawBucket) })

	router := httpx.NewRouter(service, log)
	health.Mount(router)
	(&api.Handler{
		Store: st, Storage: s3, RawBucket: cfg.S3RawBucket, Log: log,
		Quota: quota.Limits{MaxConcurrent: cfg.MaxConcurrent, DailyCount: cfg.DailyCount, DailyBytes: cfg.DailyBytes},
	}).Routes(router)

	srv := &http.Server{
		Addr: cfg.HTTPAddr, Handler: router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = relay.Run(ctx) }()
	go func() { defer wg.Done(); jan.Run(ctx) }()

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	log.Info("listening", "addr", cfg.HTTPAddr)

	select {
	case err := <-errCh:
		stop()
		wg.Wait()
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err = srv.Shutdown(shutCtx)
	wg.Wait()
	return err
}
