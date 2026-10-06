package job

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// uploadSpan is one job's first-to-last PUT span, including encoder gaps/fallback.
type uploadSpan struct {
	mu          sync.Mutex
	first, last time.Time
}

func (s *uploadSpan) upload(ctx context.Context, p *Pipeline, prefix string, f outputFile) error {
	s.mu.Lock()
	if s.first.IsZero() {
		s.first = time.Now()
	}
	s.mu.Unlock()
	err := p.Objects.UploadFile(ctx, p.Cfg.MediaBucket, prefix+f.rel, f.path, contentType(f.rel), cacheControlValue)
	s.mu.Lock()
	s.last = time.Now()
	s.mu.Unlock()
	if err != nil {
		return &StorageError{Op: "upload " + path.Base(f.rel), Err: err}
	}
	return nil
}
func (s *uploadSpan) elapsed() (bool, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.first.IsZero(), s.last.Sub(s.first)
}
func (s *uploadSpan) tail(exit time.Time) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return max(0, s.last.Sub(exit))
}

type outputFile struct {
	rel, path string
	size      int64
}

func (p *Pipeline) uploadParallelism() int {
	if p.Cfg.UploadParallelism > 0 {
		return p.Cfg.UploadParallelism
	}
	return 8
}
func (p *Pipeline) segmentTicks() (<-chan time.Time, func()) {
	if p.scanTicks != nil {
		return p.scanTicks()
	}
	t := time.NewTicker(time.Second)
	return t.C, t.Stop
}

// One scanner owns seen and one bounded group per encoder run. All PUTs join
// before final uploads, cleanup or retry, so phases never double the parallelism.
type segmentUploader struct {
	errMu          sync.Mutex
	uploadErr      error
	p              *Pipeline
	ctx            context.Context
	cancel         context.CancelFunc
	outDir, prefix string
	span           *uploadSpan
	group          *errgroup.Group
	seen           map[string]bool
}

func (p *Pipeline) newSegmentUploader(ctx context.Context, cancel context.CancelFunc, outDir, prefix string, span *uploadSpan) *segmentUploader {
	g := new(errgroup.Group)
	g.SetLimit(p.uploadParallelism())
	return &segmentUploader{p: p, ctx: ctx, cancel: cancel, outDir: outDir, prefix: prefix, span: span, group: g, seen: map[string]bool{}}
}
func finishedSegment(rel string) bool {
	parts := strings.Split(rel, "/")
	if len(parts) != 3 || parts[0] != "hls" {
		return false
	}
	name := parts[2]
	if !strings.HasPrefix(name, "seg_") || !strings.HasSuffix(name, ".m4s") {
		return false
	}
	digits := strings.TrimSuffix(strings.TrimPrefix(name, "seg_"), ".m4s")
	if len(digits) < 5 {
		return false
	}
	for _, c := range digits {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func (u *segmentUploader) scan() error {
	hls := filepath.Join(u.outDir, "hls")
	if _, err := os.Stat(hls); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return filepath.WalkDir(hls, func(filename string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := u.ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(u.outDir, filename)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !finishedSegment(rel) || u.seen[rel] {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("non-regular HLS segment")
		}
		f := outputFile{rel: rel, path: filename, size: info.Size()}
		u.seen[rel] = true
		u.group.Go(func() error {
			if err := u.ctx.Err(); err != nil {
				return err
			}
			err := u.span.upload(u.ctx, u.p, u.prefix, f)
			if err != nil {
				u.errMu.Lock()
				if u.uploadErr == nil {
					u.uploadErr = err
				}
				u.errMu.Unlock()
				u.cancel()
			}
			return err
		})
		return nil
	})
}
func (u *segmentUploader) run(ticks <-chan time.Time, finished <-chan struct{}) error {
	var scanErr error
	for {
		if scanErr = u.scan(); scanErr != nil {
			u.cancel()
			break
		}
		select {
		case <-u.ctx.Done():
			scanErr = u.ctx.Err()
		case <-finished:
			scanErr = u.scan() // include the final segment rename
		case <-ticks:
			continue
		}
		break
	}
	if scanErr != nil {
		u.cancel()
	}
	waitErr := u.group.Wait()
	u.errMu.Lock()
	uploadErr := u.uploadErr
	u.errMu.Unlock()
	if uploadErr != nil {
		return uploadErr
	}
	if waitErr != nil {
		return waitErr
	}
	return scanErr
}
func (u *segmentUploader) attemptedKeys() []string {
	keys := make([]string, 0, len(u.seen))
	for rel := range u.seen {
		keys = append(keys, u.prefix+rel)
	}
	sort.Strings(keys)
	return keys
}
func (p *Pipeline) removeUploadedHLS(ctx context.Context, keys []string) error {
	var errs []error
	for _, key := range keys {
		if err := p.Objects.DeleteObject(ctx, p.Cfg.MediaBucket, key); err != nil {
			errs = append(errs, err)
		}
	}
	if err := errors.Join(errs...); err != nil {
		return &StorageError{Op: "clean failed encoder output", Err: err}
	}
	return nil
}

// uploadAll follows the drained scanner: segments, init files, variant playlists,
// poster/storyboard sheets, storyboard VTT, then master LAST across the attempt.
func (p *Pipeline) uploadAll(ctx context.Context, outDir, prefix string, seen map[string]bool, span *uploadSpan, onFrac func(float64)) (int64, error) {
	var phases [6][]outputFile
	var master *outputFile
	var total, done int64
	err := filepath.WalkDir(outDir, func(filename string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(outDir, filename)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if strings.HasSuffix(rel, ".tmp") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		f := outputFile{rel: rel, path: filename, size: info.Size()}
		total += f.size
		if seen[rel] {
			done += f.size
			return nil
		}
		if rel == "hls/"+media.MasterPlaylist {
			master = &f
			return nil
		}
		phase := 3
		switch {
		case finishedSegment(rel):
			phase = 0
		case strings.HasPrefix(rel, "hls/") && strings.HasSuffix(rel, ".mp4"):
			phase = 1
		case strings.HasPrefix(rel, "hls/") && strings.HasSuffix(rel, ".m3u8"):
			phase = 2
		case rel == storyboardDir+"/"+media.StoryboardVTT:
			phase = 4
		}
		phases[phase] = append(phases[phase], f)
		return nil
	})
	if err != nil {
		return 0, err
	}
	if master == nil {
		return 0, &EncoderError{Op: "collect output", Err: errors.New("master playlist missing")}
	}
	phases[5] = []outputFile{*master}
	var mu sync.Mutex
	bump := func(n int64) { mu.Lock(); defer mu.Unlock(); done += n; onFrac(float64(done) / float64(max(total, 1))) }
	bump(0)
	for _, files := range phases {
		g, gctx := errgroup.WithContext(ctx)
		g.SetLimit(p.uploadParallelism())
		for _, f := range files {
			g.Go(func() error {
				if err := gctx.Err(); err != nil {
					return err
				}
				if err := span.upload(gctx, p, prefix, f); err != nil {
					return err
				}
				bump(f.size)
				return nil
			})
		}
		if err := g.Wait(); err != nil {
			return 0, err
		}
	}
	return total, nil
}
