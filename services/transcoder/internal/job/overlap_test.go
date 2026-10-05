package job

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

type controlledTools struct {
	MediaTools
	probe  func()
	run    func(context.Context, media.HLSPlan) error
	exited atomic.Bool
}

func (f *controlledTools) Probe(context.Context, string) (media.Info, error) {
	if f.probe != nil {
		f.probe()
	}
	return media.Info{DisplayW: 640, DisplayH: 360, DurationSec: 8, FPS: "30", HasAudio: true}, nil
}
func (f *controlledTools) RunHLS(ctx context.Context, p media.HLSPlan, _ float64, _ func(float64)) error {
	defer f.exited.Store(true)
	return f.run(ctx, p)
}
func (f *controlledTools) Thumbnail(_ context.Context, _, out string, _ float64) error {
	return writeControlled(out, "poster")
}
func (f *controlledTools) Storyboard(_ context.Context, _ StoryboardInput, dir string, _ float64) (StoryboardResult, error) {
	if err := writeControlled(filepath.Join(dir, "sheet-001.jpg"), "sheet"); err != nil {
		return StoryboardResult{}, err
	}
	return StoryboardResult{}, writeControlled(filepath.Join(dir, media.StoryboardVTT), "vtt")
}
func writeControlled(file, text string) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	return os.WriteFile(file, []byte(text), 0o600)
}
func controlledHLS(plan media.HLSPlan, text string) error {
	files := map[string]string{
		"master.m3u8":     "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS=\"avc1.64001e,mp4a.40.2\"\n360p/index.m3u8\n",
		"360p/index.m3u8": "#EXTM3U\n#EXT-X-MAP:URI=\"init_0.mp4\"\n#EXTINF:4,\nseg_00000.m4s\n#EXTINF:4,\nseg_00001.m4s\n#EXT-X-ENDLIST\n",
		"360p/init_0.mp4": text + "init", "360p/seg_00000.m4s": text + "0", "360p/seg_00001.m4s": text + "1", "360p/seg_00002.m4s.tmp": "unfinished",
	}
	for rel, val := range files {
		if err := writeControlled(filepath.Join(plan.OutDir, filepath.FromSlash(rel)), val); err != nil {
			return err
		}
	}
	return nil
}

type controlledObjects struct {
	Objects
	t            *testing.T
	mu           sync.Mutex
	files        map[string][]byte
	order        []string
	active, peak int
	hook         func(context.Context, string) error
	after        func(string)
	deleted      []string
	deleteErr    error
	exited       *atomic.Bool
}

func (o *controlledObjects) Download(_ context.Context, _, _, dst string) error {
	return writeControlled(dst, "raw")
}
func (o *controlledObjects) UploadFile(ctx context.Context, _, key, src, _, _ string) error {
	o.mu.Lock()
	o.active++
	o.peak = max(o.peak, o.active)
	o.mu.Unlock()
	defer func() { o.mu.Lock(); o.active--; o.mu.Unlock() }()
	if strings.HasSuffix(key, ".tmp") {
		o.t.Error("temporary file uploaded")
	}
	if strings.HasSuffix(key, ".m3u8") && !o.exited.Load() {
		o.t.Error("playlist before FFmpeg exit")
	}
	if o.hook != nil {
		if err := o.hook(ctx, key); err != nil {
			return err
		}
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	o.mu.Lock()
	o.files[key] = data
	o.order = append(o.order, key)
	o.mu.Unlock()
	if o.after != nil {
		o.after(key)
	}
	return nil
}
func (o *controlledObjects) DeletePrefix(_ context.Context, _, prefix string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.active != 0 {
		o.t.Errorf("cleanup with %d PUTs active", o.active)
	}
	o.deleted = append(o.deleted, prefix)
	for key := range o.files {
		if strings.HasPrefix(key, prefix) {
			delete(o.files, key)
		}
	}
	return nil
}
func (o *controlledObjects) DeleteObject(_ context.Context, _, key string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.active != 0 {
		o.t.Error("retry cleanup before drain")
	}
	if !strings.Contains(key, "/a1/hls/") {
		o.t.Errorf("cleanup escaped HLS: %s", key)
	}
	o.deleted = append(o.deleted, key)
	if o.deleteErr != nil {
		return o.deleteErr
	}
	delete(o.files, key)
	return nil
}
func (*controlledObjects) ListPrefixes(context.Context, string, string) ([]string, error) {
	return nil, nil
}

type controlledStore struct {
	Store
	begin      BeginResult
	complete   func()
	ready      bool
	fail       FailRecord
	setEncoder func()
}

func (s *controlledStore) BeginJob(context.Context, uuid.UUID, string, string) (BeginResult, error) {
	return s.begin, nil
}
func (*controlledStore) SetProgress(context.Context, uuid.UUID, float64) error { return nil }
func (s *controlledStore) SetJobEncoder(context.Context, uuid.UUID, string) error {
	if s.setEncoder != nil {
		s.setEncoder()
	}
	return nil
}
func (*controlledStore) Heartbeat(context.Context, uuid.UUID) error { return nil }
func (s *controlledStore) Complete(context.Context, ReadyResult) (bool, error) {
	if s.complete != nil {
		s.complete()
	}
	s.ready = true
	return true, nil
}
func (s *controlledStore) FailJob(_ context.Context, f FailRecord) error { s.fail = f; return nil }
func controlledPipeline(t *testing.T) (*Pipeline, *controlledStore, *controlledObjects, *controlledTools, chan time.Time, UploadedEvent) {
	t.Helper()
	v := Video{ID: uuid.New(), OwnerID: uuid.New(), RawBucket: "raw", RawKey: "source"}
	s := &controlledStore{begin: BeginResult{Video: v, JobID: uuid.New(), Attempt: 1}}
	tools := &controlledTools{}
	objs := &controlledObjects{t: t, files: map[string][]byte{}, exited: &tools.exited}
	ticks := make(chan time.Time)
	p := &Pipeline{Store: s, Objects: objs, Tools: tools, Log: slog.New(slog.NewJSONHandler(io.Discard, nil)), Cfg: Config{ScratchDir: t.TempDir(), MediaBucket: "media", Encoder: media.EncoderX264, UploadParallelism: 2}, scanTicks: func() (<-chan time.Time, func()) { return ticks, func() {} }}
	return p, s, objs, tools, ticks, UploadedEvent{VideoID: v.ID.String()}
}
func receiveControlled[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(10 * time.Second):
		t.Fatal("controlled lifecycle stalled")
		var zero T
		return zero
	}
}
func tickControlled(ctx context.Context, ticks chan time.Time) error {
	select {
	case ticks <- time.Now():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestOverlapScannerOnceTmpMasterLastAndArchiveJoined(t *testing.T) {
	p, s, o, tools, ticks, ev := controlledPipeline(t)
	archiveStarted, releaseArchive, archiveDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	masterStored := make(chan struct{})
	p.Cfg.ArchiveDir = t.TempDir()
	p.archiveCopy = func(context.Context, string, string, Video) error {
		close(archiveStarted)
		<-releaseArchive
		close(archiveDone)
		return nil
	}
	tools.probe = func() { receiveControlled(t, archiveStarted) }
	segStored := make(chan struct{}, 8)
	o.after = func(key string) {
		if strings.HasSuffix(key, ".m4s") {
			segStored <- struct{}{}
		}
		if strings.HasSuffix(key, "master.m3u8") {
			close(masterStored)
		}
	}
	tools.run = func(ctx context.Context, plan media.HLSPlan) error {
		if err := controlledHLS(plan, "x264"); err != nil {
			return err
		}
		if err := tickControlled(ctx, ticks); err != nil {
			return err
		}
		receiveControlled(t, segStored)
		receiveControlled(t, segStored)
		if err := tickControlled(ctx, ticks); err != nil {
			return err
		}
		return tickControlled(ctx, ticks)
	}
	s.complete = func() {
		select {
		case <-archiveDone:
		default:
			t.Error("READY before archive done")
		}
		o.mu.Lock()
		defer o.mu.Unlock()
		if o.active != 0 {
			t.Error("READY before drain")
		}
	}
	done := make(chan Result, 1)
	go func() { done <- p.Process(context.Background(), ev, Delivery{Num: 1, Max: 3}) }()
	receiveControlled(t, masterStored)
	select {
	case <-done:
		t.Fatal("returned before archive finished")
	default:
	}
	close(releaseArchive)
	res := receiveControlled(t, done)
	if res.Action != ActionAck || !s.ready {
		t.Fatalf("result %+v", res)
	}
	counts := map[string]int{}
	for _, key := range o.order {
		counts[key]++
	}
	for key, n := range counts {
		if n != 1 {
			t.Errorf("%s uploaded %d times", key, n)
		}
	}
	if len(o.order) != 8 {
		t.Errorf("uploaded %v, want 8 complete objects", o.order)
	}
	if last := o.order[len(o.order)-1]; !strings.HasSuffix(last, "hls/master.m3u8") {
		t.Errorf("last %s", last)
	}
	vtt, sheet := -1, -1
	for i, key := range o.order {
		if strings.HasSuffix(key, "storyboard.vtt") {
			vtt = i
		}
		if strings.HasSuffix(key, "sheet-001.jpg") {
			sheet = i
		}
	}
	if sheet < 0 || vtt <= sheet {
		t.Errorf("storyboard order %v", o.order)
	}
	if o.peak > 2 {
		t.Errorf("parallelism %d", o.peak)
	}
	if len(res.Steps) != len(Steps) {
		t.Fatalf("steps %+v", res.Steps)
	}
	for i, step := range res.Steps {
		if step.Step != Steps[i] {
			t.Errorf("step %d %+v", i, step)
		}
	}
}
func TestOverlapCancelDrainsBeforeCleanup(t *testing.T) {
	p, s, o, tools, ticks, ev := controlledPipeline(t)
	entered, cancelSeen, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	o.hook = func(ctx context.Context, _ string) error {
		close(entered)
		<-ctx.Done()
		close(cancelSeen)
		<-release
		return ctx.Err()
	}
	tools.run = func(ctx context.Context, plan media.HLSPlan) error {
		if err := writeControlled(filepath.Join(plan.OutDir, "360p/seg_00000.m4s"), "partial"); err != nil {
			return err
		}
		if err := tickControlled(ctx, ticks); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan Result, 1)
	go func() { done <- p.Process(ctx, ev, Delivery{Num: 1, Max: 3}) }()
	receiveControlled(t, entered)
	cancel()
	receiveControlled(t, cancelSeen)
	select {
	case <-done:
		t.Fatal("returned before PUT drained")
	default:
	}
	close(release)
	res := receiveControlled(t, done)
	if res.Action != ActionNak || !errors.Is(res.Err, ErrInterrupted) || s.ready || s.fail.Terminal {
		t.Fatalf("result %+v fail %+v", res, s.fail)
	}
	if len(o.files) != 0 || len(o.deleted) != 1 {
		t.Fatalf("cleanup files=%v deleted=%v", o.files, o.deleted)
	}
}
func TestOverlapRetryDrainsAndDeletesOnlyFailedHLS(t *testing.T) {
	for _, deleteFails := range []bool{false, true} {
		t.Run(fmt.Sprint("deleteFails=", deleteFails), func(t *testing.T) {
			p, s, o, tools, ticks, ev := controlledPipeline(t)
			p.Cfg.Encoder = media.EncoderNVENC
			p.Cfg.UploadParallelism = 1
			entered, cancelSeen, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var fallback atomic.Bool
			other := "v/other/a1/hls/seg_00000.m4s"
			o.files[other] = []byte("untouched")
			if deleteFails {
				o.deleteErr = errors.New("delete failed")
			}
			o.hook = func(ctx context.Context, key string) error {
				if strings.HasSuffix(key, "seg_00000.m4s") && !fallback.Load() {
					close(entered)
					<-ctx.Done()
					close(cancelSeen)
					<-release
					return ctx.Err()
				}
				return nil
			}
			s.setEncoder = func() {
				o.mu.Lock()
				defer o.mu.Unlock()
				if o.active != 0 {
					t.Error("fallback before drain")
				}
				for key := range o.files {
					if key != other {
						t.Errorf("dirty prefix at retry: %s", key)
					}
				}
				fallback.Store(true)
			}
			tools.run = func(ctx context.Context, plan media.HLSPlan) error {
				if plan.Encoder == media.EncoderNVENC {
					if err := writeControlled(filepath.Join(plan.OutDir, "360p/seg_00000.m4s"), "nvenc"); err != nil {
						return err
					}
					if err := tickControlled(ctx, ticks); err != nil {
						return err
					}
					receiveControlled(t, entered)
					return &EncoderError{Op: "controlled GPU failure", Err: errors.New("GPU lost")}
				}
				if !fallback.Load() {
					t.Error("x264 before retry cleanup")
				}
				return controlledHLS(plan, "x264")
			}
			done := make(chan Result, 1)
			go func() { done <- p.Process(context.Background(), ev, Delivery{Num: 1, Max: 3}) }()
			receiveControlled(t, cancelSeen)
			if fallback.Load() {
				t.Error("fallback before cancelled PUT drained")
			}
			close(release)
			res := receiveControlled(t, done)
			if deleteFails {
				if res.Action != ActionNak || s.ready || fallback.Load() || s.fail.Failure.Reason != ReasonStorage {
					t.Fatalf("dirty retry %+v fail %+v", res, s.fail)
				}
			} else {
				if res.Action != ActionAck || !s.ready || !fallback.Load() {
					t.Fatalf("fallback %+v", res)
				}
			}
			if string(o.files[other]) != "untouched" {
				t.Fatal("another attempt deleted")
			}
			for key, data := range o.files {
				if key != other && strings.Contains(string(data), "nvenc") {
					t.Errorf("mixed output %s", key)
				}
			}
		})
	}
}
func TestOverlapUploadErrorCancelsEncoderAndCannotBecomeReady(t *testing.T) {
	p, s, o, tools, ticks, ev := controlledPipeline(t)
	o.hook = func(context.Context, string) error { return errors.New("Garage unavailable") }
	tools.run = func(ctx context.Context, plan media.HLSPlan) error {
		if err := controlledHLS(plan, "x264"); err != nil {
			return err
		}
		if err := tickControlled(ctx, ticks); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	}
	res := p.Process(context.Background(), ev, Delivery{Num: 1, Max: 3})
	if res.Action != ActionNak || s.ready || s.fail.Failure.Reason != ReasonStorage || len(o.files) != 0 {
		t.Fatalf("upload failure %+v fail %+v files %v", res, s.fail, o.files)
	}
}

func TestOverlapArchiveFailureRemainsBestEffort(t *testing.T) {
	p, s, _, tools, _, ev := controlledPipeline(t)
	p.Cfg.ArchiveDir = t.TempDir()
	p.archiveCopy = func(context.Context, string, string, Video) error { return errors.New("HDD unavailable") }
	tools.run = func(_ context.Context, plan media.HLSPlan) error { return controlledHLS(plan, "x264") }
	res := p.Process(context.Background(), ev, Delivery{Num: 1, Max: 3})
	if res.Action != ActionAck || !s.ready {
		t.Fatalf("archive failure failed video: %+v", res)
	}
	for _, step := range res.Steps {
		if step.Err != (step.Step == StepArchive) {
			t.Errorf("wrong result label: %+v", step)
		}
	}
}

func TestOverlapTimeoutCannotFallBackOrBecomeReady(t *testing.T) {
	p, s, o, tools, ticks, ev := controlledPipeline(t)
	p.Cfg.Encoder = media.EncoderNVENC
	uploaded := make(chan struct{})
	o.after = func(string) { close(uploaded) }
	tools.run = func(ctx context.Context, plan media.HLSPlan) error {
		if err := writeControlled(filepath.Join(plan.OutDir, "360p/seg_00000.m4s"), "partial"); err != nil {
			return err
		}
		if err := tickControlled(ctx, ticks); err != nil {
			return err
		}
		receiveControlled(t, uploaded)
		return &TimeoutError{After: "controlled budget"}
	}
	s.setEncoder = func() { t.Error("timeout retried within attempt") }
	res := p.Process(context.Background(), ev, Delivery{Num: 1, Max: 3})
	if res.Action != ActionNak || s.ready || s.fail.Failure.Reason != ReasonTimeout || len(o.files) != 0 {
		t.Fatalf("timeout: %+v fail %+v", res, s.fail)
	}
}
