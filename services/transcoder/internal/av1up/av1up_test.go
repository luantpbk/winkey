package av1up_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/services/transcoder/internal/av1up"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

const bucket = testutil.MediaBucket

// fakeStore is an in-memory av1up.Store. CommitAV1 behaves like the SQL: nothing when the video is not READY,
// the rewrite only when READY audio tracks exist.
type fakeStore struct {
	mu        sync.Mutex
	cands     []av1up.Candidate
	selectErr error
	limits    []int
	notReady  map[uuid.UUID]bool
	previous  map[uuid.UUID]string
	ready     []hlsmaster.Track
	commitErr error
	commits   []av1up.Commit
	stored    map[uuid.UUID]string // hls_av1_master_key after commits
}

func (f *fakeStore) SelectAV1(_ context.Context, minStarts int64, limit int) ([]av1up.Candidate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.limits = append(f.limits, limit)
	if f.selectErr != nil {
		return nil, f.selectErr
	}
	var out []av1up.Candidate
	for _, c := range f.cands {
		if c.Starts7d >= minStarts && len(out) < limit {
			out = append(out, c)
		}
	}
	return out, nil
}

func (f *fakeStore) CommitAV1(ctx context.Context, c av1up.Commit, rewrite func(context.Context, string, []hlsmaster.Track) (string, error)) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.commitErr != nil {
		return "", false, f.commitErr
	}
	if f.notReady[c.VideoID] {
		return "", false, nil
	}
	key := c.MasterKey
	if len(f.ready) > 0 {
		var err error
		if key, err = rewrite(ctx, c.MasterKey, f.ready); err != nil {
			return "", false, err
		}
	}
	f.commits = append(f.commits, c)
	if f.stored == nil {
		f.stored = map[uuid.UUID]string{}
	}
	f.stored[c.VideoID] = key
	return f.previous[c.VideoID], true, nil
}

// x264Media is the real ffmpeg with the AV1 encoder swapped for x264: CI has no av1_nvenc, and the runner's
// job is everything around the encode (ladder, layout, upload order, commit).
type x264Media struct {
	tools job.Tools
	plans []media.HLSPlan
	err   error
}

func (m *x264Media) Probe(ctx context.Context, p string) (media.Info, error) {
	return m.tools.Probe(ctx, p)
}

func (m *x264Media) RunHLS(ctx context.Context, plan media.HLSPlan, dur float64, on func(float64)) error {
	m.plans = append(m.plans, plan)
	if m.err != nil {
		return m.err
	}
	plan.Encoder, plan.AV1CQ, plan.AV1MaxratePct, plan.X264Preset = media.EncoderX264, 0, 0, "ultrafast"
	return m.tools.RunHLS(ctx, plan, dur, on)
}

type fixture struct {
	objs  *testutil.MemObjects
	store *fakeStore
	media *x264Media
	cand  av1up.Candidate
}

// newFixture stores a small 360p clip as the raw source of one candidate with an H.264 set of 360p.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	tools := testutil.ToolsFromEnv(t)
	clip := testutil.MakeClip(t, tools, t.TempDir(), testutil.ClipSmall)
	data, err := os.ReadFile(clip) // #nosec G304 -- test clip
	if err != nil {
		t.Fatal(err)
	}
	objs := testutil.NewMemObjects()
	c := av1up.Candidate{ID: uuid.New(), RawBucket: testutil.RawBucket, RawKey: "owner/video/source", Starts7d: 120, H264Names: []string{"360p"}}
	objs.Put(c.RawBucket, c.RawKey, data)
	return &fixture{objs: objs, store: &fakeStore{cands: []av1up.Candidate{c}}, media: &x264Media{tools: tools}, cand: c}
}

func (f *fixture) runner(t *testing.T, opt av1up.Options) *av1up.Runner {
	if opt.Limit == 0 {
		opt.Limit = 10
	}
	if opt.MinStarts == 0 {
		opt.MinStarts = 50
	}
	opt.MediaBucket = bucket
	opt.ScratchDir = filepath.Join(t.TempDir(), "scratch")
	return &av1up.Runner{
		Store: f.store, Objects: f.objs, Media: f.media, Opt: opt,
		Log: slog.New(slog.NewJSONHandler(io.Discard, nil)), NewRunID: func() string { return "run1" },
	}
}

func (f *fixture) prefix() string { return "v/" + f.cand.ID.String() + "/av1/run1/" }

func (f *fixture) keysUnder(prefix string) []string {
	var out []string
	for _, k := range f.objs.Keys(bucket) {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	return out
}

func TestUpgradeEncodesUploadsAndCommits(t *testing.T) {
	f := newFixture(t)
	sum, err := f.runner(t, av1up.Options{NoHWDecode: true}).Run(context.Background())
	if err != nil || sum.Selected != 1 || sum.Done != 1 || sum.Failed != 0 {
		t.Fatalf("run: %+v %v", sum, err)
	}
	if len(f.media.plans) != 1 {
		t.Fatalf("plans %d", len(f.media.plans))
	}
	p := f.media.plans[0]
	if p.Encoder != media.EncoderAV1NVENC || p.AV1CQ != 0 || p.AV1MaxratePct != 0 || !p.NoHWDecode || !p.HasAudio ||
		len(p.Renditions) != 1 || p.Renditions[0].Name != "360p" {
		t.Fatalf("plan %+v", p)
	}

	// Layout and order: everything under v/{id}/av1/run1/, the master last, playlists after their segments.
	prefix := f.prefix()
	order := f.objs.UploadOrder
	if len(order) < 4 || order[len(order)-1] != prefix+media.MasterPlaylist {
		t.Fatalf("upload order %v", order)
	}
	seenPlaylist := false
	for _, k := range order {
		if !strings.HasPrefix(k, prefix) {
			t.Fatalf("key %s outside %s", k, prefix)
		}
		if strings.HasSuffix(k, "/360p/index.m3u8") {
			seenPlaylist = true
		} else if seenPlaylist && !strings.HasSuffix(k, ".m3u8") {
			t.Fatalf("segment %s uploaded after its playlist: %v", k, order)
		}
	}
	m, _ := f.objs.Get(bucket, prefix+media.MasterPlaylist)
	if m.ContentType != hlsmaster.ContentType || m.CacheControl != job.CacheImmutable {
		t.Fatalf("master headers %q %q", m.ContentType, m.CacheControl)
	}

	if len(f.store.commits) != 1 {
		t.Fatalf("commits %+v", f.store.commits)
	}
	c := f.store.commits[0]
	want := media.Select(640, 360)[0]
	if c.VideoID != f.cand.ID || c.MasterKey != prefix+media.MasterPlaylist || len(c.Renditions) != 1 ||
		c.Renditions[0].TargetK != want.TargetK*media.DefaultAV1MaxratePct/100 ||
		len(c.PlaylistKeys) != 1 || c.PlaylistKeys[0] != prefix+"360p/index.m3u8" {
		t.Fatalf("commit %+v (ladder %+v)", c, want)
	}
	if f.store.stored[f.cand.ID] != c.MasterKey {
		t.Fatalf("stored %q", f.store.stored[f.cand.ID])
	}
}

// With READY audio tracks the committed master is a rewrite next to the plain one, whose alternate audio
// URIs point from v/{id}/av1/{run}/ to v/{id}/audio/{track}/.
func TestUpgradeAppliesAudioGroup(t *testing.T) {
	f := newFixture(t)
	tid := uuid.New().String()
	f.store.ready = []hlsmaster.Track{{ID: tid, Lang: "vi", Label: "Thuyết minh", Kind: "voiceover",
		PlaylistKey: "v/" + f.cand.ID.String() + "/audio/" + tid + "/index.m3u8"}}
	sum, err := f.runner(t, av1up.Options{CQ: 30, MaxratePct: 70}).Run(context.Background())
	if err != nil || sum.Done != 1 {
		t.Fatalf("run: %+v %v", sum, err)
	}
	if p := f.media.plans[0]; p.AV1CQ != 30 || p.AV1MaxratePct != 70 {
		t.Fatalf("plan %+v", p)
	}
	key := f.store.stored[f.cand.ID]
	if !strings.HasPrefix(key, f.prefix()+"master-") {
		t.Fatalf("stored key %s", key)
	}
	o, ok := f.objs.Get(bucket, key)
	if !ok {
		t.Fatalf("rewritten master %s not uploaded", key)
	}
	body := string(o.Data)
	if !strings.Contains(body, `URI="../../audio/`+tid+`/index.m3u8"`) || !strings.Contains(body, `AUDIO="aud"`) {
		t.Fatalf("master:\n%s", body)
	}
	if c := f.store.commits[0]; c.Renditions[0].TargetK != media.Select(640, 360)[0].TargetK*70/100 {
		t.Fatalf("ceiling %d", c.Renditions[0].TargetK)
	}
}

func TestUpgradeLadderMismatchFails(t *testing.T) {
	f := newFixture(t)
	f.store.cands[0].H264Names = []string{"720p", "480p"}
	sum, err := f.runner(t, av1up.Options{}).Run(context.Background())
	if err != nil || sum.Failed != 1 || sum.Done != 0 {
		t.Fatalf("run: %+v %v", sum, err)
	}
	if len(f.media.plans) != 0 || len(f.objs.UploadOrder) != 0 || len(f.store.commits) != 0 {
		t.Fatalf("encoded or uploaded: %d plans, %v", len(f.media.plans), f.objs.UploadOrder)
	}
}

func TestUpgradeLostRaceDiscardsTheSet(t *testing.T) {
	f := newFixture(t)
	f.store.notReady = map[uuid.UUID]bool{f.cand.ID: true}
	sum, err := f.runner(t, av1up.Options{}).Run(context.Background())
	if err != nil || sum.LostRace != 1 || sum.Done != 0 {
		t.Fatalf("run: %+v %v", sum, err)
	}
	if len(f.objs.UploadOrder) == 0 {
		t.Fatal("nothing was uploaded before the commit")
	}
	if left := f.keysUnder(f.prefix()); len(left) != 0 {
		t.Fatalf("set not cleaned up: %v", left)
	}
}

func TestUpgradeFailuresCleanUp(t *testing.T) {
	t.Run("commit", func(t *testing.T) {
		f := newFixture(t)
		f.store.commitErr = errors.New("db down")
		sum, err := f.runner(t, av1up.Options{}).Run(context.Background())
		if err != nil || sum.Failed != 1 {
			t.Fatalf("run: %+v %v", sum, err)
		}
		if left := f.keysUnder(f.prefix()); len(left) != 0 {
			t.Fatalf("set not cleaned up: %v", left)
		}
	})
	t.Run("encode", func(t *testing.T) {
		f := newFixture(t)
		f.media.err = errors.New("av1_nvenc: no capable devices found")
		sum, err := f.runner(t, av1up.Options{}).Run(context.Background())
		if err != nil || sum.Failed != 1 || len(f.objs.UploadOrder) != 0 || len(f.store.commits) != 0 {
			t.Fatalf("run: %+v %v uploads %v", sum, err, f.objs.UploadOrder)
		}
	})
	t.Run("upload", func(t *testing.T) {
		f := newFixture(t)
		f.objs.UploadErr = errors.New("garage down")
		sum, err := f.runner(t, av1up.Options{}).Run(context.Background())
		if err != nil || sum.Failed != 1 || len(f.store.commits) != 0 {
			t.Fatalf("run: %+v %v", sum, err)
		}
	})
}

// A set committed by a concurrent run is replaced: its directory is removed after the commit.
func TestUpgradeRemovesReplacedSet(t *testing.T) {
	f := newFixture(t)
	old := "v/" + f.cand.ID.String() + "/av1/run0/"
	f.objs.Put(bucket, old+"master.m3u8", []byte("#EXTM3U\n"))
	f.objs.Put(bucket, old+"360p/index.m3u8", []byte("#EXTM3U\n"))
	f.store.previous = map[uuid.UUID]string{f.cand.ID: old + "master-x.m3u8"}
	sum, err := f.runner(t, av1up.Options{}).Run(context.Background())
	if err != nil || sum.Done != 1 {
		t.Fatalf("run: %+v %v", sum, err)
	}
	if left := f.keysUnder(old); len(left) != 0 {
		t.Fatalf("old set left: %v", left)
	}
	if len(f.keysUnder(f.prefix())) == 0 {
		t.Fatal("new set removed")
	}
}

func TestDryRunWritesNothing(t *testing.T) {
	f := newFixture(t)
	f.store.cands = append(f.store.cands, av1up.Candidate{ID: uuid.New(), Starts7d: 10}) // below the threshold
	r := f.runner(t, av1up.Options{DryRun: true, Limit: 5})
	sum, err := r.Run(context.Background())
	if err != nil || sum.Selected != 1 || sum.WouldDo != 1 || sum.Done != 0 {
		t.Fatalf("run: %+v %v", sum, err)
	}
	if len(f.media.plans) != 0 || len(f.objs.UploadOrder) != 0 || len(f.store.commits) != 0 || f.store.limits[0] != 5 {
		t.Fatalf("dry run wrote: %d plans, %v, %d commits", len(f.media.plans), f.objs.UploadOrder, len(f.store.commits))
	}
	if _, err := os.Stat(r.Opt.ScratchDir); !os.IsNotExist(err) {
		t.Fatalf("dry run created the scratch dir: %v", err)
	}
	if line := sum.Line(true); !strings.Contains(line, "would_do=1 dry_run=true") {
		t.Fatalf("line %q", line)
	}
}

func TestSelectErrorIsFatal(t *testing.T) {
	st := &fakeStore{selectErr: errors.New("db down")}
	r := &av1up.Runner{Store: st, Log: slog.New(slog.NewJSONHandler(io.Discard, nil)), Opt: av1up.Options{Limit: 1}}
	if _, err := r.Run(context.Background()); err == nil {
		t.Fatal("no error")
	}
}
