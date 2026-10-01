// Command storyboard-backfill makes the seek-preview storyboard (task V5a) of READY videos that
// have none (task V5a-b). It is a one-shot CLI that is safe to re-run or interrupt: a second run
// selects only the videos that still have no storyboard.
//
//	storyboard-backfill -dry-run        list what would be done, write nothing
//	storyboard-backfill                 make up to BACKFILL_LIMIT storyboards
//
// Exit code: 0 when the run finished (per-video failures are only counted), 1 on a configuration,
// database or object-storage connection error.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/obs"
	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/services/transcoder/internal/backfill"
	"github.com/luantpbk/winkey/services/transcoder/internal/config"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/objects"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

const service = "storyboard-backfill"

func main() {
	dry := flag.Bool("dry-run", false, "list what would be done without downloading, uploading or writing")
	flag.Parse()

	cfg, err := config.LoadBackfill()
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid configuration:\n"+err.Error())
		os.Exit(1)
	}
	log := obs.NewLogger(service, cfg.LogLevel)
	if err := run(cfg, *dry, log); err != nil {
		log.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run(cfg config.Backfill, dry bool, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	s3c, err := s3x.New(s3x.Config{
		Endpoint: cfg.S3Endpoint, Region: cfg.S3Region,
		AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretKey,
	})
	if err != nil {
		return fmt.Errorf("s3: %w", err)
	}
	s3 := objects.New(s3c)
	if err := s3.Ping(ctx, cfg.S3MediaBucket); err != nil {
		return fmt.Errorf("s3: %w", err)
	}

	tools := job.Tools{FFmpeg: cfg.FFmpegPath}
	r := &backfill.Runner{
		Store: &store.Postgres{Pool: pool}, Objects: s3, Storyboard: tools.Storyboard, Log: log,
		Opt: backfill.Options{
			Limit: cfg.Limit, Concurrency: cfg.Concurrency, DryRun: dry,
			MediaBucket: cfg.S3MediaBucket, ScratchDir: cfg.ScratchDir,
		},
	}
	log.Info("starting", "dry_run", dry, "limit", cfg.Limit, "concurrency", cfg.Concurrency, "scratch_dir", cfg.ScratchDir)
	sum, err := r.Run(ctx)
	fmt.Println(sum.Line(dry))
	return err
}
