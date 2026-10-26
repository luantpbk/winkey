package av1up_test

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/av1up"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// fakePolicy is an in-memory av1up.PolicyStore.
type fakePolicy struct {
	mu      sync.Mutex
	ranks   []av1up.Rank
	dropped []uuid.UUID
}

func (p *fakePolicy) RankAV1(context.Context) ([]av1up.Rank, error) { return p.ranks, nil }

func (p *fakePolicy) DropAV1(_ context.Context, id uuid.UUID) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.dropped = append(p.dropped, id)
	return true, nil
}

// AV1POL (ADR-048): with TopN=1 / KeepTop=3 the run sweeps leftovers of sets dropped earlier, drops the sets
// ranked beyond 3 (objects kept for the next run) and upgrades only the top-1 video.
func TestPolicyDropsSweepsAndLimitsUpgrades(t *testing.T) {
	a, b, c, d := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	pol := &fakePolicy{ranks: []av1up.Rank{
		{ID: a, Starts7d: 90, HasAV1: true},
		{ID: b, Starts7d: 80},
		{ID: c, Starts7d: 70, HasAV1: true},
		{ID: d, Starts7d: 60, HasAV1: true},
	}}
	objs := testutil.NewMemObjects()
	objs.Put(bucket, "v/"+b.String()+"/av1/old/master.m3u8", []byte("x")) // dropped by an earlier run
	objs.Put(bucket, "v/"+b.String()+"/av1/old/1080p/seg_00000.m4s", []byte("x"))
	objs.Put(bucket, "v/"+b.String()+"/a1/hls/master.m3u8", []byte("x"))   // its H.264 set: untouched
	objs.Put(bucket, "v/"+d.String()+"/av1/run9/master.m3u8", []byte("x")) // dropped now: kept until next run
	st := &fakeStore{cands: []av1up.Candidate{{ID: b, Starts7d: 80}}}

	run := func(dry bool) av1up.Summary {
		r := &av1up.Runner{
			Store: st, Policy: pol, Objects: objs, Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
			Opt: av1up.Options{MinStarts: 0, Limit: 10, TopN: 1, KeepTop: 3, DryRun: dry, MediaBucket: bucket,
				ScratchDir: filepath.Join(t.TempDir(), "s")},
		}
		sum, err := r.Run(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return sum
	}

	// Dry run: reports, changes nothing.
	if sum := run(true); sum.Dropped != 1 || sum.Swept != 1 || sum.Selected != 0 {
		t.Fatalf("dry run: %+v", sum)
	}
	if len(pol.dropped) != 0 || len(objs.Keys(bucket)) != 4 {
		t.Fatalf("dry run changed something: dropped %v, keys %v", pol.dropped, objs.Keys(bucket))
	}

	sum := run(false)
	if sum.Dropped != 1 || sum.Swept != 1 || sum.Selected != 0 {
		t.Fatalf("run: %+v", sum)
	}
	if len(pol.dropped) != 1 || pol.dropped[0] != d { // c is third, within KeepTop 3: kept (hysteresis)
		t.Fatalf("dropped %v, want only %s", pol.dropped, d)
	}
	keys := objs.Keys(bucket)
	want := map[string]bool{"v/" + b.String() + "/a1/hls/master.m3u8": true, "v/" + d.String() + "/av1/run9/master.m3u8": true}
	if len(keys) != 2 || !want[keys[0]] || !want[keys[1]] {
		t.Fatalf("objects left: %v", keys)
	}
	if len(st.commits) != 0 {
		t.Fatalf("b is not in the top 1: nothing may be encoded, got %d commits", len(st.commits))
	}
}

// Without a policy store the runner keeps the threshold-only behaviour.
func TestNoPolicyKeepsThresholdBehaviour(t *testing.T) {
	st := &fakeStore{cands: []av1up.Candidate{{ID: uuid.New(), Starts7d: 80}, {ID: uuid.New(), Starts7d: 70}}}
	r := &av1up.Runner{Store: st, Objects: testutil.NewMemObjects(), Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		Opt: av1up.Options{MinStarts: 50, Limit: 1, TopN: 1, DryRun: true, MediaBucket: bucket}}
	sum, err := r.Run(context.Background())
	if err != nil || sum.Selected != 1 || sum.Dropped != 0 || sum.Swept != 0 || st.limits[0] != 1 {
		t.Fatalf("%+v %v limits=%v", sum, err, st.limits)
	}
}
