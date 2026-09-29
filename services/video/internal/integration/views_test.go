package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/cache"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
	"github.com/luantpbk/winkey/services/video/internal/views"
)

// These tests run POST /v1/videos/{video_id}/views (task C3) on real PostgreSQL 17
// and a real Valkey. Every response is validated against video.v1.yaml.

const viewsPath = "/v1/videos/%s/views"

type viewStack struct {
	t       *testing.T
	pg      *testkit.Postgres
	srv     *valkeyServer
	h       http.Handler
	spec    *contract.Spec
	valkey  *views.Valkey
	st      *store.Postgres
	flusher *views.Flusher
	owner   testutil.User
}

type viewOpts struct {
	dedup     time.Duration
	rateLimit int
}

func startViews(t *testing.T, o viewOpts) *viewStack {
	t.Helper()
	if o.dedup == 0 {
		o.dedup = 30 * time.Minute
	}
	pg := testkit.StartPostgres(t)
	srv := startValkeyServer(t)
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))

	rc, err := cache.NewClient(srv.URL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rc.Close() })
	vv := views.NewValkey(rc, o.dedup)
	st := &store.Postgres{Pool: pg.Pool}
	proxies, err := views.ParseCIDRs([]string{"10.42.0.0/16", "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	h := &api.Handler{Store: st, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("integration-cursor-secret"), Log: log,
		Views: vv, TrustedProxies: proxies, ViewRateLimit: o.rateLimit}
	r := httpx.NewRouter("video-views-it", log)
	h.Routes(r)
	return &viewStack{
		t: t, pg: pg, srv: srv, h: r, spec: contract.Load(t), valkey: vv, st: st,
		flusher: &views.Flusher{V: vv, DB: st, Interval: time.Hour, LockTTL: time.Minute, Log: log},
		owner:   testutil.SeedUser(t, pg.Pool, "owner", nil, ""),
	}
}

func (s *viewStack) seed(v testutil.Video) uuid.UUID {
	s.t.Helper()
	if v.Owner == uuid.Nil {
		v.Owner = s.owner.ID
	}
	return testutil.SeedVideo(s.t, s.pg.Pool, v).ID
}

// setDuration changes duration_ms of a READY video (SeedVideo makes them 61 s long).
func (s *viewStack) setDuration(id uuid.UUID, ms int) {
	s.t.Helper()
	if _, err := s.pg.Pool.Exec(context.Background(), `UPDATE media.videos SET duration_ms=$2 WHERE id=$1`, id, ms); err != nil {
		s.t.Fatal(err)
	}
}

type report struct {
	who    *actor // nil = anonymous
	remote string // peer address; default 198.51.100.10:4000
	ua     string
	xff    string
}

// post sends one report and validates the response against the contract.
func (s *viewStack) post(rp report, video uuid.UUID, body string) (int, http.Header, []byte) {
	s.t.Helper()
	req := httptest.NewRequest("POST", fmt.Sprintf(viewsPath, video), strings.NewReader(body))
	req.RemoteAddr = "198.51.100.10:4000"
	if rp.remote != "" {
		req.RemoteAddr = rp.remote
	}
	req.Header.Set("User-Agent", rp.ua)
	if rp.xff != "" {
		req.Header.Set("X-Forwarded-For", rp.xff)
	}
	if rp.who != nil {
		req.Header.Set("X-User-Id", rp.who.id.String())
		req.Header.Set("X-User-Roles", rp.who.roles)
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	s.spec.Check(s.t, "POST", "/v1/videos/{video_id}/views", w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w.Code, w.Header(), w.Body.Bytes()
}

func watched(ms int64) string {
	return fmt.Sprintf(`{"playback_id":%q,"watched_ms":%d}`, ids.NewString(), ms)
}

// counted sends a valid report and returns the counted flag; it fails on anything but 202.
func (s *viewStack) counted(rp report, video uuid.UUID, ms int64) bool {
	s.t.Helper()
	return s.countedBody(rp, video, watched(ms))
}

func (s *viewStack) countedBody(rp report, video uuid.UUID, body string) bool {
	s.t.Helper()
	code, _, b := s.post(rp, video, body)
	if code != http.StatusAccepted {
		s.t.Fatalf("status %d: %s", code, b)
	}
	var out struct {
		Counted bool `json:"counted"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		s.t.Fatal(err)
	}
	return out.Counted
}

func (s *viewStack) viewCount(id uuid.UUID) int64 {
	s.t.Helper()
	var n int64
	if err := s.pg.Pool.QueryRow(context.Background(), `SELECT view_count FROM media.videos WHERE id=$1`, id).Scan(&n); err != nil {
		s.t.Fatal(err)
	}
	return n
}

func (s *viewStack) flush() {
	s.t.Helper()
	if _, err := s.flusher.FlushOnce(context.Background()); err != nil {
		s.t.Fatal(err)
	}
}

func metric(t *testing.T, result string) float64 {
	t.Helper()
	mfs, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "video_views_total" {
			continue
		}
		for _, mm := range mf.GetMetric() {
			for _, l := range mm.GetLabel() {
				if l.GetName() == "result" && l.GetValue() == result {
					return mm.GetCounter().GetValue()
				}
			}
		}
	}
	return 0
}

func TestViewThresholdLongAndShortVideos(t *testing.T) {
	s := startViews(t, viewOpts{})
	anon := func(i int) report { return report{ua: fmt.Sprintf("ua-%d", i)} } // a new viewer each time

	long := s.seed(testutil.Video{}) // 61 s: threshold is 30 s
	if s.counted(anon(1), long, 29_999) {
		t.Error("29.999 s of a 61 s video must not count")
	}
	if !s.counted(anon(2), long, 30_000) {
		t.Error("30 s of a 61 s video must count")
	}

	short := s.seed(testutil.Video{})
	s.setDuration(short, 20_000) // threshold is half: 10 s
	if s.counted(anon(3), short, 9_999) {
		t.Error("9.999 s of a 20 s video must not count")
	}
	if !s.counted(anon(4), short, 10_000) {
		t.Error("10 s of a 20 s video must count")
	}

	tiny := s.seed(testutil.Video{})
	s.setDuration(tiny, 1_000) // threshold 500 ms
	if !s.counted(anon(5), tiny, 500) {
		t.Error("half of a 1 s video must count")
	}
	if s.counted(anon(6), tiny, 0) {
		t.Error("0 ms must not count")
	}

	s.flush()
	if s.viewCount(long) != 1 || s.viewCount(short) != 1 || s.viewCount(tiny) != 1 {
		t.Errorf("view_count long=%d short=%d tiny=%d, want 1 each", s.viewCount(long), s.viewCount(short), s.viewCount(tiny))
	}
}

func TestViewVisibilityAndStatus(t *testing.T) {
	s := startViews(t, viewOpts{})
	owner := &actor{id: s.owner.ID, roles: "viewer,creator"}
	other := &actor{id: ids.New(), roles: "viewer,creator"}

	private := s.seed(testutil.Video{Visibility: "PRIVATE"})
	unlisted := s.seed(testutil.Video{Visibility: "UNLISTED"})
	processing := s.seed(testutil.Video{Status: "PROCESSING"})
	uploading := s.seed(testutil.Video{Status: "UPLOADING"})
	failed := s.seed(testutil.Video{Status: "FAILED", Error: "boom"})

	for name, c := range map[string]struct {
		rp report
		id uuid.UUID
	}{
		"anonymous on PRIVATE":    {report{}, private},
		"other user on PRIVATE":   {report{who: other}, private},
		"unknown video":           {report{who: other}, ids.New()},
		"owner on PROCESSING":     {report{who: owner}, processing},
		"owner on UPLOADING":      {report{who: owner}, uploading},
		"owner on FAILED":         {report{who: owner}, failed},
		"anonymous on PROCESSING": {report{}, processing},
	} {
		code, _, body := s.post(c.rp, c.id, watched(40_000))
		if code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404 (%s)", name, code, body)
		}
	}
	// A video id that is not a UUID is a 404 too.
	req := httptest.NewRequest("POST", "/v1/videos/not-a-uuid/views", strings.NewReader(watched(40_000)))
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("bad id: %d", w.Code)
	}

	if !s.counted(report{who: owner}, private, 40_000) {
		t.Error("the owner counts on their own PRIVATE video")
	}
	if !s.counted(report{}, unlisted, 40_000) {
		t.Error("UNLISTED videos are readable by anyone with the id")
	}
	s.flush()
	if s.viewCount(private) != 1 || s.viewCount(unlisted) != 1 {
		t.Errorf("private=%d unlisted=%d", s.viewCount(private), s.viewCount(unlisted))
	}
	for _, id := range []uuid.UUID{processing, uploading, failed} {
		if s.viewCount(id) != 0 {
			t.Errorf("a non-READY video was counted: %d", s.viewCount(id))
		}
	}
}

func TestViewDedupPerViewerAndPerPlayback(t *testing.T) {
	s := startViews(t, viewOpts{dedup: 400 * time.Millisecond})
	video := s.seed(testutil.Video{})
	alice := &actor{id: ids.New(), roles: "viewer"}
	bob := &actor{id: ids.New(), roles: "viewer"}

	if !s.counted(report{who: alice}, video, 40_000) {
		t.Fatal("first report of alice")
	}
	if s.counted(report{who: alice}, video, 40_000) {
		t.Error("alice again, with a new playback, inside the window")
	}
	if !s.counted(report{who: bob}, video, 40_000) {
		t.Error("bob is another viewer")
	}
	// Same user from another device: the user id is the viewer, not the IP.
	if s.counted(report{who: alice, remote: "203.0.113.77:1", ua: "other-device"}, video, 40_000) {
		t.Error("alice from another IP and browser is still alice")
	}

	// The same playback_id twice (a retry) counts at most once, even for another viewer.
	pb := fmt.Sprintf(`{"playback_id":%q,"watched_ms":40000}`, ids.NewString())
	carol := &actor{id: ids.New(), roles: "viewer"}
	dave := &actor{id: ids.New(), roles: "viewer"}
	if !s.countedBody(report{who: carol}, video, pb) {
		t.Error("carol")
	}
	if s.countedBody(report{who: carol}, video, pb) {
		t.Error("retry of the same playback")
	}
	if s.countedBody(report{who: dave}, video, pb) {
		t.Error("the same playback_id must not count for another viewer")
	}

	s.srv.wait(600 * time.Millisecond)
	if !s.counted(report{who: alice}, video, 40_000) {
		t.Error("alice counts again after the dedup window")
	}
	s.flush()
	if got := s.viewCount(video); got != 4 { // alice, bob, carol, alice again
		t.Errorf("view_count = %d, want 4", got)
	}
}

func TestViewAnonymousViewersAreToldApartByIPAndUserAgent(t *testing.T) {
	s := startViews(t, viewOpts{})
	video := s.seed(testutil.Video{})
	base := report{remote: "198.51.100.10:4000", ua: "Firefox"}

	if !s.counted(base, video, 40_000) {
		t.Fatal("first anonymous viewer")
	}
	if s.counted(base, video, 40_000) {
		t.Error("same IP and UA is the same viewer")
	}
	if !s.counted(report{remote: "198.51.100.11:4000", ua: "Firefox"}, video, 40_000) {
		t.Error("another IP is another viewer")
	}
	if !s.counted(report{remote: "198.51.100.10:4000", ua: "Chrome"}, video, 40_000) {
		t.Error("another user agent is another viewer")
	}
	s.flush()
	if got := s.viewCount(video); got != 3 {
		t.Errorf("view_count = %d, want 3", got)
	}
}

func TestViewForwardedForOnlyFromTrustedPeers(t *testing.T) {
	s := startViews(t, viewOpts{})
	video := s.seed(testutil.Video{})

	// An untrusted peer cannot pick its address: every forged header is the same viewer.
	if !s.counted(report{remote: "203.0.113.9:1", ua: "x", xff: "1.1.1.1"}, video, 40_000) {
		t.Fatal("first report")
	}
	if s.counted(report{remote: "203.0.113.9:2", ua: "x", xff: "2.2.2.2"}, video, 40_000) {
		t.Error("X-Forwarded-For from an untrusted peer must be ignored")
	}

	// A trusted proxy (the gateway) speaks for its clients.
	if !s.counted(report{remote: "10.42.0.5:1", ua: "y", xff: "198.51.100.21"}, video, 40_000) {
		t.Error("client behind the proxy")
	}
	if !s.counted(report{remote: "10.42.0.5:2", ua: "y", xff: "198.51.100.22"}, video, 40_000) {
		t.Error("another client behind the same proxy is another viewer")
	}
	if s.counted(report{remote: "10.42.0.6:3", ua: "y", xff: "198.51.100.22"}, video, 40_000) {
		t.Error("the same client through another proxy replica is the same viewer")
	}
	// Left-hand entries are client supplied and ignored.
	if s.counted(report{remote: "10.42.0.5:4", ua: "y", xff: "9.9.9.9, 198.51.100.22"}, video, 40_000) {
		t.Error("only the entry added by the trusted proxy counts")
	}
}

func TestViewRateLimit(t *testing.T) {
	s := startViews(t, viewOpts{rateLimit: 5})
	video := s.seed(testutil.Video{})
	rp := report{remote: "203.0.113.50:1", ua: "flood"}
	for i := 0; i < 5; i++ {
		if code, _, b := s.post(rp, video, watched(40_000)); code != http.StatusAccepted {
			t.Fatalf("report %d: %d %s", i+1, code, b)
		}
	}
	code, hdr, body := s.post(rp, video, watched(40_000))
	if code != http.StatusTooManyRequests {
		t.Fatalf("6th report: %d %s", code, body)
	}
	if secs, err := strconv.Atoi(hdr.Get("Retry-After")); err != nil || secs < 1 || secs > 60 {
		t.Errorf("Retry-After = %q", hdr.Get("Retry-After"))
	}
	var p struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &p); err != nil || p.Code != "RATE_LIMITED" {
		t.Errorf("body %s", body)
	}
	if !strings.HasPrefix(hdr.Get("Content-Type"), "application/problem+json") {
		t.Errorf("content type %q", hdr.Get("Content-Type"))
	}
	// Another client IP has its own budget, and so does a client behind the trusted proxy.
	if code, _, _ := s.post(report{remote: "203.0.113.51:1"}, video, watched(40_000)); code != http.StatusAccepted {
		t.Errorf("another IP: %d", code)
	}
	if code, _, _ := s.post(report{remote: "10.42.0.5:1", xff: "203.0.113.52"}, video, watched(40_000)); code != http.StatusAccepted {
		t.Errorf("behind the proxy: %d", code)
	}
	if code, _, _ := s.post(report{remote: "10.42.0.5:1", xff: "203.0.113.50"}, video, watched(40_000)); code != http.StatusTooManyRequests {
		t.Errorf("the flooding client through the proxy is still limited: %d", code)
	}
	if metric(t, "rate_limited") < 2 {
		t.Errorf("video_views_total{result=rate_limited} = %v", metric(t, "rate_limited"))
	}
}

func TestViewInvalidBodies(t *testing.T) {
	s := startViews(t, viewOpts{})
	video := s.seed(testutil.Video{})
	pb := ids.NewString()
	for name, body := range map[string]string{
		"empty":               ``,
		"not json":            `nope`,
		"missing playback_id": `{"watched_ms":40000}`,
		"missing watched_ms":  fmt.Sprintf(`{"playback_id":%q}`, pb),
		"bad playback_id":     `{"playback_id":"abc","watched_ms":40000}`,
		"negative watched":    fmt.Sprintf(`{"playback_id":%q,"watched_ms":-1}`, pb),
		"watched too large":   fmt.Sprintf(`{"playback_id":%q,"watched_ms":86400001}`, pb),
		"watched is a string": fmt.Sprintf(`{"playback_id":%q,"watched_ms":"40000"}`, pb),
		"watched is a float":  fmt.Sprintf(`{"playback_id":%q,"watched_ms":1.5}`, pb),
		"unknown field":       fmt.Sprintf(`{"playback_id":%q,"watched_ms":40000,"extra":1}`, pb),
	} {
		code, hdr, b := s.post(report{ua: name}, video, body)
		if code != http.StatusBadRequest || !strings.HasPrefix(hdr.Get("Content-Type"), "application/problem+json") {
			t.Errorf("%s: %d %s", name, code, b)
		}
	}
	// The boundary values are valid.
	if code, _, b := s.post(report{ua: "max"}, video, fmt.Sprintf(`{"playback_id":%q,"watched_ms":86400000}`, ids.NewString())); code != http.StatusAccepted {
		t.Errorf("86400000: %d %s", code, b)
	}
	if code, _, b := s.post(report{ua: "zero"}, video, fmt.Sprintf(`{"playback_id":%q,"watched_ms":0}`, ids.NewString())); code != http.StatusAccepted {
		t.Errorf("0: %d %s", code, b)
	}
	s.flush()
	if got := s.viewCount(video); got != 1 {
		t.Errorf("view_count = %d, want 1", got)
	}
}

// ---- flusher on real PostgreSQL ---------------------------------------------------

func TestFlushAddsConcurrentReportsExactlyOnce(t *testing.T) {
	s := startViews(t, viewOpts{rateLimit: 100000})
	a := s.seed(testutil.Video{ViewCount: 10})
	b := s.seed(testutil.Video{})
	const n = 120
	var wg sync.WaitGroup
	var countedA, countedB atomic.Int64
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rp := report{who: &actor{id: ids.New(), roles: "viewer"}}
			if s.counted(rp, a, 40_000) {
				countedA.Add(1)
			}
			if i%3 == 0 && s.counted(rp, b, 40_000) {
				countedB.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if countedA.Load() != n || countedB.Load() != n/3 {
		t.Fatalf("counted a=%d b=%d", countedA.Load(), countedB.Load())
	}

	// Two flushers race, reports keep being applied to the same rows.
	var fw sync.WaitGroup
	for i := 0; i < 2; i++ {
		fw.Add(1)
		go func() {
			defer fw.Done()
			for j := 0; j < 5; j++ {
				if _, err := s.flusher.FlushOnce(context.Background()); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	fw.Wait()
	if got := s.viewCount(a); got != 10+n {
		t.Errorf("a: view_count %d, want %d", got, 10+n)
	}
	if got := s.viewCount(b); got != n/3 {
		t.Errorf("b: view_count %d, want %d", got, n/3)
	}
}

// flakyWriter fails while down is set, then writes through to PostgreSQL.
type flakyWriter struct {
	inner *store.Postgres
	down  atomic.Bool
}

func (f *flakyWriter) AddViews(ctx context.Context, ids []uuid.UUID, counts []int64) (int, error) {
	if f.down.Load() {
		return 0, errors.New("database unavailable")
	}
	return f.inner.AddViews(ctx, ids, counts)
}

func TestFailedFlushIsRetriedAndLosesNothing(t *testing.T) {
	s := startViews(t, viewOpts{})
	video := s.seed(testutil.Video{})
	fw := &flakyWriter{inner: s.st}
	s.flusher.DB = fw

	for i := 0; i < 4; i++ {
		s.counted(report{ua: fmt.Sprintf("u%d", i)}, video, 40_000)
	}
	fw.down.Store(true)
	if _, err := s.flusher.FlushOnce(context.Background()); err == nil {
		t.Fatal("the failed flush must be reported")
	}
	if s.viewCount(video) != 0 {
		t.Fatal("nothing may be written while the database is down")
	}
	s.counted(report{ua: "later"}, video, 40_000) // a report between the failure and the retry
	fw.down.Store(false)
	s.flush()
	if got := s.viewCount(video); got != 5 {
		t.Fatalf("view_count = %d, want 5 (4 kept from the failed batch + 1)", got)
	}
	s.flush()
	if got := s.viewCount(video); got != 5 {
		t.Fatalf("a further flush changed view_count to %d", got)
	}
}

func TestFlushOfADeletedVideoAppliesTheRest(t *testing.T) {
	s := startViews(t, viewOpts{})
	keep := s.seed(testutil.Video{})
	gone := s.seed(testutil.Video{})
	s.counted(report{ua: "1"}, keep, 40_000)
	s.counted(report{ua: "1"}, gone, 40_000)
	if _, err := s.pg.Pool.Exec(context.Background(), `DELETE FROM media.videos WHERE id=$1`, gone); err != nil {
		t.Fatal(err)
	}
	s.flush() // must not fail: a deleted video matches no row
	if s.viewCount(keep) != 1 {
		t.Errorf("view_count = %d", s.viewCount(keep))
	}
	if k, err := s.valkey.FlushKeys(context.Background()); err != nil || len(k) != 0 {
		t.Errorf("flush keys %v %v", k, err)
	}
}

func TestViewCountShowsInTheVideoAfterTheFlush(t *testing.T) {
	s := startViews(t, viewOpts{})
	video := s.seed(testutil.Video{ViewCount: 41})
	s.counted(report{ua: "1"}, video, 40_000)
	s.flush()
	req := httptest.NewRequest("GET", "/v1/videos/"+video.String(), nil)
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	var v struct {
		ViewCount int64 `json:"view_count"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil || v.ViewCount != 42 {
		t.Fatalf("%v %s", err, w.Body.String())
	}
}

// ---- Valkey down -------------------------------------------------------------------

func TestViewsWhenValkeyIsDown(t *testing.T) {
	s := startViews(t, viewOpts{})
	video := s.seed(testutil.Video{})
	s.srv.Stop(t)
	before := metric(t, "valkey_down")

	start := time.Now()
	for i := 0; i < 10; i++ {
		code, _, b := s.post(report{ua: fmt.Sprintf("u%d", i)}, video, watched(40_000))
		if code != http.StatusAccepted || !strings.Contains(string(b), `"counted":false`) {
			t.Fatalf("report %d: %d %s (must be 202 counted:false, never 5xx)", i, code, b)
		}
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("10 reports took %v: an outage must not slow the API down", d)
	}
	if got := metric(t, "valkey_down") - before; got != 10 {
		t.Errorf("video_views_total{result=valkey_down} grew by %v, want 10", got)
	}
	// Validation and visibility still work without Valkey.
	if code, _, _ := s.post(report{}, video, `{}`); code != http.StatusBadRequest {
		t.Errorf("invalid body: %d", code)
	}
	if code, _, _ := s.post(report{}, ids.New(), watched(40_000)); code != http.StatusNotFound {
		t.Errorf("unknown video: %d", code)
	}
	if s.viewCount(video) != 0 {
		t.Error("nothing was counted")
	}
}

func TestViewMetrics(t *testing.T) {
	s := startViews(t, viewOpts{})
	video := s.seed(testutil.Video{})
	c0, d0, b0 := metric(t, "counted"), metric(t, "duplicate"), metric(t, "below_threshold")
	rp := report{ua: "m"}
	s.counted(rp, video, 40_000)
	s.counted(rp, video, 40_000)
	s.counted(report{ua: "m2"}, video, 100)
	if metric(t, "counted")-c0 != 1 || metric(t, "duplicate")-d0 != 1 || metric(t, "below_threshold")-b0 != 1 {
		t.Errorf("counted %v duplicate %v below_threshold %v", metric(t, "counted")-c0, metric(t, "duplicate")-d0, metric(t, "below_threshold")-b0)
	}
}
