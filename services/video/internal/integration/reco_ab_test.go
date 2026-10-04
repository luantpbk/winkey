package integration

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/analytics"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/cache"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/recoab"
	"github.com/luantpbk/winkey/services/video/internal/store"
	tu "github.com/luantpbk/winkey/services/video/internal/testutil"
	"github.com/prometheus/client_golang/prometheus"
)

func TestRecoABFeedAndHeartbeat(t *testing.T) {
	pg := testkit.StartPostgres(t)
	server := startValkeyServer(t)
	rc, err := cache.NewClient(server.URL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rc.Close() })
	ctx := context.Background()
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	st := &store.Postgres{Pool: pg.Pool}
	spy := &recommendationSpy{RecommendationStore: st}
	cacheSpy := &recommendationCacheSpy{RecommendationCache: cache.NewRecommended(rc, log)}
	pub := &capture{}
	now := time.Now().UTC().Truncate(time.Second)
	h := &api.Handler{Store: st, Recommendations: spy, RecommendationCache: cacheSpy,
		MediaBaseURL: mediaBase, MediaBucket: "winkey-media", CursorSecret: []byte("integration-cursor-secret"),
		AnalyticsSalt: []byte(itSalt), Analytics: pub, Now: func() time.Time { return now }, Log: log,
		RecoABEnabled: true, RecoABSeed: "r2ab-1", RecoABTreatmentPercent: 50}
	r := httpx.NewRouter("video-reco-ab-it", log)
	h.Routes(r)
	s := &stack{t: t, pg: pg, h: r, spec: contract.Load(t)}
	user := tu.SeedUser(t, pg.Pool, "ab_viewer", nil, "")
	a := &actor{id: user.ID}
	owners := make([]tu.User, 5)
	for i := range owners {
		owners[i] = tu.SeedUser(t, pg.Pool, fmt.Sprintf("ab_owner_%d", i), nil, "")
	}
	seed := func(owner uuid.UUID, title string, age time.Duration) uuid.UUID {
		return tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owner, Title: title, Published: now.Add(-age)}).ID
	}
	history := seed(owners[0].ID, "watched", 24*time.Hour)
	own := seed(user.ID, "own", 0)
	coview := seed(owners[1].ID, "coview", 5*time.Hour)
	sub := seed(owners[2].ID, "subscription", time.Hour)
	trending := seed(owners[3].ID, "trending", 6*time.Hour)
	fill := seed(owners[4].ID, "newest fill", 0)
	key := analytics.ViewerKey([]byte(itSalt), "u:"+user.ID.String())
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO analytics.viewer_history(viewer_key,video_id,last_watched_at,watched_ms,refreshed_at) VALUES($1,$2,$3,20000,$3)`, []any{key, history, now}},
		{`INSERT INTO analytics.video_coview(video_id,neighbor_id,co_viewers,score,refreshed_at) VALUES($1,$2,3,1,$3)`, []any{history, coview, now}},
		{`INSERT INTO media.trending(video_id,rank,score,computed_at) VALUES($1,1,1,$2),($3,2,1,$2),($4,3,1,$2)`, []any{trending, now, history, own}},
	} {
		if _, err := pg.Pool.Exec(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Subscribe(ctx, user.ID, owners[2].ID, now); err != nil {
		t.Fatal(err)
	}
	request := func(a *actor, q string) recommendationPage {
		code, _, body := s.do(a, "GET", "/v1/feed/recommended"+q, "")
		if code != 200 {
			t.Fatalf("feed status %d", code)
		}
		return js[recommendationPage](t, body)
	}
	check := func(got recommendationPage, want []uuid.UUID) {
		t.Helper()
		if !reflect.DeepEqual(got.ids(), want) {
			t.Fatalf("feed order got %v want %v", got.ids(), want)
		}
	}
	controlOrder := []uuid.UUID{trending, fill, sub, coview}
	recoOrder := []uuid.UUID{coview, sub, trending, fill}
	// Each arm has exactly the same eligible set, excluding the viewer's own and persisted watched videos.
	for _, arm := range []string{"control", "reco"} {
		t.Run(arm+" ranking and event assignment", func(t *testing.T) {
			s.t = t
			// Find seeds that exercise the genuine 50% assignment for this randomly generated viewer.
			for i := 0; ; i++ {
				h.RecoABSeed = fmt.Sprintf("ab-seed-%d", i)
				if recoab.Variant(h.RecoABSeed, 50, user.ID) == arm {
					break
				}
			}
			want := controlOrder
			if arm == "reco" {
				want = recoOrder
			}
			check(request(a, "?limit=50"), want)
			before := len(pub.sent())
			for _, surface := range []string{"for_you", "trending", "subscriptions", "search", "channel", "latest", "up_next", "playlist", "other"} {
				sample := hbSample(uuid.New(), trending, "heartbeat", 1)
				sample["surface"] = surface
				code, _, _ := s.do(a, "POST", "/v1/playback/heartbeats", hbBatch(sample))
				if code != 202 || len(pub.sent()) != before+1 {
					t.Fatal("heartbeat not published")
				}
				d := checkAnalyticsEvent(t, pub.sent()[before].Payload)
				if d["surface"] != surface || d["reco_variant"] != arm || d["authenticated"] != true || d["viewer_key"] != key {
					t.Fatal("heartbeat differs from feed arm, surface or viewer")
				}
				before++
			}
		})
	}
	t.Run("cache isolates percent and seed reassignment", func(t *testing.T) {
		s.t = t
		h.RecoABTreatmentPercent = 100
		first := request(a, "?limit=1")
		check(first, recoOrder[:1])
		if first.Next == nil {
			t.Fatal("missing cursor")
		}
		q := "?limit=1&cursor=" + url.QueryEscape(*first.Next)
		before := spy.computes.Load()
		check(request(a, q), recoOrder[1:2])
		if spy.computes.Load() != before {
			t.Fatal("same-arm cache missed")
		}
		h.RecoABTreatmentPercent = 0
		check(request(a, q), controlOrder[1:2])
		if spy.computes.Load() != before+1 {
			t.Fatal("percent reassignment reused the other arm's list")
		}
		// Now flip through the seed at the normal 50%, using the same signed cursor.
		h.RecoABTreatmentPercent = 50
		for i := 0; ; i++ {
			h.RecoABSeed = fmt.Sprintf("flip-%d", i)
			if recoab.Variant(h.RecoABSeed, 50, user.ID) == "reco" {
				break
			}
		}
		check(request(a, q), recoOrder[1:2])
		if spy.computes.Load() != before+1 {
			t.Fatal("seed reassignment did not find its own arm's cache")
		}
		keys, err := rc.Keys(ctx, "reco:"+user.ID.String()+":*").Result()
		if err != nil {
			t.Fatal(err)
		}
		if len(keys) != 4 { // two whole-list requests above, plus this cursor in each arm
			t.Fatalf("expected four arm-scoped keys, got %d", len(keys))
		}
	})
	t.Run("disabled and anonymous events are unassigned", func(t *testing.T) {
		s.t = t
		h.RecoABEnabled = false
		check(request(a, "?limit=50"), recoOrder)
		for _, caller := range []*actor{a, nil} {
			before := len(pub.sent())
			code, _, _ := s.do(caller, "POST", "/v1/playback/heartbeats", hbBatch(hbSample(uuid.New(), trending, "start", 0)))
			if code != 202 || len(pub.sent()) != before+1 {
				t.Fatal("unassigned heartbeat not published")
			}
			d := checkAnalyticsEvent(t, pub.sent()[before].Payload)
			if d["reco_variant"] != nil || d["surface"] != nil {
				t.Fatal("disabled or anonymous event was assigned")
			}
		}
		h.RecoABEnabled = true
		reads, writes := cacheSpy.reads.Load(), cacheSpy.writes.Load()
		request(nil, "?limit=50")
		if cacheSpy.reads.Load() != reads || cacheSpy.writes.Load() != writes {
			t.Fatal("anonymous feed accessed cache")
		}
		before := len(pub.sent())
		sample := hbSample(uuid.New(), trending, "start", 0)
		sample["surface"] = "search"
		code, _, _ := s.do(nil, "POST", "/v1/playback/heartbeats", hbBatch(sample))
		if code != 202 || len(pub.sent()) != before+1 {
			t.Fatal("anonymous heartbeat not published")
		}
		d := checkAnalyticsEvent(t, pub.sent()[before].Payload)
		if d["reco_variant"] != nil || d["surface"] != "search" {
			t.Fatal("anonymous surface or assignment differs")
		}
	})
	t.Run("invalid surface and client arm rejected", func(t *testing.T) {
		s.t = t
		before := len(pub.sent())
		for _, invalid := range []any{"home", "", "FOR_YOU", nil, 1, true, []any{}, map[string]any{}} {
			sample := hbSample(uuid.New(), trending, "heartbeat", 1)
			sample["surface"] = invalid
			code, _, _ := s.do(a, "POST", "/v1/playback/heartbeats", hbBatch(sample))
			if code != 400 {
				t.Fatalf("invalid surface accepted with status %d", code)
			}
		}
		sample := hbSample(uuid.New(), trending, "heartbeat", 1)
		sample["reco_variant"] = "reco"
		code, _, _ := s.do(a, "POST", "/v1/playback/heartbeats", hbBatch(sample))
		if code != 400 || len(pub.sent()) != before {
			t.Fatal("client chose its arm or invalid surface published")
		}
	})
	// Both labels remain bounded, including disabled/anonymous requests.
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, f := range families {
		if f.GetName() != "video_reco_requests_total" {
			continue
		}
		for _, m := range f.Metric {
			for _, label := range m.Label {
				if label.GetName() == "variant" {
					seen[label.GetValue()] = true
				}
			}
		}
	}
	if len(seen) != 3 || !seen["reco"] || !seen["control"] || !seen["none"] {
		t.Fatal("recommendation metric variant labels differ")
	}
}
