package views

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/cache"
)

type rig struct {
	srv *server
	rc  *redis.Client
	v   *Valkey
}

func newRig(t *testing.T, dedup time.Duration) *rig {
	t.Helper()
	srv := startServer(t)
	rc, err := cache.NewClient(srv.URL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rc.Close() })
	return &rig{srv: srv, rc: rc, v: NewValkey(rc, dedup)}
}

func (r *rig) pending(t *testing.T, video uuid.UUID) int64 {
	t.Helper()
	n, err := r.rc.HGet(context.Background(), keyPending, video.String()).Int64()
	if errors.Is(err, redis.Nil) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func (r *rig) flushKeys(t *testing.T) []string {
	t.Helper()
	k, err := r.v.FlushKeys(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func mustCount(t *testing.T, v *Valkey, video, playback uuid.UUID, viewer string) bool {
	t.Helper()
	ok, err := v.Count(context.Background(), video, playback, viewer)
	if err != nil {
		t.Error(err)
	}
	return ok
}

func TestCountDedupesPerViewerAndPerPlayback(t *testing.T) {
	r := newRig(t, 30*time.Minute)
	v1, v2 := ids.New(), ids.New()

	if !mustCount(t, r.v, v1, ids.New(), "u:a") {
		t.Fatal("first report must count")
	}
	if mustCount(t, r.v, v1, ids.New(), "u:a") {
		t.Fatal("same viewer, same video, new playback must not count again")
	}
	if !mustCount(t, r.v, v1, ids.New(), "u:b") {
		t.Fatal("another viewer counts")
	}
	if !mustCount(t, r.v, v2, ids.New(), "u:a") {
		t.Fatal("the same viewer counts on another video")
	}
	pb := ids.New()
	if !mustCount(t, r.v, v2, pb, "u:c") {
		t.Fatal("new playback counts")
	}
	if mustCount(t, r.v, v2, pb, "u:d") {
		t.Fatal("the same playback_id counts at most once, even for another viewer")
	}
	if got := r.pending(t, v1); got != 2 {
		t.Errorf("pending v1 = %d, want 2", got)
	}
	if got := r.pending(t, v2); got != 2 {
		t.Errorf("pending v2 = %d, want 2", got)
	}
}

func TestDedupExpires(t *testing.T) {
	r := newRig(t, 300*time.Millisecond)
	video := ids.New()
	if !mustCount(t, r.v, video, ids.New(), "u:a") {
		t.Fatal("first")
	}
	r.srv.wait(450 * time.Millisecond)
	if !mustCount(t, r.v, video, ids.New(), "u:a") {
		t.Fatal("the same viewer counts again after the dedup window")
	}
}

func TestConcurrentReportsOfOnePlaybackCountOnce(t *testing.T) {
	r := newRig(t, 30*time.Minute)
	video, pb := ids.New(), ids.New()
	var counted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if mustCount(t, r.v, video, pb, fmt.Sprintf("u:%d", i)) {
				counted.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if counted.Load() != 1 || r.pending(t, video) != 1 {
		t.Fatalf("counted %d, pending %d, want 1 and 1", counted.Load(), r.pending(t, video))
	}
}

func TestAllowFixedWindow(t *testing.T) {
	r := newRig(t, time.Minute)
	ctx := context.Background()
	for i := 1; i <= 3; i++ {
		ok, _, err := r.v.Allow(ctx, "203.0.113.1", 3, 600*time.Millisecond)
		if err != nil || !ok {
			t.Fatalf("report %d: ok=%v err=%v", i, ok, err)
		}
	}
	ok, retry, err := r.v.Allow(ctx, "203.0.113.1", 3, 600*time.Millisecond)
	if err != nil || ok || retry <= 0 || retry > 600*time.Millisecond {
		t.Fatalf("4th report: ok=%v retry=%v err=%v", ok, retry, err)
	}
	if ok, _, _ := r.v.Allow(ctx, "203.0.113.2", 3, 600*time.Millisecond); !ok {
		t.Fatal("another IP has its own budget")
	}
	r.srv.wait(700 * time.Millisecond)
	if ok, _, _ := r.v.Allow(ctx, "203.0.113.1", 3, 600*time.Millisecond); !ok {
		t.Fatal("the window must reset")
	}
}

func TestValkeyDown(t *testing.T) {
	r := newRig(t, time.Minute)
	r.srv.Stop(t)
	start := time.Now()
	if _, err := r.v.Count(context.Background(), ids.New(), ids.New(), "u:a"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Count: %v", err)
	}
	if _, _, err := r.v.Allow(context.Background(), "1.1.1.1", 60, time.Minute); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Allow: %v", err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("first failure took %v", d)
	}
	// The breaker is open: further calls fail at once instead of timing out each time.
	t0 := time.Now()
	for i := 0; i < 20; i++ {
		_, _ = r.v.Count(context.Background(), ids.New(), ids.New(), "u:a")
	}
	if d := time.Since(t0); d > 200*time.Millisecond {
		t.Errorf("20 calls with the breaker open took %v", d)
	}
}

// ---- flusher ---------------------------------------------------------------------

// memDB is a Writer that keeps totals per video; it can fail and be slow.
type memDB struct {
	mu     sync.Mutex
	totals map[uuid.UUID]int64
	fail   atomic.Bool
	delay  time.Duration
}

func newMemDB() *memDB { return &memDB{totals: map[uuid.UUID]int64{}} }

func (m *memDB) AddViews(_ context.Context, ids []uuid.UUID, counts []int64) (int, error) {
	time.Sleep(m.delay)
	if m.fail.Load() {
		return 0, errors.New("database unavailable")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, id := range ids {
		m.totals[id] += counts[i]
	}
	return len(ids), nil
}

func (m *memDB) total(id uuid.UUID) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.totals[id]
}

func newFlusher(r *rig, db Writer) *Flusher {
	return &Flusher{V: r.v, DB: db, Interval: 50 * time.Millisecond, LockTTL: time.Minute,
		Log: slog.New(slog.NewJSONHandler(io.Discard, nil))}
}

func TestFlushAppliesEveryReportExactlyOnce(t *testing.T) {
	r := newRig(t, time.Minute)
	db := newMemDB()
	video := ids.New()
	const n = 200
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			mustCount(t, r.v, video, ids.New(), fmt.Sprintf("u:%d", i))
		}(i)
	}
	wg.Wait()

	f := newFlusher(r, db)
	applied, err := f.FlushOnce(context.Background())
	if err != nil || applied != n {
		t.Fatalf("applied %d err %v", applied, err)
	}
	if db.total(video) != n {
		t.Fatalf("view_count +%d, want +%d", db.total(video), n)
	}
	if k := r.flushKeys(t); len(k) != 0 {
		t.Fatalf("flush keys left: %v", k)
	}
	if applied, _ := f.FlushOnce(context.Background()); applied != 0 || db.total(video) != n {
		t.Fatalf("a second flush added %d", applied)
	}
}

func TestTwoFlushersNeverDoubleCount(t *testing.T) {
	r := newRig(t, time.Minute)
	db := newMemDB()
	db.delay = 20 * time.Millisecond
	video := ids.New()
	const n = 300
	stop := make(chan struct{})
	var counters sync.WaitGroup
	for w := 0; w < 5; w++ {
		counters.Add(1)
		go func(w int) {
			defer counters.Done()
			for i := 0; i < n/5; i++ {
				mustCount(t, r.v, video, ids.New(), fmt.Sprintf("u:%d:%d", w, i))
			}
		}(w)
	}
	var flushers sync.WaitGroup
	for i := 0; i < 2; i++ {
		flushers.Add(1)
		f := newFlusher(r, db)
		go func() {
			defer flushers.Done()
			for {
				select {
				case <-stop:
					return
				default:
					_, _ = f.FlushOnce(context.Background())
				}
			}
		}()
	}
	counters.Wait()
	close(stop)
	flushers.Wait()
	// Drain what the flushers left behind.
	for i := 0; i < 3; i++ {
		if _, err := newFlusher(r, db).FlushOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if got := db.total(video); got != n {
		t.Fatalf("view_count +%d, want +%d", got, n)
	}
	if k := r.flushKeys(t); len(k) != 0 {
		t.Fatalf("flush keys left: %v", k)
	}
}

func TestFailedFlushLosesNothing(t *testing.T) {
	r := newRig(t, time.Minute)
	db := newMemDB()
	video := ids.New()
	for i := 0; i < 5; i++ {
		mustCount(t, r.v, video, ids.New(), fmt.Sprintf("u:%d", i))
	}
	f := newFlusher(r, db)
	db.fail.Store(true)
	if _, err := f.FlushOnce(context.Background()); err == nil {
		t.Fatal("the failure must be reported")
	}
	if db.total(video) != 0 || len(r.flushKeys(t)) != 1 {
		t.Fatalf("total %d, flush keys %v: the batch must be kept", db.total(video), r.flushKeys(t))
	}
	// More views arrive while the database is down; a second failing pass keeps both batches.
	for i := 5; i < 8; i++ {
		mustCount(t, r.v, video, ids.New(), fmt.Sprintf("u:%d", i))
	}
	if _, err := f.FlushOnce(context.Background()); err == nil {
		t.Fatal("still failing")
	}
	if len(r.flushKeys(t)) != 2 {
		t.Fatalf("flush keys: %v", r.flushKeys(t))
	}
	// The database is back: the next tick applies everything, once.
	db.fail.Store(false)
	if _, err := f.FlushOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if db.total(video) != 8 || len(r.flushKeys(t)) != 0 || r.pending(t, video) != 0 {
		t.Fatalf("total %d, flush keys %v, pending %d", db.total(video), r.flushKeys(t), r.pending(t, video))
	}
}

func TestLeftoverFlushKeysArePickedUpAtStart(t *testing.T) {
	r := newRig(t, time.Minute)
	db := newMemDB()
	a, b := ids.New(), ids.New()
	// A replica that crashed after RENAME left this behind.
	key := flushPrefix + uuid.NewString()
	if err := r.rc.HSet(context.Background(), key, a.String(), 7, b.String(), 3).Err(); err != nil {
		t.Fatal(err)
	}
	mustCount(t, r.v, a, ids.New(), "u:x") // and a fresh pending view

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	f := newFlusher(r, db)
	f.Interval = time.Hour // only the pass at startup runs
	go func() { _ = f.Run(ctx); close(done) }()
	waitUntil(t, "leftover applied", func() bool { return db.total(a) == 8 && db.total(b) == 3 })
	cancel()
	<-done
	if len(r.flushKeys(t)) != 0 {
		t.Fatalf("flush keys left: %v", r.flushKeys(t))
	}
}

func TestLockedBatchIsSkippedAndTakenOverWhenTheLockExpires(t *testing.T) {
	r := newRig(t, time.Minute)
	db := newMemDB()
	a := ids.New()
	key := flushPrefix + uuid.NewString()
	if err := r.rc.HSet(context.Background(), key, a.String(), 4).Err(); err != nil {
		t.Fatal(err)
	}
	// Another replica is applying it right now.
	if ok, err := r.v.Lock(context.Background(), key, 400*time.Millisecond); err != nil || !ok {
		t.Fatal(ok, err)
	}
	f := newFlusher(r, db)
	if _, err := f.FlushOnce(context.Background()); err != nil || db.total(a) != 0 {
		t.Fatalf("a batch locked by another replica must be left alone: total %d err %v", db.total(a), err)
	}
	r.srv.wait(500 * time.Millisecond) // the holder died; the lock expires
	if _, err := f.FlushOnce(context.Background()); err != nil || db.total(a) != 4 {
		t.Fatalf("total %d err %v", db.total(a), err)
	}
}

func TestMalformedEntriesAreDroppedNotApplied(t *testing.T) {
	r := newRig(t, time.Minute)
	db := newMemDB()
	a := ids.New()
	key := flushPrefix + uuid.NewString()
	if err := r.rc.HSet(context.Background(), key, a.String(), 2, "not-a-uuid", 5, ids.NewString(), "x", ids.NewString(), -3).Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := newFlusher(r, db).FlushOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if db.total(a) != 2 || len(db.totals) != 1 || len(r.flushKeys(t)) != 0 {
		t.Fatalf("totals %v keys %v", db.totals, r.flushKeys(t))
	}
}

func TestRunFlushesEveryIntervalAndOnShutdown(t *testing.T) {
	r := newRig(t, time.Minute)
	db := newMemDB()
	video := ids.New()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	f := newFlusher(r, db)
	go func() { _ = f.Run(ctx); close(done) }()

	mustCount(t, r.v, video, ids.New(), "u:1")
	waitUntil(t, "periodic flush", func() bool { return db.total(video) == 1 })

	mustCount(t, r.v, video, ids.New(), "u:2")
	cancel() // shutting down: the pass on the way out (or the last tick) must apply it
	<-done
	waitUntil(t, "final flush", func() bool { return db.total(video) == 2 })
}

func TestFlushWhenValkeyIsDownReportsAnError(t *testing.T) {
	r := newRig(t, time.Minute)
	r.srv.Stop(t)
	if _, err := newFlusher(r, newMemDB()).FlushOnce(context.Background()); err == nil {
		t.Fatal("an outage must be reported")
	}
}

func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// One Flusher value used from several goroutines (the race detector guards the defaults).
func TestSharedFlusherIsSafeForConcurrentUse(t *testing.T) {
	r := newRig(t, time.Minute)
	db := newMemDB()
	video := ids.New()
	for i := 0; i < 30; i++ {
		mustCount(t, r.v, video, ids.New(), fmt.Sprintf("u:%d", i))
	}
	f := &Flusher{V: r.v, DB: db, Log: slog.New(slog.NewJSONHandler(io.Discard, nil))} // defaults unset
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.FlushOnce(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if db.total(video) != 30 {
		t.Fatalf("view_count +%d, want +30", db.total(video))
	}
}

func TestAllowScopedKeepsOneCounterPerScopeAndIP(t *testing.T) {
	r := newRig(t, time.Minute)
	ctx := context.Background()
	const ip = "203.0.113.9"
	for i := 1; i <= 2; i++ {
		if ok, _, err := r.v.AllowScoped(ctx, "search", ip, 2, time.Minute); err != nil || !ok {
			t.Fatalf("search %d: ok=%v err=%v", i, ok, err)
		}
	}
	if ok, retry, err := r.v.AllowScoped(ctx, "search", ip, 2, time.Minute); err != nil || ok || retry <= 0 {
		t.Fatalf("3rd search: ok=%v retry=%v err=%v", ok, retry, err)
	}
	// Other scopes, the view counter's own limit and other IPs are untouched.
	if ok, _, _ := r.v.AllowScoped(ctx, "suggest", ip, 2, time.Minute); !ok {
		t.Fatal("suggest shares the search counter")
	}
	if ok, _, _ := r.v.Allow(ctx, ip, 1, time.Minute); !ok {
		t.Fatal("the view limit shares the search counter")
	}
	if ok, _, _ := r.v.AllowScoped(ctx, "search", "203.0.113.10", 2, time.Minute); !ok {
		t.Fatal("another IP shares the counter")
	}
	r.srv.Stop(t)
	if _, _, err := r.v.AllowScoped(ctx, "search", ip, 2, time.Minute); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Valkey down: %v", err)
	}
}
