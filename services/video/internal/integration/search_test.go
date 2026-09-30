package integration

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/cache"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
	"github.com/luantpbk/winkey/services/video/internal/views"
)

// These tests run GET /v1/search and /v1/search/suggest (task SR1) on real
// PostgreSQL 17 and a real Valkey. Every response is validated against video.v1.yaml.

type searchStack struct {
	t     *testing.T
	pg    *testkit.Postgres
	h     http.Handler
	spec  *contract.Spec
	logs  *bytes.Buffer
	owner testutil.User
}

func startSearch(t *testing.T, searchLimit, suggestLimit int) *searchStack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	srv := startValkeyServer(t)
	logs := &bytes.Buffer{}
	log := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	rc, err := cache.NewClient(srv.URL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rc.Close() })
	proxies, err := views.ParseCIDRs([]string{"10.42.0.0/16"})
	if err != nil {
		t.Fatal(err)
	}
	h := &api.Handler{Store: &store.Postgres{Pool: pg.Pool}, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("integration-cursor-secret"), Log: log, TrustedProxies: proxies,
		Limiter: views.NewValkey(rc, time.Minute), SearchRateLimit: searchLimit, SuggestRateLimit: suggestLimit}
	r := httpx.NewRouter("video-search-it", log)
	h.Routes(r)
	return &searchStack{t: t, pg: pg, h: r, spec: contract.Load(t), logs: logs,
		owner: testutil.SeedUser(t, pg.Pool, "owner", nil, "")}
}

func (s *searchStack) seed(title string, mods ...func(*testutil.Video)) string {
	s.t.Helper()
	v := testutil.Video{Owner: s.owner.ID, Title: title}
	for _, m := range mods {
		m(&v)
	}
	return testutil.SeedVideo(s.t, s.pg.Pool, v).ID.String()
}

// get sends a request from remote (default 198.51.100.10) and checks the contract.
func (s *searchStack) get(remote, path string) (int, http.Header, []byte) {
	s.t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	req.RemoteAddr = "198.51.100.10:4000"
	if remote != "" {
		req.RemoteAddr = remote
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	p, _, _ := strings.Cut(path, "?")
	s.spec.Check(s.t, "GET", p, w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w.Code, w.Header(), w.Body.Bytes()
}

type searchPage struct {
	Items []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	} `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

func (s *searchStack) search(q string, extra ...string) searchPage {
	s.t.Helper()
	path := "/v1/search?q=" + url.QueryEscape(q)
	for _, e := range extra {
		path += "&" + e
	}
	code, hdr, body := s.get("", path)
	if code != 200 {
		s.t.Fatalf("%s: %d %s", path, code, body)
	}
	if cc := hdr.Get("Cache-Control"); cc != "public, max-age=30" {
		s.t.Fatalf("Cache-Control %q", cc)
	}
	return js[searchPage](s.t, body)
}

func (p searchPage) ids() []string {
	var out []string
	for _, it := range p.Items {
		out = append(out, it.ID)
	}
	return out
}

func searchMetric(t *testing.T, mode string) float64 {
	t.Helper()
	mfs, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "video_search_total" {
			continue
		}
		for _, mm := range mf.GetMetric() {
			for _, l := range mm.GetLabel() {
				if l.GetName() == "mode" && l.GetValue() == mode {
					return mm.GetCounter().GetValue()
				}
			}
		}
	}
	return 0
}

func TestSearchOnPostgres(t *testing.T) {
	s := startSearch(t, 1000, 1000)
	hanoi := s.seed("Du lịch Hà Nội mùa thu")
	dalat := s.seed("Đà Lạt mộng mơ")
	inDesc := s.seed("Ẩm thực", func(v *testutil.Video) { v.Description = "món ngon Hà Nội" })
	s.seed("Ngựa vằn", func(v *testutil.Video) { v.Visibility = "PRIVATE"; v.Description = "hà nội" })
	s.seed("Hà Nội bí mật", func(v *testutil.Video) { v.Visibility = "UNLISTED" })
	s.seed("Hà Nội đang xử lý", func(v *testutil.Video) { v.Status = "PROCESSING"; v.Attempts = []float32{5} })
	s.seed("Hà Nội bị ẩn", func(v *testutil.Video) { v.Hidden = true })
	ghost := testutil.SeedUser(t, s.pg.Pool, "ghost", nil, "SUSPENDED")
	s.seed("Hà Nội của người đã khóa", func(v *testutil.Video) { v.Owner = ghost.ID })

	// Folding both ways, ranking (title before description), and only what the feed shows.
	if got := s.search("ha noi").ids(); len(got) != 2 || got[0] != hanoi || got[1] != inDesc {
		t.Fatalf("ha noi: %v (want %s, %s)", got, hanoi, inDesc)
	}
	for _, q := range []string{"Đà Lạt", "da lat", "DA LAT", "  đà   lạt  "} {
		if got := s.search(q).ids(); len(got) != 1 || got[0] != dalat {
			t.Errorf("%q: %v", q, got)
		}
	}

	// Trigram fallback: only when the first page is empty; counted in the metrics.
	fts, trgm, empty := searchMetric(t, "fts"), searchMetric(t, "trgm"), searchMetric(t, "empty")
	if got := s.search("da laat mong mo").ids(); len(got) != 1 || got[0] != dalat {
		t.Fatalf("typo: %v", got)
	}
	if p := s.search("quantum chromodynamics"); len(p.Items) != 0 || p.NextCursor != nil || p.Items == nil {
		t.Fatalf("no result: %+v", p)
	}
	s.search("ha noi")
	if d := searchMetric(t, "fts") - fts; d != 1 {
		t.Errorf("fts +%v", d)
	}
	if d := searchMetric(t, "trgm") - trgm; d != 1 {
		t.Errorf("trgm +%v", d)
	}
	if d := searchMetric(t, "empty") - empty; d != 1 {
		t.Errorf("empty +%v", d)
	}
}

func TestSearchPagingCapAndCursors(t *testing.T) {
	s := startSearch(t, 1000, 1000)
	base := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	want := map[string]bool{}
	for i := 0; i < 25; i++ { // equal rank; 5 share one instant
		id := s.seed("Nhạc thư giãn", func(v *testutil.Video) { v.Published = base.Add(-time.Duration(i/5) * time.Minute) })
		want[id] = true
	}

	// limit=2: ten pages of two, then the cap ends the list although 5 results remain.
	seen := map[string]bool{}
	var order []string
	extra := []string{"limit=2"}
	var cursors []string
	for page := 1; ; page++ {
		p := s.search("nhac thu gian", extra...)
		if len(p.Items) != 2 {
			t.Fatalf("page %d has %d items", page, len(p.Items))
		}
		for _, id := range p.ids() {
			if seen[id] || !want[id] {
				t.Fatalf("page %d: %s repeated or unknown", page, id)
			}
			seen[id] = true
			order = append(order, id)
		}
		if p.NextCursor == nil {
			if page != 10 {
				t.Fatalf("list ended after %d pages, want 10", page)
			}
			break
		}
		if page == 10 {
			t.Fatal("page 10 must not have a next_cursor")
		}
		cursors = append(cursors, *p.NextCursor)
		extra = []string{"limit=2", "cursor=" + url.QueryEscape(*p.NextCursor)}
	}
	if len(seen) != 20 {
		t.Fatalf("%d results in 10 pages", len(seen))
	}
	// Without the cap the same walk (limit=100) returns all 25 in the same order.
	all := s.search("nhac thu gian", "limit=100").ids()
	if len(all) != 25 {
		t.Fatalf("%d", len(all))
	}
	for i, id := range order {
		if all[i] != id {
			t.Fatalf("paged order differs from the single page at %d", i)
		}
	}
	// A cursor of page 10's predecessor works again and gives the same page (stateless).
	again := s.search("nhac thu gian", "limit=2", "cursor="+url.QueryEscape(cursors[3])).ids()
	if again[0] != order[8] || again[1] != order[9] {
		t.Fatalf("replayed cursor: %v vs %v", again, order[8:10])
	}

	// Cursors are bound to the query text, to the endpoint and to the server.
	for name, path := range map[string]string{
		"another q":   "/v1/search?q=" + url.QueryEscape("nhac xa") + "&cursor=" + url.QueryEscape(cursors[0]),
		"garbage":     "/v1/search?q=a&cursor=xyz",
		"feed cursor": "/v1/search?q=nhac&cursor=" + url.QueryEscape(feedCursor(t, s)),
	} {
		code, _, body := s.get("", path)
		if code != 400 || js[struct {
			Code string `json:"code"`
		}](t, body).Code != "INVALID_CURSOR" {
			t.Errorf("%s: %d %s", name, code, body)
		}
	}
}

func feedCursor(t *testing.T, s *searchStack) string {
	t.Helper()
	code, _, body := s.get("", "/v1/videos?limit=1")
	p := js[searchPage](t, body)
	if code != 200 || p.NextCursor == nil {
		t.Fatalf("%d %s", code, body)
	}
	return *p.NextCursor
}

func TestSearchTrigramCursorStaysInTrigramMode(t *testing.T) {
	s := startSearch(t, 1000, 1000)
	for i := 0; i < 5; i++ {
		s.seed("Nấu phở bò tái")
	}
	var got []string
	extra := []string{"limit=2"}
	for {
		p := s.search("nau pho bo tia", extra...) // full text finds nothing: every page is a trigram page
		got = append(got, p.ids()...)
		if p.NextCursor == nil {
			break
		}
		extra = []string{"limit=2", "cursor=" + url.QueryEscape(*p.NextCursor)}
	}
	if len(got) != 5 {
		t.Fatalf("%d results: %v", len(got), got)
	}
	seen := map[string]bool{}
	for _, id := range got {
		if seen[id] {
			t.Fatalf("%s twice", id)
		}
		seen[id] = true
	}
}

func TestSearchInvalidInput(t *testing.T) {
	s := startSearch(t, 1000, 1000)
	for name, path := range map[string]string{
		"no q":         "/v1/search",
		"empty":        "/v1/search?q=",
		"blank":        "/v1/search?q=%20%20",
		"101 chars":    "/v1/search?q=" + strings.Repeat("x", 101),
		"nul":          "/v1/search?q=a%00",
		"limit":        "/v1/search?q=a&limit=101",
		"suggest none": "/v1/search/suggest",
		"suggest 1":    "/v1/search/suggest?q=a",
		"suggest 51":   "/v1/search/suggest?q=" + strings.Repeat("x", 51),
		"suggest nul":  "/v1/search/suggest?q=ab%00",
	} {
		if code, _, body := s.get("", path); code != 400 {
			t.Errorf("%s: %d %s", name, code, body)
		}
	}
	if code, _, body := s.get("", "/v1/search?q="+strings.Repeat("ế", 100)); code != 200 {
		t.Errorf("100 characters: %d %s", code, body)
	}
}

func TestSuggestOnPostgres(t *testing.T) {
	s := startSearch(t, 1000, 1000)
	s.seed("Hà Nội mùa thu")
	s.seed("Hà Nội mùa thu", func(v *testutil.Video) { v.ViewCount = 10 })
	s.seed("Hà Giang loop")
	s.seed("Hà Nội riêng tư", func(v *testutil.Video) { v.Visibility = "PRIVATE" })
	s.seed("Hà Nội bị ẩn", func(v *testutil.Video) { v.Hidden = true })
	for i := 0; i < 12; i++ {
		s.seed(fmt.Sprintf("Bánh mì số %d", i))
	}

	get := func(q string) []string {
		code, hdr, body := s.get("", "/v1/search/suggest?q="+url.QueryEscape(q))
		if code != 200 || hdr.Get("Cache-Control") != "public, max-age=60" {
			t.Fatalf("%q: %d %v %s", q, code, hdr, body)
		}
		return js[struct {
			Items []string `json:"items"`
		}](t, body).Items
	}
	if got := get("ha"); len(got) != 2 {
		t.Fatalf("ha: %v", got) // duplicates collapsed; private and hidden titles never suggested
	}
	if got := get("BANH"); len(got) != 8 {
		t.Fatalf("banh: %d %v", len(got), got)
	}
	if got := get("zzzz"); got == nil || len(got) != 0 {
		t.Fatalf("zzzz: %#v", got)
	}
}

func TestSearchRateLimitsOnValkey(t *testing.T) {
	s := startSearch(t, 3, 4)
	s.seed("Hà Nội")
	path := "/v1/search?q=ha+noi"
	flood := "203.0.113.50:1"
	for i := 0; i < 3; i++ {
		if code, _, b := s.get(flood, path); code != 200 {
			t.Fatalf("request %d: %d %s", i+1, code, b)
		}
	}
	code, hdr, body := s.get(flood, path)
	if code != http.StatusTooManyRequests {
		t.Fatalf("4th search: %d %s", code, body)
	}
	if secs, err := strconv.Atoi(hdr.Get("Retry-After")); err != nil || secs < 1 || secs > 60 {
		t.Errorf("Retry-After = %q", hdr.Get("Retry-After"))
	}
	if js[struct {
		Code string `json:"code"`
	}](t, body).Code != "RATE_LIMITED" || !strings.HasPrefix(hdr.Get("Content-Type"), "application/problem+json") {
		t.Errorf("%s %s", hdr.Get("Content-Type"), body)
	}
	// Suggest is counted apart, with its own limit (4 here; 120 by default).
	for i := 0; i < 4; i++ {
		if code, _, b := s.get(flood, "/v1/search/suggest?q=ha"); code != 200 {
			t.Fatalf("suggest %d: %d %s", i+1, code, b)
		}
	}
	if code, _, _ := s.get(flood, "/v1/search/suggest?q=ha"); code != http.StatusTooManyRequests {
		t.Errorf("5th suggest: %d", code)
	}
	// Per client IP: another address, and a client behind the trusted proxy, have their own budget.
	if code, _, _ := s.get("203.0.113.51:1", path); code != 200 {
		t.Errorf("another IP: %d", code)
	}
	if code, _, _ := s.get("10.42.0.5:1", path); code != 200 {
		t.Errorf("proxy peer itself: %d", code)
	}
	req := func(xff string) int {
		r := httptest.NewRequest("GET", path, nil)
		r.RemoteAddr = "10.42.0.5:1"
		r.Header.Set("X-Forwarded-For", xff)
		w := httptest.NewRecorder()
		s.h.ServeHTTP(w, r)
		return w.Code
	}
	if code := req("203.0.113.52"); code != 200 {
		t.Errorf("behind the proxy: %d", code)
	}
	if code := req("203.0.113.50"); code != http.StatusTooManyRequests {
		t.Errorf("the flooding client through the proxy is still limited: %d", code)
	}
}

func TestSearchDoesNotLogTheQuery(t *testing.T) {
	s := startSearch(t, 1000, 1000)
	s.seed("Nguyễn Văn A")
	const secret = "nguyen-van-a-bi-mat"
	s.get("", "/v1/search?q="+url.QueryEscape("Nguyễn Văn A"))
	s.get("", "/v1/search?q="+secret)
	s.get("", "/v1/search/suggest?q="+secret)
	s.get("", "/v1/search?q="+secret+"&cursor=bad")
	logs := s.logs.String()
	for _, banned := range []string{secret, "Nguy", "nguyen"} {
		if strings.Contains(logs, banned) {
			t.Fatalf("query text %q in the logs:\n%s", banned, logs)
		}
	}
	if !strings.Contains(logs, `"q_len":`) {
		t.Fatalf("q_len not logged:\n%s", logs)
	}
}

func TestSearchResponsesDoNotDependOnAuth(t *testing.T) {
	s := startSearch(t, 1000, 1000)
	for i := 0; i < 3; i++ {
		s.seed("Nhạc thư giãn")
	}
	s.seed("Nhạc bị ẩn", func(v *testutil.Video) { v.Hidden = true })
	anon := s.search("nhac").ids()
	for _, roles := range []string{"viewer", "viewer,moderator", "admin"} { // hidden videos stay hidden, even to moderators
		req := httptest.NewRequest("GET", "/v1/search?q=nhac", nil)
		req.RemoteAddr = "198.51.100.77:1"
		req.Header.Set("X-User-Id", s.owner.ID.String())
		req.Header.Set("X-User-Roles", roles)
		w := httptest.NewRecorder()
		s.h.ServeHTTP(w, req)
		s.spec.Check(t, "GET", "/v1/search", w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
		var got searchPage
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || strings.Join(got.ids(), ",") != strings.Join(anon, ",") {
			t.Fatalf("%s: %v vs %v (%v)", roles, got.ids(), anon, err)
		}
	}
	if len(anon) != 3 {
		t.Fatalf("%v", anon)
	}
}
