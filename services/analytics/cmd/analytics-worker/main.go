// Command analytics-worker moves analytics.playback events from the JetStream stream ANALYTICS into ClickHouse
// (task R1, ADR-022). It runs on gpu-01 next to ClickHouse.
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
	"github.com/luantpbk/winkey/services/analytics/internal/chdb"
	"github.com/luantpbk/winkey/services/analytics/internal/config"
	"github.com/luantpbk/winkey/services/analytics/internal/migrate"
	"github.com/luantpbk/winkey/services/analytics/internal/reco"
	"github.com/luantpbk/winkey/services/analytics/internal/rollup"
	"github.com/luantpbk/winkey/services/analytics/internal/worker"
)

const service = "analytics-worker"

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

	nc, err := nats.Connect(cfg.NATSURL, nats.Name(service), nats.MaxReconnects(-1))
	if err != nil {
		return fmt.Errorf("nats: %w", err)
	}
	defer nc.Close()
	js, err := jetstream.New(nc)
	if err != nil {
		return fmt.Errorf("jetstream: %w", err)
	}

	conn, err := chdb.Open(chdb.Options{Addr: cfg.ClickHouseAddr, User: cfg.ClickHouseUser, Password: cfg.ClickHousePassword})
	if err != nil {
		return fmt.Errorf("clickhouse: %w", err)
	}
	defer func() { _ = conn.Close() }()

	health := obs.NewHealth()
	health.AddCheck("nats", func(context.Context) error {
		if !nc.IsConnected() {
			return errors.New("nats disconnected")
		}
		return nil
	})
	health.AddCheck("clickhouse", conn.Ping)
	router := httpx.NewRouter(service, log)
	health.Mount(router)
	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: router, ReadHeaderTimeout: 10 * time.Second}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	log.Info("listening", "addr", cfg.HTTPAddr)

	// The schema first. ClickHouse may still be starting (gpu-01 boots both): retry until it answers.
	for {
		applied, err := migrate.Apply(ctx, chdb.Migrations{Conn: conn}, cfg.MigrationsDir, log)
		if err == nil {
			_ = applied
			break
		}
		if ctx.Err() != nil {
			return nil
		}
		log.Warn("clickhouse migrations not applied yet; retrying", "error", err)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(5 * time.Second):
		}
	}

	src := &worker.JetStreamSource{JS: js, Log: log}
	w := &worker.Worker{Source: src, Inserter: &chdb.Inserter{Conn: conn}, Log: log,
		MaxBatch: cfg.BatchMaxMessages, MaxWait: cfg.BatchMaxWait, InsertTimeout: cfg.InsertTimeout}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = w.Run(ctx) }()
	go func() { defer wg.Done(); src.WatchPending(ctx, 30*time.Second) }()

	// The daily rollup for the studio statistics. Its failures never make /readyz fail and never stop ingestion.
	if cfg.RollupEnabled || cfg.RecoEnabled {
		pcfg, err := pgxpool.ParseConfig(cfg.PostgresURL)
		if err != nil {
			return fmt.Errorf("POSTGRES_URL: %w", err)
		}
		pcfg.MaxConns = 4
		pool, err := pgxpool.NewWithConfig(ctx, pcfg) // lazy: PostgreSQL may be unreachable at start
		if err != nil {
			return fmt.Errorf("postgres: %w", err)
		}
		defer pool.Close()
		if cfg.RollupEnabled {
			rr := &rollup.Runner{Source: &rollup.ClickHouse{Conn: conn}, Sink: &rollup.Postgres{Pool: pool}, Log: log,
				Interval: cfg.RollupEvery, WindowDays: cfg.RollupWindow, BackfillDays: cfg.RollupBackfill}
			wg.Add(1)
			go func() { defer wg.Done(); rr.Run(ctx) }()
		}
		if cfg.RecoEnabled {
			rr := &reco.Runner{Source: &reco.ClickHouse{Conn: conn}, Sink: &reco.Postgres{Pool: pool}, Log: log,
				Interval: cfg.RecoEvery, Options: reco.Options{WindowDays: cfg.RecoWindow, MinWatchMs: cfg.RecoMinWatch, Neighbors: cfg.RecoNeighbors, History: cfg.RecoHistory, CoviewMax: cfg.RecoCoviewMax}}
			wg.Add(1)
			go func() { defer wg.Done(); rr.Run(ctx) }()
		}
	}

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
