package backfill_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/backfill"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

const bucket = testutil.MediaBucket

// fakeStore is an in-memory backfill.Store with the same selection contract as the SQL query:
// newest first by (created_at, id), strictly after the cursor.
type fakeStore struct {
	mu    sync.Mutex
	cands []backfill.Candidate // any order
	calls []int                // limit of each SelectBackfill call
	set   map[uuid.UUID]string // SetStoryboardKey calls that took effect
	gone  map[uuid.UUID]bool   // SetStoryboardKey reports "no row changed"
	err   error
}

func (f *fakeStore) SelectBackfill(_ context.Context, after backfill.Cursor, limit int) ([]backfill.Candidate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, limit)
	if f.err != nil {
		return nil, f.err
	}
	all := append([]backfill.Candidate(nil), f.cands...)
	sort.Slice(all, func(i, j int) bool { return newer(all[i], all[j]) })
	var out []backfill.Candidate
	for _, c := range all {
		if after.CreatedAt.IsZero() || newer(backfill.Candidate{CreatedAt: after.CreatedAt, ID: after.ID}, c) {
			out = append(out, c)
		}
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func newer(a, b backfill.Candidate) bool { // a sorts before b
	if !a.CreatedAt.Equal(b.CreatedAt) {
		return a.CreatedAt.After(b.CreatedAt)
	}
	return a.ID.String() > b.ID.String()
}

func (f *fakeStore) SetStoryboardKey(_ context.Context, id uuid.UUID, key string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.gone[id] {
		return false, nil
	}
	if f.set == nil {
		f.set = map[uuid.UUID]string{}
	}
	f.set[id] = key
	return true, nil
}

// candidate builds a READY video whose 480p HLS output is in objs.
func candidate(objs *testutil.MemObjects, createdAt time.Time, attempt int) backfill.Candidate {
	id := uuid.New()
	prefix := fmt.Sprintf("v/%s/a%d/", id, attempt)
	objs.Put(bucket, prefix+"hls/480p/index.m3u8", []byte("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.0,\nseg_00000.m4s\n#EXTINF:2.0,\nseg_00001.m4s\n#EXT-X-ENDLIST\n"))
	for _, n := range []string{"init.mp4", "seg_00000.m4s", "seg_00001.m4s"} {
		objs.Put(bucket, prefix+"hls/480p/"+n, []byte(n))
	}
	return backfill.Candidate{
		ID: id, CreatedAt: createdAt, MasterKey: prefix + "hls/master.m3u8", DurationMs: 4000,
		Renditions:   []media.Rendition{{Name: "480p", Width: 854, Height: 480}},
		PlaylistKeys: map[string]string{"480p": prefix + "hls/480p/index.m3u8"},
	}
}

// fakeGen writes one sheet and the track like Tools.Storyboard, after checking its input.
type fakeGen struct {
	mu     sync.Mutex
	inputs []job.StoryboardInput
	files  [][]string // names present beside the playlist when it ran
	err    error
}

func (g *fakeGen) run(_ context.Context, in job.StoryboardInput, dir string, _ float64) (job.StoryboardResult, error) {
	var names []string
	if es, err := os.ReadDir(filepath.Dir(in.Path)); err == nil {
		for _, e := range es {
			names = append(names, e.Name())
		}
	}
	g.mu.Lock()
	g.inputs = append(g.inputs, in)
	g.files = append(g.files, names)
	g.mu.Unlock()
	if g.err != nil {
		return job.StoryboardResult{}, g.err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return job.StoryboardResult{}, err
	}
	if err := os.WriteFile(filepath.Join(dir, "sheet-001.jpg"), []byte("jpg"), 0o644); err != nil {
		return job.StoryboardResult{}, err
	}
	err := os.WriteFile(filepath.Join(dir, media.StoryboardVTT), []byte("WEBVTT\n"), 0o644)
	return job.StoryboardResult{Frames: 1, Sheets: 1, Interval: 2}, err
}

func runner(st backfill.Store, objs job.Objects, gen job.StoryboardFunc, opt backfill.Options) *backfill.Runner {
	if opt.Limit == 0 {
		opt.Limit = 100
	}
	if opt.Concurrency == 0 {
		opt.Concurrency = 1
	}
	opt.MediaBucket = bucket
	return &backfill.Runner{Store: st, Objects: objs, Storyboard: gen, Opt: opt, Log: slog.New(slog.NewJSONHandler(io.Discard, nil))}
}

func entries(t *testing.T, dir string) []string {
	t.Helper()
	es, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

func TestRunMakesTheStoryboardUnderTheAttemptPrefix(t *testing.T) {
	objs := testutil.NewMemObjects()
	c := candidate(objs, time.Now(), 2)
	st := &fakeStore{cands: []backfill.Candidate{c}}
	gen := &fakeGen{}
	scratch := t.TempDir()

	sum, err := runner(st, objs, gen.run, backfill.Options{ScratchDir: scratch}).Run(context.Background())
	if err != nil || sum.Selected != 1 || sum.Done != 1 || sum.Failed != 0 {
		t.Fatalf("summary: %+v %v", sum, err)
	}
	prefix := "v/" + c.ID.String() + "/a2/storyboard/"
	if got := st.set[c.ID]; got != prefix+"storyboard.vtt" {
		t.Fatalf("storyboard key = %q", got)
	}
	for name, ct := range map[string]string{"storyboard.vtt": "text/vtt", "sheet-001.jpg": "image/jpeg"} {
		o, ok := objs.Get(bucket, prefix+name)
		if !ok || o.ContentType != ct || o.CacheControl != "public, max-age=31536000, immutable" {
			t.Errorf("%s: %+v (found %v)", name, o, ok)
		}
	}
	if last := objs.UploadOrder[len(objs.UploadOrder)-1]; last != prefix+"storyboard.vtt" {
		t.Errorf("the track must be uploaded last, order = %v", objs.UploadOrder)
	}
	// The input is the downloaded rendition, read with key frames only; the whole rendition is beside it.
	if len(gen.inputs) != 1 || !gen.inputs[0].KeyframesOnly || filepath.Base(gen.inputs[0].Path) != "index.m3u8" {
		t.Fatalf("input = %+v", gen.inputs)
	}
	if want := []string{"index.m3u8", "init.mp4", "seg_00000.m4s", "seg_00001.m4s"}; strings.Join(gen.files[0], ",") != strings.Join(want, ",") {
		t.Errorf("files beside the playlist = %v, want %v", gen.files[0], want)
	}
	if left := entries(t, scratch); len(left) != 0 {
		t.Errorf("temp dir left behind: %v", left)
	}
}

func TestSelectionIsNewestFirstAndKeysetPaged(t *testing.T) {
	objs := testutil.NewMemObjects()
	base := time.Now().Truncate(time.Second)
	st := &fakeStore{}
	for i := range 250 {
		// pairs share a created_at, so the id tie-break matters
		st.cands = append(st.cands, candidate(objs, base.Add(-time.Duration(i/2)*time.Minute), 1))
	}
	// Selection alone: a dry run lists the videos in order without generating anything.
	var seen []backfill.Candidate
	spy := &spyStore{fakeStore: st, seen: &seen}
	sum, err := runner(spy, objs, nil, backfill.Options{Limit: 230, DryRun: true, ScratchDir: t.TempDir()}).Run(context.Background())
	if err != nil || sum.Selected != 230 || sum.WouldDo != 230 {
		t.Fatalf("summary: %+v %v", sum, err)
	}
	if got, want := fmt.Sprint(st.calls), "[100 100 30]"; got != want {
		t.Errorf("page limits = %s, want %s", got, want)
	}
	if len(seen) != 230 {
		t.Fatalf("saw %d candidates", len(seen))
	}
	for i := 1; i < len(seen); i++ {
		if !newer(seen[i-1], seen[i]) {
			t.Fatalf("candidates %d and %d are out of order (created_at DESC, id DESC)", i-1, i)
		}
	}
	dup := map[uuid.UUID]bool{}
	for _, c := range seen {
		if dup[c.ID] {
			t.Fatalf("video %s selected twice across pages", c.ID)
		}
		dup[c.ID] = true
	}
}

// spyStore records what the paged selection returned.
type spyStore struct {
	*fakeStore
	seen *[]backfill.Candidate
}

func (s *spyStore) SelectBackfill(ctx context.Context, after backfill.Cursor, limit int) ([]backfill.Candidate, error) {
	out, err := s.fakeStore.SelectBackfill(ctx, after, limit)
	*s.seen = append(*s.seen, out...)
	return out, err
}

func TestDryRunWritesNothing(t *testing.T) {
	objs := testutil.NewMemObjects()
	st := &fakeStore{cands: []backfill.Candidate{candidate(objs, time.Now(), 1), candidate(objs, time.Now().Add(-time.Hour), 1)}}
	before := objs.Keys(bucket)
	gen := &fakeGen{}
	scratch := filepath.Join(t.TempDir(), "never-created")

	sum, err := runner(st, objs, gen.run, backfill.Options{DryRun: true, ScratchDir: scratch}).Run(context.Background())
	if err != nil || sum.Selected != 2 || sum.WouldDo != 2 || sum.Done != 0 {
		t.Fatalf("summary: %+v %v", sum, err)
	}
	if len(gen.inputs) != 0 || len(st.set) != 0 || len(objs.UploadOrder) != 0 {
		t.Errorf("dry run did work: generated %d, rows set %d, uploads %d", len(gen.inputs), len(st.set), len(objs.UploadOrder))
	}
	if after := objs.Keys(bucket); strings.Join(after, ",") != strings.Join(before, ",") {
		t.Errorf("bucket changed: %v -> %v", before, after)
	}
	if _, err := os.Stat(scratch); err == nil {
		t.Error("dry run created the scratch dir")
	}
}

func TestLostRaceDeletesTheUploadedObjects(t *testing.T) {
	objs := testutil.NewMemObjects()
	c := candidate(objs, time.Now(), 1)
	st := &fakeStore{cands: []backfill.Candidate{c}, gone: map[uuid.UUID]bool{c.ID: true}}
	scratch := t.TempDir()

	sum, err := runner(st, objs, (&fakeGen{}).run, backfill.Options{ScratchDir: scratch}).Run(context.Background())
	if err != nil || sum.LostRace != 1 || sum.Done != 0 || sum.Failed != 0 {
		t.Fatalf("summary: %+v %v", sum, err)
	}
	for _, k := range objs.Keys(bucket) {
		if strings.Contains(k, "/storyboard/") {
			t.Errorf("uploaded object %s was not deleted", k)
		}
	}
	if len(objs.UploadOrder) != 2 {
		t.Fatalf("expected the sheet and the track to have been uploaded first, got %v", objs.UploadOrder)
	}
	if left := entries(t, scratch); len(left) != 0 {
		t.Errorf("temp dir left behind: %v", left)
	}
	// The video's HLS output is untouched.
	if _, ok := objs.Get(bucket, "v/"+c.ID.String()+"/a1/hls/480p/index.m3u8"); !ok {
		t.Error("HLS output was deleted")
	}
}

func TestTempDirIsRemovedOnError(t *testing.T) {
	for name, tc := range map[string]struct {
		gen   func() job.StoryboardFunc
		prep  func(o *testutil.MemObjects)
		class string
	}{
		"ffmpeg fails": {gen: func() job.StoryboardFunc {
			return (&fakeGen{err: &job.EncoderError{Op: "ffmpeg storyboard", Err: errors.New("exit 1"), Tail: "boom"}}).run
		}},
		"download fails": {gen: func() job.StoryboardFunc { return (&fakeGen{}).run }, prep: func(o *testutil.MemObjects) { o.DownloadErr = errors.New("s3 down") }},
		"upload fails":   {gen: func() job.StoryboardFunc { return (&fakeGen{}).run }, prep: func(o *testutil.MemObjects) { o.UploadErr = errors.New("s3 down") }},
	} {
		t.Run(name, func(t *testing.T) {
			objs := testutil.NewMemObjects()
			st := &fakeStore{cands: []backfill.Candidate{candidate(objs, time.Now(), 1), candidate(objs, time.Now().Add(-time.Minute), 1)}}
			if tc.prep != nil {
				tc.prep(objs)
			}
			scratch := t.TempDir()
			sum, err := runner(st, objs, tc.gen(), backfill.Options{ScratchDir: scratch}).Run(context.Background())
			if err != nil {
				t.Fatalf("a per-video failure must not fail the run: %v", err)
			}
			if sum.Failed != 2 || sum.Done != 0 || len(st.set) != 0 {
				t.Fatalf("summary: %+v, rows set %d", sum, len(st.set))
			}
			if left := entries(t, scratch); len(left) != 0 {
				t.Errorf("temp dir left behind: %v", left)
			}
		})
	}
}

func TestFailuresAreCountedAndTheRunGoesOn(t *testing.T) {
	objs := testutil.NewMemObjects()
	bad := candidate(objs, time.Now(), 1)
	good := candidate(objs, time.Now().Add(-time.Minute), 1)
	st := &fakeStore{cands: []backfill.Candidate{bad, good}}
	first := true
	var mu sync.Mutex
	g := func(ctx context.Context, in job.StoryboardInput, dir string, d float64) (job.StoryboardResult, error) {
		mu.Lock()
		fail := first
		first = false
		mu.Unlock()
		if fail {
			return job.StoryboardResult{}, &job.EncoderError{Op: "ffmpeg storyboard", Err: errors.New("exit 1"), Tail: "bad input"}
		}
		return (&fakeGen{}).run(ctx, in, dir, d)
	}
	sum, err := runner(st, objs, g, backfill.Options{ScratchDir: t.TempDir()}).Run(context.Background())
	if err != nil || sum.Selected != 2 || sum.Failed != 1 || sum.Done != 1 {
		t.Fatalf("summary: %+v %v", sum, err)
	}
	if _, ok := st.set[bad.ID]; ok {
		t.Error("the failed video got a storyboard key")
	}
}

func TestVideoWithoutAQualifyingRenditionIsSkipped(t *testing.T) {
	objs := testutil.NewMemObjects()
	c := candidate(objs, time.Now(), 1)
	c.Renditions = []media.Rendition{{Name: "080p", Width: 142, Height: 80}} // under 90 px
	st := &fakeStore{cands: []backfill.Candidate{c}}
	gen := &fakeGen{}
	sum, err := runner(st, objs, gen.run, backfill.Options{ScratchDir: t.TempDir()}).Run(context.Background())
	if err != nil || sum.SkippedNoRendition != 1 || sum.Done != 0 || sum.Failed != 0 || len(gen.inputs) != 0 {
		t.Fatalf("summary: %+v %v, generated %d", sum, err, len(gen.inputs))
	}
}

func TestSelectionErrorFailsTheRun(t *testing.T) {
	st := &fakeStore{err: errors.New("db down")}
	_, err := runner(st, testutil.NewMemObjects(), nil, backfill.Options{ScratchDir: t.TempDir()}).Run(context.Background())
	if err == nil {
		t.Fatal("a database error must be returned (exit code 1)")
	}
}

func TestInterruptionStopsTheRunAndCleansUp(t *testing.T) {
	objs := testutil.NewMemObjects()
	st := &fakeStore{cands: []backfill.Candidate{candidate(objs, time.Now(), 1), candidate(objs, time.Now().Add(-time.Minute), 1)}}
	ctx, cancel := context.WithCancel(context.Background())
	gen := func(ctx context.Context, in job.StoryboardInput, dir string, d float64) (job.StoryboardResult, error) {
		cancel() // SIGINT arrives while ffmpeg runs
		return job.StoryboardResult{}, ctx.Err()
	}
	scratch := t.TempDir()
	sum, err := runner(st, objs, gen, backfill.Options{ScratchDir: scratch}).Run(ctx)
	if err != nil || sum.Failed != 0 || sum.Done != 0 {
		t.Fatalf("summary: %+v %v (an interruption is not a failure of the video)", sum, err)
	}
	if left := entries(t, scratch); len(left) != 0 {
		t.Errorf("temp dir left behind: %v", left)
	}
	if len(st.set) != 0 || len(objs.UploadOrder) != 0 {
		t.Error("an interrupted run wrote something")
	}
}

func TestPlaylistFiles(t *testing.T) {
	got, err := backfill.PlaylistFiles("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"init_0.mp4\"\n#EXTINF:2.0,\nseg_00000.m4s\n#EXTINF:2.0,\nseg_00001.m4s\n#EXT-X-ENDLIST\n")
	if err != nil || strings.Join(got, ",") != "init_0.mp4,seg_00000.m4s,seg_00001.m4s" {
		t.Fatalf("got %v, %v", got, err)
	}
	for _, bad := range []string{
		"#EXTM3U\n../../etc/passwd\n",
		"#EXTM3U\nsub/seg.m4s\n",
		"#EXTM3U\nhttp://example.com/seg.m4s\n",
		"#EXTM3U\nC:\\x.m4s\n",
		"#EXTM3U\n#EXT-X-MAP:URI=\"../init.mp4\"\n#EXTINF:2,\nseg.m4s\n",
		"#EXTM3U\n#EXT-X-MAP:BYTERANGE=\"1\"\nseg.m4s\n",
		"#EXTM3U\n#EXT-X-ENDLIST\n",
	} {
		if got, err := backfill.PlaylistFiles(bad); err == nil {
			t.Errorf("accepted %q: %v", bad, got)
		}
	}
}

func TestSummaryLine(t *testing.T) {
	s := backfill.Summary{Selected: 5, Done: 3, SkippedNoRendition: 1, Failed: 1, Duration: 1500 * time.Millisecond}
	if got, want := s.Line(false), "summary: selected=5 done=3 skipped_no_rendition=1 failed=1 lost_race=0 duration=1.5s"; got != want {
		t.Errorf("got %q want %q", got, want)
	}
	if got := s.Line(true); !strings.Contains(got, "would_do=0 dry_run=true") {
		t.Errorf("dry-run line: %q", got)
	}
}
