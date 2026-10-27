// Command storage-gc inventories the media and raw buckets against the database (task STOR1): bytes per
// bucket and per category, stale multipart uploads, and the largest videos. By default it changes nothing.
//
//	storage-gc                                     report only
//	storage-gc -apply media-orphan-video,raw-orphan-video   delete those categories (see the report's *)
//	storage-gc -apply all -abort-uploads           delete every garbage category and abort stale uploads
//
// It uses the worker's environment file (DATABASE_URL, S3_*). Objects younger than -min-age are never
// judged, so an encode or upload in progress is safe. Exit code: 0 on success, 1 on any error.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/services/transcoder/internal/config"
	"github.com/luantpbk/winkey/services/transcoder/internal/storagegc"
)

func main() {
	apply := flag.String("apply", "", "comma-separated categories to delete, or 'all' (default: report only)")
	abort := flag.Bool("abort-uploads", false, "with -apply: also abort stale multipart uploads of the raw bucket")
	minAge := flag.Duration("min-age", 48*time.Hour, "never judge objects younger than this")
	top := flag.Int("top", 20, "how many of the largest videos to list")
	flag.Parse()

	cats := map[storagegc.Category]bool{}
	for _, s := range strings.Split(*apply, ",") {
		switch s = strings.TrimSpace(s); {
		case s == "":
		case s == "all":
			for _, c := range storagegc.Deletable {
				cats[c] = true
			}
		case storagegc.IsDeletable(storagegc.Category(s)):
			cats[storagegc.Category(s)] = true
		default:
			fmt.Fprintf(os.Stderr, "unknown or non-deletable category %q\n", s)
			os.Exit(1)
		}
	}
	if *minAge < 24*time.Hour {
		fmt.Fprintln(os.Stderr, "-min-age below 24h is refused: it could judge an encode or upload in progress")
		os.Exit(1)
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid configuration:\n"+err.Error())
		os.Exit(1)
	}
	if err := run(cfg, cats, *abort, *minAge, *top); err != nil {
		fmt.Fprintln(os.Stderr, "storage-gc:", err)
		os.Exit(1)
	}
}

func run(cfg config.Config, cats map[storagegc.Category]bool, abort bool, minAge time.Duration, top int) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	defer pool.Close()
	s3c, err := s3x.New(s3x.Config{
		Endpoint: cfg.S3Endpoint, Region: cfg.S3Region,
		AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretKey,
	})
	if err != nil {
		return fmt.Errorf("s3: %w", err)
	}

	now := time.Now()
	// The snapshot is read before the listing: a video created in between has only objects younger than
	// min-age, so it can never be mistaken for an orphan.
	snap, err := storagegc.Load(ctx, pool)
	if err != nil {
		return err
	}
	report, err := storagegc.Scan(ctx, s3c.SDK(), snap, cfg.S3MediaBucket, cfg.S3RawBucket, now, minAge)
	if err != nil {
		return err
	}
	report.StaleUploads, err = storagegc.ScanUploads(ctx, s3c.SDK(), pool, cfg.S3RawBucket, now, minAge)
	if err != nil {
		return err
	}
	report.Print(os.Stdout, top)
	if len(cats) == 0 {
		fmt.Println("summary: dry_run=true (nothing deleted; pass -apply to delete)")
		return nil
	}
	n, bytes, err := report.Delete(ctx, s3c.SDK(), cats, abort, cfg.S3RawBucket)
	fmt.Printf("summary: deleted_objects=%d deleted_bytes=%d aborted_uploads=%v\n", n, bytes, abort && err == nil)
	if err != nil {
		return err
	}
	// image-unreferenced: the rows go too, so the image can never be chosen again (SOC-1b).
	if cats[storagegc.ImageUnreferenced] {
		seen := map[uuid.UUID]bool{}
		var ids []uuid.UUID
		for _, o := range report.Selected(map[storagegc.Category]bool{storagegc.ImageUnreferenced: true}) {
			if id, ok := storagegc.ImageID(o.Key); ok && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		rows, err := storagegc.DeleteUnreferencedImages(ctx, pool, ids)
		fmt.Printf("summary: deleted_image_rows=%d\n", rows)
		return err
	}
	return nil
}
