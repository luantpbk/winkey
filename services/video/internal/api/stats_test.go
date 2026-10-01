package api

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

func day(s string) time.Time {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		panic(err)
	}
	return t
}

// today in the tests: testNow is 2026-10-01 12:00 UTC = 19:00 in Asia/Ho_Chi_Minh, the same calendar day.
func TestStatsTodayIsTheCalendarDayInHoChiMinh(t *testing.T) {
	for in, want := range map[string]string{
		"2026-10-01T16:59:59Z": "2026-10-01", // 23:59:59 in Ho Chi Minh
		"2026-10-01T17:00:00Z": "2026-10-02", // 00:00:00 the next day
		"2026-10-01T00:00:00Z": "2026-10-01",
		"2026-12-31T17:00:00Z": "2027-01-01",
	} {
		ts, _ := time.Parse(time.RFC3339, in)
		if got := statsToday(ts).Format(dateLayout); got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
}

func TestParseStatsRange(t *testing.T) {
	today := day("2026-10-01")
	type c struct {
		from, to         string
		wantFrom, wantTo string
		badField         string
	}
	for name, tc := range map[string]c{
		"defaults":                 {"", "", "2026-09-04", "2026-10-01", ""}, // 28 days
		"to only":                  {"", "2026-09-30", "2026-09-03", "2026-09-30", ""},
		"to in the future":         {"", "2026-12-31", "2026-09-04", "2026-10-01", ""}, // clamped
		"from only":                {"2026-09-20", "", "2026-09-20", "2026-10-01", ""},
		"one day":                  {"2026-10-01", "2026-10-01", "2026-10-01", "2026-10-01", ""},
		"90 days is the maximum":   {"2026-07-04", "2026-10-01", "2026-07-04", "2026-10-01", ""},
		"91 days":                  {"2026-07-03", "2026-10-01", "", "", "from"},
		"from after to":            {"2026-10-02", "2026-10-01", "", "", "from"},
		"from after clamped to":    {"2026-10-05", "2026-12-31", "", "", "from"},
		"malformed from":           {"2026-9-1", "", "", "", "from"},
		"malformed to":             {"", "yesterday", "", "", "to"},
		"timestamp is not a date":  {"2026-09-01T00:00:00Z", "", "", "", "from"},
		"730 days ago is allowed":  {"2024-10-01", "2024-10-10", "2024-10-01", "2024-10-10", ""},
		"731 days ago":             {"2024-09-30", "2024-10-10", "", "", "from"},
		"old range, not too long":  {"2024-01-01", "2024-01-10", "", "", "from"},
		"default from with old to": {"", "2024-09-01", "", "", "from"},
	} {
		from, to, fe := ParseStatsRange(tc.from, tc.to, today)
		if tc.badField != "" {
			if len(fe) != 1 || fe[0].Field != tc.badField {
				t.Errorf("%s: %v", name, fe)
			}
			continue
		}
		if len(fe) != 0 || from.Format(dateLayout) != tc.wantFrom || to.Format(dateLayout) != tc.wantTo {
			t.Errorf("%s: %s..%s %v, want %s..%s", name, from.Format(dateLayout), to.Format(dateLayout), fe, tc.wantFrom, tc.wantTo)
		}
	}
}

func statsPath(v domain.Video, q string) string {
	return "/v1/studio/videos/" + v.ID.String() + "/stats" + q
}

func (e *env) setDaily(v domain.Video, rows ...domain.DailyStats) {
	if e.store.daily == nil {
		e.store.daily = map[uuid.UUID][]domain.DailyStats{}
	}
	e.store.daily[v.ID] = rows
}

func p(n int) *int { return &n }

func TestVideoStatsFillsMissingDaysAndComputesTotals(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice, func(v *domain.Video) { v.ViewCount = 777 })
	r1 := time.Date(2026, 9, 30, 3, 0, 0, 0, time.UTC)
	r2 := time.Date(2026, 10, 1, 11, 50, 0, 0, time.UTC)
	e.setDaily(v,
		domain.DailyStats{Day: day("2026-09-29"), Starts: 3, WatchedMs: 100_000, RebufferMs: 0, Errors: 1, Viewers: 2, StartupP50Ms: p(300), StartupP95Ms: p(900), RefreshedAt: r1},
		domain.DailyStats{Day: day("2026-10-01"), Starts: 4, WatchedMs: 50_001, RebufferMs: 5_000, Errors: 0, Viewers: 3, RefreshedAt: r2},
	)
	w := e.req(alice, "GET", statsPath(v, "?from=2026-09-28&to=2026-10-02"), "") // to is clamped to today (10-01)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body)
	}
	got := decode[videoStatsJSON](t, w)
	if got.VideoID != v.ID.String() || got.From != "2026-09-28" || got.To != "2026-10-01" || got.Timezone != "Asia/Ho_Chi_Minh" || got.ViewCount != 777 {
		t.Fatalf("%+v", got)
	}
	if len(got.Days) != 4 {
		t.Fatalf("%d days", len(got.Days))
	}
	var days []string
	for _, d := range got.Days {
		days = append(days, d.Day)
	}
	if strings.Join(days, ",") != "2026-09-28,2026-09-29,2026-09-30,2026-10-01" {
		t.Fatal(days)
	}
	empty := got.Days[0]
	if empty.Starts != 0 || empty.WatchTimeMs != 0 || empty.Viewers != 0 || empty.RebufferRatio != nil || empty.StartupP50Ms != nil || empty.StartupP95Ms != nil {
		t.Fatalf("a day without data: %+v", empty)
	}
	d := got.Days[1]
	if d.Starts != 3 || d.Viewers != 2 || d.RebufferRatio == nil || *d.RebufferRatio != 0 || *d.StartupP50Ms != 300 || *d.StartupP95Ms != 900 {
		t.Fatalf("%+v", d)
	}
	last := got.Days[3]
	if last.StartupP50Ms != nil || last.RebufferRatio == nil || *last.RebufferRatio != 5000.0/55001.0 {
		t.Fatalf("%+v", last)
	}
	tot := got.Totals
	if tot.Starts != 7 || tot.WatchTimeMs != 150_001 || tot.Errors != 1 || tot.AvgWatchMs == nil || *tot.AvgWatchMs != 21428 /* floor(150001/7) */ ||
		tot.RebufferRatio == nil || *tot.RebufferRatio != 5000.0/155001.0 {
		t.Fatalf("%+v", tot)
	}
	if got.RefreshedAt == nil || !got.RefreshedAt.Equal(r2) {
		t.Fatalf("refreshed_at %v, want the latest row %v", got.RefreshedAt, r2)
	}
}

func TestVideoStatsWithoutDataIsAllZerosAndNulls(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	w := e.req(alice, "GET", statsPath(v, "?from=2026-09-30&to=2026-10-01"), "")
	got := decode[videoStatsJSON](t, w)
	if w.Code != 200 || len(got.Days) != 2 || got.RefreshedAt != nil || got.Totals.AvgWatchMs != nil || got.Totals.RebufferRatio != nil ||
		got.Totals.Starts != 0 || got.Totals.Errors != 0 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), `"days":null`) {
		t.Fatal("days must be an array")
	}
}

func TestVideoStatsDefaultRangeIs28Days(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	got := decode[videoStatsJSON](t, e.req(alice, "GET", statsPath(v, ""), ""))
	if len(got.Days) != 28 || got.From != "2026-09-04" || got.To != "2026-10-01" {
		t.Fatalf("%d days %s..%s", len(got.Days), got.From, got.To)
	}
	// 90 days exactly is fine, one more is not.
	if w := e.req(alice, "GET", statsPath(v, "?from=2026-07-04"), ""); w.Code != 200 || len(decode[videoStatsJSON](t, w).Days) != 90 {
		t.Fatalf("%d", w.Code)
	}
}

func TestVideoStatsAccess(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	if w := e.req(anon, "GET", statsPath(v, ""), ""); w.Code != 401 {
		t.Fatalf("anonymous: %d", w.Code)
	}
	if w := e.req(bob, "GET", statsPath(v, ""), ""); w.Code != 404 {
		t.Fatalf("another user: %d, want 404 (never 403)", w.Code)
	}
	if w := e.req(admin, "GET", statsPath(v, ""), ""); w.Code != 200 {
		t.Fatalf("admin: %d", w.Code)
	}
	mod := &who{ids.New(), "moderator"}
	if w := e.req(mod, "GET", statsPath(v, ""), ""); w.Code != 404 {
		t.Fatalf("moderator: %d, owner or admin only", w.Code)
	}
	unknown := domain.Video{ID: ids.New()}
	if w := e.req(alice, "GET", statsPath(unknown, ""), ""); w.Code != 404 {
		t.Fatalf("missing video: %d", w.Code)
	}
	if w := e.req(alice, "GET", "/v1/studio/videos/not-a-uuid/stats", ""); w.Code != 404 {
		t.Fatalf("bad id: %d", w.Code)
	}
	// The same answer for a video of someone else and a video that does not exist.
	if problemCode(t, e.req(bob, "GET", statsPath(v, ""), "")) != problemCode(t, e.req(bob, "GET", statsPath(unknown, ""), "")) {
		t.Fatal("another user's video and a missing video must look the same")
	}
	reads := e.store.statsReads
	e.req(alice, "GET", statsPath(v, "?from=2026-09-30&to=2026-09-01"), "")
	if e.store.statsReads != reads {
		t.Fatal("a bad range reached the store")
	}
}

func TestStatsRejectsBadRanges(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	for name, q := range map[string]string{
		"malformed from": "?from=nope",
		"malformed to":   "?to=2026-13-40",
		"from after to":  "?from=2026-09-30&to=2026-09-01",
		"91 days":        "?from=2026-07-03&to=2026-10-01",
		"too old":        "?from=2024-09-30&to=2024-10-02",
	} {
		for path, who := range map[string]*who{statsPath(v, q): alice, "/v1/studio/stats" + q: alice} {
			w := e.req(who, "GET", path, "")
			if w.Code != 400 || problemCode(t, w) != "VALIDATION_ERROR" {
				t.Errorf("%s %s: %d %s", name, path, w.Code, w.Body)
			}
		}
	}
}

func TestChannelStatsDaysTotalsAndTopVideos(t *testing.T) {
	e := newEnv(t, false)
	a, b := ids.New(), ids.New()
	ref := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	e.store.channel = domain.ChannelStatsData{
		Days: []domain.ChannelDay{
			{Day: day("2026-09-30"), Starts: 5, WatchedMs: 40_000, RebufferMs: 10_000, Errors: 2, RefreshedAt: ref.Add(-time.Hour)},
			{Day: day("2026-10-01"), Starts: 1, WatchedMs: 0, RebufferMs: 0, Errors: 0, RefreshedAt: ref},
		},
		Top: []domain.TopVideo{{ID: a, Title: "Big", Starts: 5, WatchedMs: 30_000}, {ID: b, Title: "Small", Starts: 1, WatchedMs: 10_000}},
	}
	w := e.req(alice, "GET", "/v1/studio/stats?from=2026-09-29&to=2026-10-01", "")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body)
	}
	got := decode[channelStatsJSON](t, w)
	if len(got.Days) != 3 || got.Days[0].Starts != 0 || got.Days[0].RebufferRatio != nil || got.Days[1].Starts != 5 ||
		got.Days[1].RebufferRatio == nil || *got.Days[1].RebufferRatio != 0.2 || got.Days[2].RebufferRatio != nil {
		t.Fatalf("%+v", got.Days)
	}
	if got.Totals.Starts != 6 || got.Totals.WatchTimeMs != 40_000 || got.Totals.Errors != 2 || *got.Totals.AvgWatchMs != 6666 || *got.Totals.RebufferRatio != 0.2 {
		t.Fatalf("%+v", got.Totals)
	}
	if len(got.TopVideos) != 2 || got.TopVideos[0].Title != "Big" || got.TopVideos[1].VideoID != b.String() {
		t.Fatalf("%+v", got.TopVideos)
	}
	if got.RefreshedAt == nil || !got.RefreshedAt.Equal(ref) {
		t.Fatalf("%v", got.RefreshedAt)
	}
	if strings.Contains(w.Body.String(), "viewers") {
		t.Fatal("channel days have no viewers")
	}
	if w := e.req(anon, "GET", "/v1/studio/stats", ""); w.Code != 401 {
		t.Fatalf("anonymous: %d", w.Code)
	}
}

func TestChannelStatsWithNothingIsAnEmptyShape(t *testing.T) {
	e := newEnv(t, false)
	w := e.req(bob, "GET", "/v1/studio/stats?from=2026-10-01&to=2026-10-01", "")
	body := w.Body.String()
	if w.Code != 200 || !strings.Contains(body, `"top_videos":[]`) || !strings.Contains(body, `"refreshed_at":null`) {
		t.Fatalf("%d %s", w.Code, body)
	}
}

func TestStatsRateLimitIsPerUserAndSharedByBothRoutes(t *testing.T) {
	lim := &fakeLimiter{allow: 3}
	e := newSearchEnv(t, lim)
	v := e.video(alice)
	codes := []int{
		e.req(alice, "GET", statsPath(v, ""), "").Code,
		e.req(alice, "GET", "/v1/studio/stats", "").Code,
		e.req(alice, "GET", statsPath(v, ""), "").Code,
	}
	w := e.req(alice, "GET", "/v1/studio/stats", "")
	if codes[0] != 200 || codes[1] != 200 || codes[2] != 200 || w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatalf("%v %d", codes, w.Code)
	}
	want := fmt.Sprintf("studio-stats|%s|60", alice.id)
	for _, c := range lim.calls {
		if c != want {
			t.Fatalf("limiter call %q, want %q (scope|user id|limit)", c, want)
		}
	}
}
