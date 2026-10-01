// Command video is the Winkey video-svc.
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
	"github.com/luantpbk/winkey/services/video/internal/analytics"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/cache"
	"github.com/luantpbk/winkey/services/video/internal/config"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/likes"
	"github.com/luantpbk/winkey/services/video/internal/objects"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/subscriptions"
	"github.com/luantpbk/winkey/services/video/internal/trending"
	"github.com/luantpbk/winkey/services/video/internal/views"
)

const service = "video-svc"

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

	health := obs.NewHealth()
	health.AddCheck("postgres", pool.Ping)
	health.AddCheck("nats", func(context.Context) error {
		if !nc.IsConnected() {
			return errors.New("nats disconnected")
		}
		return nil
	})

	var videoCache domain.Cache
	if cfg.ValkeyURL != "" {
		vc, err := cache.New(cfg.ValkeyURL, cfg.CacheTTL, log)
		if err != nil {
			return fmt.Errorf("valkey: %w", err)
		}
		defer func() { _ = vc.Close() }()
		videoCache = vc
		// The cache fails open, so it is not a readiness dependency.
		log.Info("video cache enabled", "ttl", cfg.CacheTTL.String())
	}

	st := &store.Postgres{Pool: pool}

	s3c, err := s3x.New(s3x.Config{Endpoint: cfg.S3Endpoint, Region: cfg.S3Region, AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretAccessKey})
	if err != nil {
		return fmt.Errorf("object storage: %w", err) // never contains the secret
	}

	proxies, err := views.ParseCIDRs(cfg.TrustProxyCIDRs)
	if err != nil {
		return fmt.Errorf("TRUST_PROXY_CIDRS: %w", err)
	}
	var viewCounter api.ViewCounter
	var viewFlusher *views.Flusher
	var limiter api.Limiter // search rate limits; needs Valkey
	var relatedCache api.RelatedCache
	if cfg.ValkeyURL != "" {
		rc, err := cache.NewClient(cfg.ValkeyURL)
		if err != nil {
			return fmt.Errorf("valkey (views): %w", err)
		}
		defer func() { _ = rc.Close() }()
		vv := views.NewValkey(rc, cfg.ViewDedupTTL)
		viewCounter, limiter = vv, vv
		relatedCache = cache.NewRelated(rc, log)
		viewFlusher = &views.Flusher{V: vv, DB: st, Interval: cfg.ViewFlushInterval, LockTTL: cfg.ViewFlushLockTTL, Log: log}
		log.Info("view counter enabled", "flush_interval", cfg.ViewFlushInterval.String(), "dedup_ttl", cfg.ViewDedupTTL.String())
	} else {
		log.Warn("VALKEY_URL is empty: views are not counted and search is not rate limited")
	}
	var trendingJob *trending.Job
	if cfg.TrendingEnabled {
		trendingJob = &trending.Job{Pool: pool, Interval: cfg.TrendingInterval, Log: log}
	}
	subConsumer := &subscriptions.Consumer{JS: js, Store: st, Log: log}
	var analyticsPub analytics.Publisher
	if cfg.AnalyticsEnabled {
		// A separate JetStream context: bounded in-flight window and an error handler that counts what the stream
		// refused (no stream yet, no space). The main one keeps its defaults.
		ajs, err := jetstream.New(nc, analytics.JetStreamOptions(func(_ string, err error) {
			log.Debug("analytics sample refused by the stream", "error", err)
			analytics.CountPublishError()
		})...)
		if err != nil {
			return fmt.Errorf("jetstream (analytics): %w", err)
		}
		analyticsPub = analytics.NewJetStreamPublisher(ajs)
	} else {
		log.Info("ANALYTICS_ENABLED=false: playback heartbeats are accepted and dropped")
	}
	likeConsumer := &likes.Consumer{JS: js, Store: st, Cache: videoCache, Log: log}

	outbox.SetProducer(service)
	relay := &outbox.Relay{Pool: pool, Publisher: outbox.JetStreamPublisher{JS: js}, Schema: "media", Log: log, Listen: true}

	router := httpx.NewRouter(service, log)
	health.Mount(router)
	(&api.Handler{
		Store: st, Cache: videoCache, RelatedCache: relatedCache, MediaBaseURL: cfg.MediaBaseURL,
		MediaBucket: cfg.MediaBucket, CursorSecret: []byte(cfg.CursorSecret), Log: log,
		MediaLinkSecret: []byte(cfg.MediaLinkSecret), Objects: objects.New(s3c),
		Analytics: analyticsPub, AnalyticsSalt: []byte(cfg.AnalyticsViewerSalt),
		Views: viewCounter, TrustedProxies: proxies, ViewRateLimit: cfg.ViewRateLimit,
		Limiter: limiter, SearchRateLimit: cfg.SearchRateLimit, SuggestRateLimit: cfg.SuggestRateLimit,
	}).Routes(router)

	srv := &http.Server{
		Addr: cfg.HTTPAddr, Handler: router,
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: 120 * time.Second,
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = relay.Run(ctx) }()
	go func() { defer wg.Done(); _ = likeConsumer.Run(ctx) }()
	wg.Add(1)
	go func() { defer wg.Done(); _ = subConsumer.Run(ctx) }()
	if trendingJob != nil {
		wg.Add(1)
		go func() { defer wg.Done(); _ = trendingJob.Run(ctx) }()
	}
	if viewFlusher != nil {
		wg.Add(1)
		go func() { defer wg.Done(); _ = viewFlusher.Run(ctx) }()
	}

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
