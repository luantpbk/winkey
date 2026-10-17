// Command reencode encodes READY videos again into the current HLS layout (ADR-042 addendum 2026-10-17:
// video-only variants plus an original-audio rendition, which hls.js can switch with extra audio tracks).
// It runs the worker's own pipeline in process, one video at a time, with the worker's environment file;
// the outbox relay of the running worker publishes the video.ready events.
//
//	reencode -dry-run              list the READY videos whose master still has the legacy layout
//	reencode                       re-encode all of them
//	reencode -ids <uuid>,<uuid>    only these videos (also when already in the current layout, with -force)
//
// Each selected video goes back to PROCESSING (no playback) until its new attempt is READY; its AV1 set is
// dropped (old layout) and is rebuilt by the next av1-upgrade run. Exit code: 0 when the run finished
// (per-video failures are counted), 1 on a configuration or connection error.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/libs/go/obs"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/services/transcoder/internal/config"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/objects"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

const (
	service  = "transcoder" // the producer of the video.ready events it enqueues, as for the worker
	attempts = 3
)

func main() {
	dry := flag.Bool("dry-run", false, "list what would be re-encoded, change nothing")
	idList := flag.String("ids", "", "comma-separated video ids (default: every READY video with a legacy master)")
	force := flag.Bool("force", false, "with -ids: re-encode even when the master already has the current layout")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid configuration:\n"+err.Error())
		os.Exit(1)
	}
	var ids []uuid.UUID
	for _, s := range strings.Split(*idList, ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		id, err := uuid.Parse(s)
		if err != nil {
			fmt.Fprintf(os.Stderr, "invalid video id %q\n", s)
			os.Exit(1)
		}
		ids = append(ids, id)
	}
	log := obs.NewLogger("reencode", cfg.LogLevel)
	if err := run(cfg, ids, *dry, *force && len(ids) > 0, log); err != nil {
		log.Error("fatal", "error", err)
		os.Exit(1)
	}
}

type noEvents struct{}

func (noEvents) Publish(string, []byte) error { return nil } // progress is for the studio; nobody watches here

func run(cfg config.Config, ids []uuid.UUID, dry, force bool, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	outbox.SetProducer(service)

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
	if err := os.MkdirAll(cfg.ScratchDir, 0o750); err != nil {
		return fmt.Errorf("scratch dir: %w", err)
	}

	st := &store.Postgres{Pool: pool}
	cands, err := st.SelectReencode(ctx, ids)
	if err != nil {
		return err
	}
	var todo []store.ReencodeCandidate
	for _, c := range cands {
		legacy, err := legacyMaster(ctx, s3, cfg.S3MediaBucket, cfg.ScratchDir, c.MasterKey)
		if err != nil {
			log.Warn("cannot read the master; skipped", "video_id", c.ID, "error", err)
			continue
		}
		if legacy || force {
			todo = append(todo, c)
		}
	}
	log.Info("selected", "ready", len(cands), "to_reencode", len(todo), "dry_run", dry)
	if dry {
		for _, c := range todo {
			fmt.Println(c.ID)
		}
		fmt.Printf("summary: ready=%d would_reencode=%d dry_run=true\n", len(cands), len(todo))
		return nil
	}

	tools := job.Tools{FFmpeg: cfg.FFmpegPath, FFprobe: cfg.FFprobePath}
	encoder, err := tools.ResolveEncoder(ctx, cfg.Encoder)
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	pipeline := &job.Pipeline{
		Store: st, Objects: s3, Events: noEvents{}, Tools: tools, Log: log,
		Cfg: job.Config{
			ScratchDir: cfg.ScratchDir, ArchiveDir: "", MediaBucket: cfg.S3MediaBucket,
			Encoder: encoder, X264Preset: cfg.X264Preset,
			RateControl: cfg.RateControl, X264CRF: cfg.X264CRF, NVENCCQ: cfg.NVENCCQ,
			NoHWDecode: !cfg.HWAccelDecode, UploadParallelism: cfg.UploadParallelism,
			WorkerID: host + "/reencode",
		},
	}

	start := time.Now()
	done, failed := 0, 0
	for _, c := range todo {
		if ctx.Err() != nil {
			break
		}
		if reencode(ctx, st, pipeline, s3, cfg.S3MediaBucket, c.ID, log) {
			done++
		} else {
			failed++
		}
	}
	fmt.Printf("summary: selected=%d done=%d failed=%d duration=%s\n", len(todo), done, failed, time.Since(start).Round(time.Second))
	return nil
}

func reencode(ctx context.Context, st *store.Postgres, p *job.Pipeline, s3 *objects.S3, bucket string, id uuid.UUID, log *slog.Logger) bool {
	log = log.With("video_id", id)
	ev, av1Prefix, ok, err := st.BeginReencode(ctx, id)
	if err != nil || !ok {
		log.Warn("not re-encoded (gone or no longer READY)", "error", err)
		return false
	}
	for n := 1; n <= attempts; n++ {
		res := p.Process(ctx, ev, job.Delivery{Num: n, Max: attempts})
		switch res.Action {
		case job.ActionAck:
			if av1Prefix != "" {
				dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
				if err := s3.DeletePrefix(dctx, bucket, av1Prefix); err != nil {
					log.Warn("old AV1 set not deleted", "prefix", av1Prefix, "error", err)
				}
				cancel()
			}
			log.Info("re-encoded")
			return true
		case job.ActionNak:
			log.Warn("transient failure; retrying", "attempt", n, "error", res.Err)
			if ctx.Err() != nil {
				return false
			}
			select {
			case <-ctx.Done():
				return false
			case <-time.After(res.Delay):
			}
		default:
			log.Error("re-encode failed (the video is FAILED; see the job error)", "error", res.Err)
			return false
		}
	}
	log.Error("re-encode failed after retries; the reconciler fails the stuck job")
	return false
}

// legacyMaster reports whether the master at key still has the legacy layout (no original-audio rendition).
func legacyMaster(ctx context.Context, s3 *objects.S3, bucket, scratch, key string) (bool, error) {
	f, err := os.CreateTemp(scratch, "reencode-master-*.m3u8")
	if err != nil {
		return false, err
	}
	path := f.Name()
	_ = f.Close()
	defer func() { _ = os.Remove(path) }()
	if err := s3.Download(ctx, bucket, key, path); err != nil {
		return false, err
	}
	data, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return false, err
	}
	if len(data) == 0 {
		return false, errors.New("empty master")
	}
	return !strings.Contains(string(data), `URI="`+hlsmaster.OriginalAudioURI+`"`), nil
}
