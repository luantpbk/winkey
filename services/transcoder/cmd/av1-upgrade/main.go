// Command av1-upgrade adds the separate AV1 HLS set (task ENC2 phase 2, ADR-041) to the most watched READY
// videos: those without one whose playback starts over the last 7 days reach AV1_MIN_STARTS_7D, most watched
// first, at most AV1_UPGRADE_LIMIT per run. With AV1_TOP_N=N (AV1POL, ADR-048) only the N most watched videos
// are upgraded, sets of videos ranked beyond AV1_KEEP_TOP are dropped from the database, and the objects of
// sets dropped by an earlier run are deleted. It is a one-shot CLI for an off-peak schedule on gpu-01, safe to
// re-run or interrupt: a second run selects only the videos that still have no AV1 set.
//
//	av1-upgrade -dry-run        list what would be encoded, write nothing
//	av1-upgrade                 encode and commit up to AV1_UPGRADE_LIMIT AV1 sets
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
	"github.com/luantpbk/winkey/services/transcoder/internal/av1up"
	"github.com/luantpbk/winkey/services/transcoder/internal/config"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/objects"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

const service = "av1-upgrade"

func main() {
	dry := flag.Bool("dry-run", false, "list what would be encoded without downloading, uploading or writing")
	flag.Parse()

	cfg, err := config.LoadAV1Upgrade()
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid configuration:\n"+err.Error())
		os.Exit(1)
	}
	topN, err := av1up.ParseTopN(cfg.TopN)
	if err == nil && topN != av1up.AllVideos && cfg.KeepTop != 0 && cfg.KeepTop < topN {
		err = fmt.Errorf("AV1_KEEP_TOP (%d) must be >= AV1_TOP_N (%d)", cfg.KeepTop, topN)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid configuration:\n"+err.Error())
		os.Exit(1)
	}
	log := obs.NewLogger(service, cfg.LogLevel)
	if err := run(cfg, topN, *dry, log); err != nil {
		log.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run(cfg config.AV1Upgrade, topN int, dry bool, log *slog.Logger) error {
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

	st := &store.Postgres{Pool: pool}
	r := &av1up.Runner{
		Store: st, Policy: st, Objects: s3, Log: log,
		Media: job.Tools{FFmpeg: cfg.AV1FFmpegPath, FFprobe: cfg.FFprobePath},
		Opt: av1up.Options{
			MinStarts: cfg.MinStarts7d, Limit: cfg.Limit, DryRun: dry,
			MediaBucket: cfg.S3MediaBucket, ScratchDir: cfg.ScratchDir,
			CQ: cfg.CQ, MaxratePct: cfg.MaxratePct, NoHWDecode: !cfg.HWAccelDecode,
			TopN: topN, KeepTop: av1up.KeepTop(topN, cfg.KeepTop),
		},
	}
	log.Info("starting", "dry_run", dry, "min_starts_7d", cfg.MinStarts7d, "limit", cfg.Limit, "scratch_dir", cfg.ScratchDir,
		"top_n", cfg.TopN, "keep_top", r.Opt.KeepTop)
	sum, err := r.Run(ctx)
	fmt.Println(sum.Line(dry))
	return err
}
