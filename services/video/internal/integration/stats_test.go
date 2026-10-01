package integration

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Task R1-b on real PostgreSQL 17 with migration 000015: getVideoStats and getChannelStats over analytics.video_daily
// rows (written the way the rollup writes them), every response validated against video.v1.yaml. The rollup itself
// is tested in services/analytics against real ClickHouse (a separate Go module: its internals cannot be imported here).

type statsDay struct {
	video, owner                          uuid.UUID
	day                                   time.Time
	starts, watched, rebuffer, errs, view int64
	p50, p95                              *int32
	refreshed                             time.Time
}

func seedDaily(t *testing.T, s *stack, rows ...statsDay) {
	t.Helper()
	for _, r := range rows {
		if _, err := s.pg.Pool.Exec(context.Background(), `
			INSERT INTO analytics.video_daily (video_id, owner_id, day, starts, watched_ms, rebuffer_ms, errors, viewers, startup_p50_ms, startup_p95_ms, refreshed_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			r.video, r.owner, r.day, r.starts, r.watched, r.rebuffer, r.errs, r.view, r.p50, r.p95, r.refreshed); err != nil {
			t.Fatal(err)
		}
	}
}

type totalsT struct {
	Starts        int64    `json:"starts"`
	WatchTimeMs   int64    `json:"watch_time_ms"`
	AvgWatchMs    *int64   `json:"avg_watch_ms"`
	RebufferRatio *float64 `json:"rebuffer_ratio"`
	Errors        int64    `json:"errors"`
}

type videoStatsT struct {
	VideoID   string  `json:"video_id"`
	Timezone  string  `json:"timezone"`
	ViewCount int64   `json:"view_count"`
	Totals    totalsT `json:"totals"`
	Days      []struct {
		Day          string `json:"day"`
		Starts       int64  `json:"starts"`
		WatchTimeMs  int64  `json:"watch_time_ms"`
		Viewers      int64  `json:"viewers"`
		StartupP50Ms *int   `json:"startup_p50_ms"`
	} `json:"days"`
	RefreshedAt *time.Time `json:"refreshed_at"`
}

type channelStatsT struct {
	Totals totalsT `json:"totals"`
	Days   []struct {
		Day         string `json:"day"`
		Starts      int64  `json:"starts"`
		WatchTimeMs int64  `json:"watch_time_ms"`
	} `json:"days"`
	TopVideos []struct {
		VideoID     string `json:"video_id"`
		Title       string `json:"title"`
		Starts      int64  `json:"starts"`
		WatchTimeMs int64  `json:"watch_time_ms"`
	} `json:"top_videos"`
	RefreshedAt *time.Time `json:"refreshed_at"`
}

// daysAgo is the Asia/Ho_Chi_Minh calendar date n days before today, as midnight UTC.
func daysAgo(n int) time.Time {
	loc, err := time.LoadLocation("Asia/Ho_Chi_Minh")
	if err != nil {
		panic(err)
	}
	y, m, d := time.Now().In(loc).Date()
	return time.Date(y, m, d-n, 0, 0, 0, 0, time.UTC)
}

func ymd(t time.Time) string { return t.Format("2006-01-02") }

func p32(v int32) *int32 { return &v }

func TestVideoStatsOnPostgres(t *testing.T) {
	s := start(t)
	a := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	b := testutil.SeedUser(t, s.pg.Pool, "bob", nil, "")
	alice, bob := &actor{a.ID, "viewer,creator"}, &actor{b.ID, "viewer,creator"}
	admin := &actor{ids.New(), "admin"}
	a1 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID, Title: "A one", ViewCount: 321}).ID
	a2 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID, Title: "A two"}).ID

	d2, d0 := daysAgo(2), daysAgo(0)
	r0 := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	r1 := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	seedDaily(t, s,
		statsDay{a1, a.ID, d2, 4, 40_000, 10_000, 1, 3, p32(300), p32(900), r0},
		statsDay{a1, a.ID, d0, 1, 10_000, 0, 0, 1, p32(500), p32(500), r1},
		statsDay{a2, a.ID, d0, 9, 90_000, 0, 0, 7, nil, nil, r0}, // another video: never in a1's numbers
	)
	path := "/v1/studio/videos/" + a1.String() + "/stats?from=" + ymd(d2) + "&to=" + ymd(d0)

	code, hdr, body := s.do(alice, "GET", path, "")
	if code != 200 || hdr.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("owner: %d %v %s", code, hdr, body)
	}
	vs := js[videoStatsT](t, body)
	if vs.VideoID != a1.String() || vs.Timezone != "Asia/Ho_Chi_Minh" || vs.ViewCount != 321 || len(vs.Days) != 3 {
		t.Fatalf("%+v", vs)
	}
	d := vs.Days
	if d[0].Day != ymd(d2) || d[0].Starts != 4 || d[0].Viewers != 3 || *d[0].StartupP50Ms != 300 ||
		d[1].Day != ymd(daysAgo(1)) || d[1].Starts != 0 || d[1].StartupP50Ms != nil || d[2].WatchTimeMs != 10_000 {
		t.Fatalf("%+v", d)
	}
	if vs.Totals.Starts != 5 || vs.Totals.WatchTimeMs != 50_000 || *vs.Totals.AvgWatchMs != 10_000 || vs.Totals.Errors != 1 ||
		*vs.Totals.RebufferRatio != 10_000.0/60_000.0 {
		t.Fatalf("%+v", vs.Totals)
	}
	if vs.RefreshedAt == nil || !vs.RefreshedAt.Equal(r1) {
		t.Fatalf("refreshed_at %v, want %v", vs.RefreshedAt, r1)
	}

	if code, _, _ := s.do(admin, "GET", path, ""); code != 200 {
		t.Fatalf("admin: %d", code)
	}
	if code, _, _ := s.do(bob, "GET", path, ""); code != 404 {
		t.Fatalf("another owner: %d", code)
	}
	if code, _, _ := s.do(nil, "GET", path, ""); code != 401 {
		t.Fatalf("anonymous: %d", code)
	}
	if code, _, _ := s.do(alice, "GET", "/v1/studio/videos/"+ids.New().String()+"/stats", ""); code != 404 {
		t.Fatalf("unknown video: %d", code)
	}
	// A video with no rows at all: zeros, null refreshed_at.
	empty := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID}).ID
	code, _, body = s.do(alice, "GET", "/v1/studio/videos/"+empty.String()+"/stats?from="+ymd(d0)+"&to="+ymd(d0), "")
	if e := js[videoStatsT](t, body); code != 200 || e.RefreshedAt != nil || len(e.Days) != 1 || e.Totals.Starts != 0 || e.Totals.AvgWatchMs != nil {
		t.Fatalf("%d %s", code, body)
	}
	if code, _, _ := s.do(alice, "GET", "/v1/studio/videos/"+a1.String()+"/stats?from=2000-01-01", ""); code != 400 {
		t.Fatalf("a range older than 730 days: %d", code)
	}
}

func TestChannelStatsOnPostgresExcludeDeletedAndTransferredVideos(t *testing.T) {
	s := start(t)
	a := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	b := testutil.SeedUser(t, s.pg.Pool, "bob", nil, "")
	alice, bob := &actor{a.ID, "viewer,creator"}, &actor{b.ID, "viewer,creator"}
	a1 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID, Title: "A one"}).ID
	a2 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID, Title: "A two"}).ID
	a3 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID, Title: "A three"}).ID
	gone := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID, Title: "A deleted"}).ID
	b1 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: b.ID, Title: "B one"}).ID
	d1, d0 := daysAgo(1), daysAgo(0)
	ref := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	seedDaily(t, s,
		statsDay{a1, a.ID, d1, 5, 50_000, 5_000, 0, 3, nil, nil, ref},
		statsDay{a2, a.ID, d1, 7, 50_000, 0, 0, 5, nil, nil, ref}, // same watch time as a1, more starts: ranked first
		statsDay{a3, a.ID, d0, 0, 100, 0, 0, 1, nil, nil, ref},    // no starts: left out of top_videos
		statsDay{gone, a.ID, d1, 99, 9_999_999, 0, 0, 9, nil, nil, ref},
		statsDay{b1, b.ID, d1, 50, 5_000_000, 0, 0, 40, nil, nil, ref},
		statsDay{b1, a.ID, d0, 1000, 1000, 0, 0, 1, nil, nil, ref}, // stale owner_id: b1 belongs to bob
	)
	q := "?from=" + ymd(d1) + "&to=" + ymd(d0)
	get := func(u *actor) channelStatsT {
		t.Helper()
		code, hdr, body := s.do(u, "GET", "/v1/studio/stats"+q, "")
		if code != 200 || hdr.Get("Cache-Control") != "private, no-store" {
			t.Fatalf("%d %v %s", code, hdr, body)
		}
		return js[channelStatsT](t, body)
	}
	titles := func(c channelStatsT) string {
		var out []string
		for _, v := range c.TopVideos {
			out = append(out, v.Title)
		}
		return strings.Join(out, "|")
	}

	before := get(alice)
	if len(before.Days) != 2 || before.Days[0].Starts != 5+7+99 || before.Days[0].WatchTimeMs != 50_000+50_000+9_999_999 || before.Days[1].Starts != 0 {
		t.Fatalf("before the delete: %+v", before.Days) // only alice's videos: the stale row of b1 is out
	}
	if got := titles(before); got != "A deleted|A two|A one" { // 9 999 999 ms first, then the tie: a2 (7 starts) before a1 (5)
		t.Fatalf("top before the delete: %s", got)
	}

	// Delete one of alice's videos through the API: it leaves the channel statistics at once.
	if code, _, body := s.do(alice, "DELETE", "/v1/videos/"+gone.String(), ""); code >= 300 {
		t.Fatalf("delete: %d %s", code, body)
	}
	after := get(alice)
	if after.Days[0].Starts != 12 || after.Days[0].WatchTimeMs != 100_000 || after.Totals.Starts != 12 || after.Totals.WatchTimeMs != 100_100 || after.Totals.Errors != 0 {
		t.Fatalf("after the delete: %+v %+v", after.Days, after.Totals)
	}
	if got := titles(after); got != "A two|A one" {
		t.Fatalf("top after the delete: %s", got)
	}
	if after.TopVideos[0].Starts != 7 || after.TopVideos[0].WatchTimeMs != 50_000 || after.TopVideos[0].VideoID != a2.String() {
		t.Fatalf("%+v", after.TopVideos)
	}
	if after.RefreshedAt == nil || !after.RefreshedAt.Equal(ref) {
		t.Fatalf("%v", after.RefreshedAt)
	}

	// bob sees only his own video, not the 1000 starts a stale row attributes to alice.
	if bobs := get(bob); bobs.Totals.Starts != 50 || titles(bobs) != "B one" {
		t.Fatalf("bob: %+v", bobs)
	}
	if code, _, _ := s.do(nil, "GET", "/v1/studio/stats"+q, ""); code != 401 {
		t.Fatalf("anonymous: %d", code)
	}
}
