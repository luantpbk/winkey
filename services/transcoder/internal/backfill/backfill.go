// Package backfill makes the seek-preview storyboard (task V5a) of READY videos that have none
// (task V5a-b): videos that became READY before V5a, or whose best-effort storyboard step failed.
// It reuses the code of the pipeline: the same rendition choice (media.StoryboardRendition), the same
// ffmpeg call (job.Tools.Storyboard) and the same keys, Content-Type and Cache-Control
// (job.UploadStoryboard). It never reads the source, only the HLS rendition already in the media bucket.
package backfill

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// pageSize is how many rows one keyset page of the selection reads.
const pageSize = 100

// Cursor is the keyset position in (created_at DESC, id DESC) order; the zero value is the start.
type Cursor struct {
	CreatedAt time.Time
	ID        uuid.UUID
}

// Candidate is a READY video without a storyboard.
type Candidate struct {
	ID           uuid.UUID
	CreatedAt    time.Time
	MasterKey    string // v/{id}/a{attempt}/hls/master.m3u8
	DurationMs   int
	Renditions   []media.Rendition
	PlaylistKeys map[string]string // rendition name -> media-bucket key of its index.m3u8
}

// Store is the persistence port of the backfill.
type Store interface {
	// SelectBackfill returns at most limit candidates strictly after the cursor, newest first.
	SelectBackfill(ctx context.Context, after Cursor, limit int) ([]Candidate, error)
	// SetStoryboardKey sets storyboard_key only while the video is READY and has none; ok is
	// false when no row changed.
	SetStoryboardKey(ctx context.Context, id uuid.UUID, key string) (ok bool, err error)
}

// Options of one run.
type Options struct {
	Limit       int
	Concurrency int
	DryRun      bool
	MediaBucket string
	ScratchDir  string
}

// Summary is the outcome of a run.
type Summary struct {
	Selected           int
	Done               int
	SkippedNoRendition int
	Failed             int
	LostRace           int
	WouldDo            int // dry run: videos that would get a storyboard
	Duration           time.Duration
}

// Line is the final summary line printed by the CLI.
func (s Summary) Line(dry bool) string {
	line := fmt.Sprintf("summary: selected=%d done=%d skipped_no_rendition=%d failed=%d lost_race=%d",
		s.Selected, s.Done, s.SkippedNoRendition, s.Failed, s.LostRace)
	if dry {
		line += fmt.Sprintf(" would_do=%d dry_run=true", s.WouldDo)
	}
	return line + fmt.Sprintf(" duration=%s", s.Duration.Round(time.Millisecond))
}

// Runner makes the storyboards.
type Runner struct {
	Store   Store
	Objects job.Objects
	// Storyboard replaces job.Tools.Storyboard (tests).
	Storyboard job.StoryboardFunc
	Opt        Options
	Log        *slog.Logger
}

// Run selects the videos and processes them. It returns an error only when the selection or
// the scratch directory fails; per-video failures are counted and logged. A cancelled ctx
// stops the run early.
func (r *Runner) Run(ctx context.Context) (Summary, error) {
	start := time.Now()
	var sum Summary
	cands, err := r.selectAll(ctx)
	sum.Selected = len(cands)
	if err != nil {
		sum.Duration = time.Since(start)
		return sum, err
	}
	if !r.Opt.DryRun {
		if err := os.MkdirAll(r.Opt.ScratchDir, 0o755); err != nil {
			sum.Duration = time.Since(start)
			return sum, fmt.Errorf("scratch dir: %w", err)
		}
	}

	var mu sync.Mutex
	count := func(o outcome) {
		mu.Lock()
		defer mu.Unlock()
		switch o {
		case outDone:
			sum.Done++
		case outSkipped:
			sum.SkippedNoRendition++
		case outFailed:
			sum.Failed++
		case outLostRace:
			sum.LostRace++
		case outWouldDo:
			sum.WouldDo++
		}
	}
	sem := make(chan struct{}, max(1, r.Opt.Concurrency))
	var wg sync.WaitGroup
loop:
	for _, c := range cands {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			break loop
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			count(r.one(ctx, c))
		}()
	}
	wg.Wait()
	sum.Duration = time.Since(start)
	return sum, nil
}

// selectAll reads up to Limit candidates in keyset pages.
func (r *Runner) selectAll(ctx context.Context) ([]Candidate, error) {
	var out []Candidate
	var cur Cursor
	for len(out) < r.Opt.Limit {
		n := min(pageSize, r.Opt.Limit-len(out))
		page, err := r.Store.SelectBackfill(ctx, cur, n)
		if err != nil {
			return out, err
		}
		out = append(out, page...)
		if len(page) < n {
			break
		}
		last := page[len(page)-1]
		cur = Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	return out, nil
}

type outcome int

const (
	outDone outcome = iota
	outSkipped
	outFailed
	outLostRace
	outWouldDo
	outInterrupted // shutdown: neither done nor the video's fault
)

// one processes a single video.
func (r *Runner) one(ctx context.Context, c Candidate) outcome {
	log := r.Log.With("video_id", c.ID)
	rend, ok := media.StoryboardRendition(c.Renditions)
	if !ok {
		log.WarnContext(ctx, "no rendition is tall enough for a storyboard; skipping")
		return outSkipped
	}
	prefix, ok := strings.CutSuffix(c.MasterKey, "hls/"+media.MasterPlaylist)
	playlistKey := c.PlaylistKeys[rend.Name]
	if !ok || playlistKey == "" || c.DurationMs <= 0 {
		return r.fail(ctx, log, "data", errors.New("video row is inconsistent (master key, playlist key or duration)"), "")
	}
	if r.Opt.DryRun {
		log.InfoContext(ctx, "would make storyboard", "rendition", rend.Name, "playlist_key", playlistKey,
			"storyboard_key", job.StoryboardVTTKey(prefix))
		return outWouldDo
	}

	work, err := os.MkdirTemp(r.Opt.ScratchDir, "backfill-"+c.ID.String()+"-")
	if err != nil {
		return r.fail(ctx, log, "scratch", err, "")
	}
	defer func() { _ = os.RemoveAll(work) }() // also on error and on shutdown

	hlsDir := filepath.Join(work, "hls", rend.Name)
	if err := r.fetchRendition(ctx, playlistKey, hlsDir); err != nil {
		return r.fail(ctx, log, "storage", err, "")
	}
	gen := r.Storyboard
	if gen == nil {
		return r.fail(ctx, log, "internal", errors.New("no storyboard generator"), "")
	}
	sbDir := filepath.Join(work, "storyboard")
	in := job.StoryboardInput{Path: filepath.Join(hlsDir, "index.m3u8"), KeyframesOnly: true}
	if _, err := gen(ctx, in, sbDir, float64(c.DurationMs)/1000); err != nil {
		var ee *job.EncoderError
		tail := ""
		if errors.As(err, &ee) {
			tail = ee.Tail
		}
		return r.fail(ctx, log, errorClass(err), err, tail)
	}

	keys, err := job.UploadStoryboard(ctx, r.Objects, r.Opt.MediaBucket, prefix, sbDir)
	if err != nil {
		r.cleanup(log, keys)
		return r.fail(ctx, log, "storage", err, "")
	}
	// The objects exist now: finish the row even when shutdown arrived meanwhile.
	dbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	set, err := r.Store.SetStoryboardKey(dbCtx, c.ID, job.StoryboardVTTKey(prefix))
	if err != nil {
		r.cleanup(log, keys)
		return r.fail(ctx, log, "database", err, "")
	}
	if !set {
		log.InfoContext(ctx, "video was deleted or already has a storyboard; removing the uploaded objects")
		r.cleanup(log, keys)
		return outLostRace
	}
	log.InfoContext(ctx, "storyboard made", "rendition", rend.Name, "objects", len(keys))
	return outDone
}

// fail logs a per-video failure and picks the outcome: a cancelled ctx is an interruption.
func (r *Runner) fail(ctx context.Context, log *slog.Logger, class string, err error, stderrTail string) outcome {
	if ctx.Err() != nil {
		log.WarnContext(ctx, "interrupted", "error", err)
		return outInterrupted
	}
	attrs := []any{"error_class", class, "error", err}
	if stderrTail != "" {
		attrs = append(attrs, "ffmpeg_stderr_tail", stderrTail)
	}
	log.ErrorContext(ctx, "storyboard failed", attrs...)
	return outFailed
}

// cleanup deletes uploaded objects on a fresh context (the run context may be cancelled).
func (r *Runner) cleanup(log *slog.Logger, keys []string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for _, k := range keys {
		if err := r.Objects.DeleteObject(ctx, r.Opt.MediaBucket, k); err != nil {
			log.Warn("remove uploaded object", "key", k, "error", err)
		}
	}
}

func errorClass(err error) string {
	var to *job.TimeoutError
	var ee *job.EncoderError
	var se *job.StorageError
	switch {
	case errors.As(err, &to):
		return "timeout"
	case errors.As(err, &ee):
		return "encoder"
	case errors.As(err, &se):
		return "storage"
	}
	return "internal"
}

// fetchRendition downloads index.m3u8 of a rendition and every file it names (the fMP4 init
// segment and the media segments) into dir, from the same key prefix.
func (r *Runner) fetchRendition(ctx context.Context, playlistKey, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	local := filepath.Join(dir, "index.m3u8")
	if err := r.Objects.Download(ctx, r.Opt.MediaBucket, playlistKey, local); err != nil {
		return fmt.Errorf("download playlist: %w", err)
	}
	raw, err := os.ReadFile(local)
	if err != nil {
		return err
	}
	names, err := PlaylistFiles(string(raw))
	if err != nil {
		return err
	}
	base := path.Dir(playlistKey)
	for _, n := range names {
		if err := r.Objects.Download(ctx, r.Opt.MediaBucket, base+"/"+n, filepath.Join(dir, n)); err != nil {
			return fmt.Errorf("download %s: %w", n, err)
		}
	}
	return nil
}

// PlaylistFiles lists the files a media playlist refers to (EXT-X-MAP init segment and segment
// lines), each a plain file name in the playlist's own directory. Anything else (a path, a URL, a
// parent reference) is refused: the names come from object storage and become local paths.
func PlaylistFiles(playlist string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	add := func(n string) error {
		if n == "" || n == "." || n == ".." || strings.ContainsAny(n, "/\\:") {
			return fmt.Errorf("playlist refers to unsafe file name %q", n)
		}
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
		return nil
	}
	for _, line := range strings.Split(playlist, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			const attr = `URI="`
			i := strings.Index(line, attr)
			if i < 0 {
				return nil, errors.New("EXT-X-MAP without URI")
			}
			rest := line[i+len(attr):]
			j := strings.Index(rest, `"`)
			if j < 0 {
				return nil, errors.New("EXT-X-MAP with unterminated URI")
			}
			if err := add(rest[:j]); err != nil {
				return nil, err
			}
		case strings.HasPrefix(line, "#"):
		default:
			if err := add(line); err != nil {
				return nil, err
			}
		}
	}
	if len(out) == 0 {
		return nil, errors.New("playlist has no segments")
	}
	return out, nil
}
