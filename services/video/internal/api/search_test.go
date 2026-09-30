package api

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// fakeLimiter allows n calls per scope, then refuses; err simulates Valkey down.
type fakeLimiter struct {
	mu    sync.Mutex
	allow int
	err   error
	calls []string // "scope|ip|limit"
	seen  map[string]int
}

func (f *fakeLimiter) AllowScoped(_ context.Context, scope, ip string, limit int, _ time.Duration) (bool, time.Duration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, scope+"|"+ip+"|"+strconv.Itoa(limit))
	if f.err != nil {
		return false, 0, f.err
	}
	if f.seen == nil {
		f.seen = map[string]int{}
	}
	f.seen[scope]++
	return f.seen[scope] <= f.allow, 1400 * time.Millisecond, nil
}

type searchEnv struct {
	*env
	logs *bytes.Buffer
}

func newSearchEnv(t *testing.T, lim Limiter) *searchEnv {
	t.Helper()
	e := &env{t: t, store: newMemStore(), spec: contract.Load(t)}
	logs := &bytes.Buffer{}
	log := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	h := &Handler{Store: e.store, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("test-cursor-secret-123456"), Log: log, Limiter: lim,
		MediaLinkSecret: []byte(testLinkSecret), Now: func() time.Time { return testNow },
		SearchRateLimit: 3, SuggestRateLimit: 5}
	r := httpx.NewRouter("video-test", log)
	h.Routes(r)
	e.h = r
	return &searchEnv{env: e, logs: logs}
}

func hit(n int, rank float32) domain.SearchHit {
	return domain.SearchHit{
		Summary: domain.Summary{
			ID: ids.New(), Title: "Hit " + strconv.Itoa(n), Owner: domain.Profile{ID: ids.New(), Handle: "alice", DisplayName: "Alice"},
			DurationMs: 1000, ViewCount: 1, PublishedAt: time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC).Add(-time.Duration(n) * time.Minute),
			ThumbnailKey: "v/x/thumb.jpg",
		},
		Rank: rank,
	}
}

// pages scripts a store that always has more results than the page holds.
func endless(mode string) func(domain.SearchQuery) (domain.SearchResult, error) {
	return func(q domain.SearchQuery) (domain.SearchResult, error) {
		res := domain.SearchResult{Mode: mode}
		for i := 0; i < q.Limit; i++ {
			res.Hits = append(res.Hits, hit(i, 0.5))
		}
		return res, nil
	}
}

func qs(q string) string { return "/v1/search?q=" + url.QueryEscape(q) }

func TestSearchValidation(t *testing.T) {
	e := newSearchEnv(t, nil)
	long := strings.Repeat("ế", 101)
	for name, path := range map[string]string{
		"missing":       "/v1/search",
		"empty":         "/v1/search?q=",
		"blank":         qs("   "),
		"too long":      qs(long),
		"nul":           "/v1/search?q=a%00b",
		"invalid utf-8": "/v1/search?q=%ff%fe",
		"limit 0":       qs("hà nội") + "&limit=0",
		"limit 101":     qs("hà nội") + "&limit=101",
	} {
		w := e.req(nil, "GET", path, "")
		if w.Code != http.StatusBadRequest || problemCode(t, w) != "VALIDATION_ERROR" {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	// 100 characters (not bytes) is fine, and the text is trimmed before the store sees it.
	if w := e.req(nil, "GET", qs(strings.Repeat("ế", 100)), ""); w.Code != 200 {
		t.Fatalf("100 runes: %d %s", w.Code, w.Body)
	}
	e.req(nil, "GET", qs("  Hà Nội  "), "")
	if got := e.store.searches[len(e.store.searches)-1].Q; got != "Hà Nội" {
		t.Fatalf("store got %q", got)
	}
	if len(e.store.searches) != 2 {
		t.Fatalf("invalid requests must not reach the store: %d searches", len(e.store.searches))
	}

	for name, path := range map[string]string{
		"missing":   "/v1/search/suggest",
		"one char":  "/v1/search/suggest?q=a",
		"blank":     "/v1/search/suggest?q=%20%20%20",
		"too long":  "/v1/search/suggest?q=" + strings.Repeat("a", 51),
		"nul":       "/v1/search/suggest?q=ab%00",
		"one rune":  "/v1/search/suggest?q=" + url.QueryEscape("đ "),
		"bad utf-8": "/v1/search/suggest?q=%ff%ff",
	} {
		w := e.req(nil, "GET", path, "")
		if w.Code != http.StatusBadRequest || problemCode(t, w) != "VALIDATION_ERROR" {
			t.Errorf("suggest %s: %d %s", name, w.Code, w.Body)
		}
	}
	if len(e.store.suggests) != 0 {
		t.Fatalf("invalid suggest requests reached the store: %v", e.store.suggests)
	}
	if w := e.req(nil, "GET", "/v1/search/suggest?q="+url.QueryEscape("đà"), ""); w.Code != 200 {
		t.Fatalf("2 runes: %d %s", w.Code, w.Body)
	}
}

func TestSearchPagesAreCappedAndCursorsBoundToTheQuery(t *testing.T) {
	e := newSearchEnv(t, nil)
	e.store.searchFn = endless(domain.SearchTrgm)

	path := qs("ha noi") + "&limit=3"
	var cursors []string
	for page := 1; page <= 10; page++ {
		w := e.req(nil, "GET", path, "")
		if w.Code != 200 {
			t.Fatalf("page %d: %d %s", page, w.Code, w.Body)
		}
		if cc := w.Header().Get("Cache-Control"); cc != "public, max-age=30" {
			t.Fatalf("Cache-Control %q", cc)
		}
		p := decode[pageJSON[summaryJSON]](t, w)
		if len(p.Items) != 3 {
			t.Fatalf("page %d has %d items", page, len(p.Items))
		}
		if page == 10 {
			if p.NextCursor != nil {
				t.Fatal("the 10th page must not have a next cursor")
			}
			break
		}
		if p.NextCursor == nil {
			t.Fatalf("page %d has no next cursor", page)
		}
		cursors = append(cursors, *p.NextCursor)
		path = qs("ha noi") + "&limit=3&cursor=" + url.QueryEscape(*p.NextCursor)
	}
	// The cursor pins the mode and the keyset position; the store asked for limit+1.
	last := e.store.searches[len(e.store.searches)-1]
	if last.Mode != domain.SearchTrgm || last.After == nil || last.Limit != 4 {
		t.Fatalf("last query %+v", last)
	}
	first := e.store.searches[0]
	if first.Mode != "" || first.After != nil {
		t.Fatalf("first query %+v", first)
	}

	other := qs("da lat") + "&cursor=" + url.QueryEscape(cursors[0])
	for name, p := range map[string]string{
		"another q":     other,
		"same q, cased": qs("HA NOI") + "&cursor=" + url.QueryEscape(cursors[0]),
		"garbage":       qs("ha noi") + "&cursor=abc",
		"tampered":      qs("ha noi") + "&cursor=" + url.QueryEscape("x"+cursors[0]),
		"feed cursor":   qs("ha noi") + "&cursor=" + url.QueryEscape(feedCursor(e)),
	} {
		w := e.req(nil, "GET", p, "")
		if w.Code != http.StatusBadRequest || problemCode(t, w) != "INVALID_CURSOR" {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
}

func feedCursor(e *searchEnv) string {
	for i := 0; i < 3; i++ {
		e.video(alice)
	}
	w := e.req(nil, "GET", "/v1/videos?limit=1", "")
	return *decode[pageJSON[summaryJSON]](e.t, w).NextCursor
}

func TestSearchWithoutResultIsAnEmptyPage(t *testing.T) {
	e := newSearchEnv(t, nil)
	w := e.req(nil, "GET", qs("nothing"), "")
	p := decode[pageJSON[summaryJSON]](t, w)
	if w.Code != 200 || p.Items == nil || len(p.Items) != 0 || p.NextCursor != nil {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestSearchDoesNotLogTheQuery(t *testing.T) {
	e := newSearchEnv(t, nil)
	e.store.searchFn = endless(domain.SearchFTS)
	const secret = "riêng-tư-nguyen-van-a"
	e.req(nil, "GET", qs(secret)+"&limit=2", "")
	e.req(nil, "GET", "/v1/search/suggest?q="+url.QueryEscape(secret), "")
	e.req(nil, "GET", qs(secret)+"&cursor=bad", "")
	logs := e.logs.String()
	if strings.Contains(logs, secret) || strings.Contains(logs, url.QueryEscape(secret)) || strings.Contains(logs, "q=") {
		t.Fatalf("query text in the logs:\n%s", logs)
	}
	if !strings.Contains(logs, `"q_len":`) {
		t.Fatalf("q length not logged:\n%s", logs)
	}
}

func TestSearchRateLimits(t *testing.T) {
	lim := &fakeLimiter{allow: 2}
	e := newSearchEnv(t, lim)
	e.store.searchFn = endless(domain.SearchFTS)
	for i := 0; i < 2; i++ {
		if w := e.req(nil, "GET", qs("ha noi"), ""); w.Code != 200 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	w := e.req(nil, "GET", qs("ha noi"), "")
	if w.Code != http.StatusTooManyRequests || problemCode(t, w) != "RATE_LIMITED" || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("%d retry-after=%q %s", w.Code, w.Header().Get("Retry-After"), w.Body)
	}
	if w.Header().Get("Cache-Control") == "public, max-age=30" {
		t.Fatal("a 429 must not be cacheable as a result")
	}
	if n := len(e.store.searches); n != 2 {
		t.Fatalf("a limited request reached the store: %d", n)
	}
	// Suggest has its own counter and limit.
	if w := e.req(nil, "GET", "/v1/search/suggest?q=ha", ""); w.Code != 200 {
		t.Fatalf("suggest after search limit: %d %s", w.Code, w.Body)
	}
	if w := e.req(nil, "GET", "/v1/search/suggest?q=ha", ""); w.Code != 200 {
		t.Fatalf("suggest 2: %d", w.Code)
	}
	if w := e.req(nil, "GET", "/v1/search/suggest?q=ha", ""); w.Code != http.StatusTooManyRequests {
		t.Fatalf("suggest 3: %d", w.Code)
	}
	if got := lim.calls[0]; got != "search|192.0.2.1|3" {
		t.Fatalf("limiter call %q", got)
	}
	if got := lim.calls[len(lim.calls)-1]; got != "suggest|192.0.2.1|5" {
		t.Fatalf("limiter call %q", got)
	}
	// Invalid requests count against the limit too (they cost a request), and are checked after it.
	if w := e.req(nil, "GET", "/v1/search", ""); w.Code != http.StatusTooManyRequests {
		t.Fatalf("limited before validation: %d", w.Code)
	}
}

func TestSearchDefaultRateLimits(t *testing.T) {
	lim := &fakeLimiter{allow: 1000}
	e := newSearchEnv(t, lim)
	// A handler with no explicit limits uses 60 (search) and 120 (suggest).
	h := &Handler{Store: e.store, MediaBaseURL: mediaBase, CursorSecret: []byte("test-cursor-secret-123456"),
		Log: slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil)), Limiter: lim}
	r := httpx.NewRouter("t", h.Log)
	h.Routes(r)
	lim.calls = nil
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", qs("x"), nil))
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/search/suggest?q=xx", nil))
	if strings.Join(lim.calls, ",") != "search|192.0.2.1|60,suggest|192.0.2.1|120" {
		t.Fatalf("%v", lim.calls)
	}
}

func TestSearchFailsOpenWhenTheLimiterIsDown(t *testing.T) {
	e := newSearchEnv(t, &fakeLimiter{err: errors.New("valkey down")})
	if w := e.req(nil, "GET", qs("ha noi"), ""); w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := e.req(nil, "GET", "/v1/search/suggest?q=ha", ""); w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestSuggest(t *testing.T) {
	e := newSearchEnv(t, nil)
	e.store.suggestFn = func(q string, limit int) ([]string, error) {
		if limit != 8 {
			t.Errorf("limit %d, want 8", limit)
		}
		return []string{"Hà Nội mùa thu", "Hà Nội về đêm"}, nil
	}
	w := e.req(nil, "GET", "/v1/search/suggest?q=ha+noi", "")
	got := decode[suggestionsJSON](t, w)
	if w.Code != 200 || len(got.Items) != 2 || w.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Fatalf("%d %s %v", w.Code, w.Body, w.Header())
	}
	// No match: an empty array, never null.
	e.store.suggestFn = nil
	w = e.req(nil, "GET", "/v1/search/suggest?q=zzzz", "")
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"items":[]}` {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	// Store errors are a 500 problem without the text.
	e.store.suggestFn = func(string, int) ([]string, error) { return nil, errors.New("boom") }
	w = httptest.NewRecorder() // a 500 is not in the contract, so no Spec.Check
	e.h.ServeHTTP(w, httptest.NewRequest("GET", "/v1/search/suggest?q=zzzz", nil))
	if w.Code != 500 || strings.Contains(w.Body.String(), "boom") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestSearchDoesNotDependOnAuth(t *testing.T) {
	e := newSearchEnv(t, nil)
	e.store.searchFn = endless(domain.SearchFTS)
	a := e.req(nil, "GET", qs("ha noi")+"&limit=2", "")
	b := e.req(mod, "GET", qs("ha noi")+"&limit=2", "")
	if a.Code != 200 || b.Code != 200 {
		t.Fatalf("%d %d", a.Code, b.Code)
	}
	for _, s := range e.store.searches { // the store port has no viewer at all
		if s.Q != "ha noi" {
			t.Fatalf("%+v", s)
		}
	}
}
