package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/analytics"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/cache"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/store"
	tu "github.com/luantpbk/winkey/services/video/internal/testutil"
)

type recommendationSpy struct {
	domain.RecommendationStore
	computes atomic.Int64
}

type recommendationCacheSpy struct {
	api.RecommendationCache
	reads, writes atomic.Int64
}

func (s *recommendationCacheSpy) GetRecommendation(ctx context.Context, key string) (domain.RecommendationList, bool) {
	s.reads.Add(1)
	return s.RecommendationCache.GetRecommendation(ctx, key)
}

func (s *recommendationCacheSpy) SetRecommendation(ctx context.Context, key string, list domain.RecommendationList, ttl time.Duration) {
	s.writes.Add(1)
	s.RecommendationCache.SetRecommendation(ctx, key, list, ttl)
}

func (s *recommendationSpy) RecommendationCandidates(ctx context.Context, key string, user uuid.UUID, now time.Time, personalize bool) ([]domain.RecommendationCandidate, error) {
	s.computes.Add(1)
	return s.RecommendationStore.RecommendationCandidates(ctx, key, user, now, personalize)
}

type recommendationPage struct {
	Items []struct {
		ID    string `json:"id"`
		Owner struct {
			ID string `json:"id"`
		} `json:"owner"`
	} `json:"items"`
	Next *string `json:"next_cursor"`
}

func (p recommendationPage) ids() []uuid.UUID {
	out := make([]uuid.UUID, len(p.Items))
	for i, it := range p.Items {
		out[i] = uuid.MustParse(it.ID)
	}
	return out
}

func TestRecommendedFeed(t *testing.T) {
	pg := testkit.StartPostgres(t)
	server := startValkeyServer(t)
	rc, err := cache.NewClient(server.URL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rc.Close() })
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	st := &store.Postgres{Pool: pg.Pool}
	spy := &recommendationSpy{RecommendationStore: st}
	cacheSpy := &recommendationCacheSpy{RecommendationCache: cache.NewRecommended(rc, log)}
	pub := &capture{}
	now := time.Now().UTC().Truncate(time.Second)
	h := &api.Handler{Store: st, Recommendations: spy, RecommendationCache: cacheSpy,
		MediaBaseURL: mediaBase, MediaBucket: "winkey-media", CursorSecret: []byte("integration-cursor-secret"),
		AnalyticsSalt: []byte(itSalt), Analytics: pub, Now: func() time.Time { return now }, Log: log}
	r := httpx.NewRouter("video-recommended-it", log)
	h.Routes(r)
	s := &stack{t: t, pg: pg, h: r, spec: contract.Load(t)}
	ctx := context.Background()
	request := func(a *actor, q string) recommendationPage {
		code, hdr, body := s.do(a, "GET", "/v1/feed/recommended"+q, "")
		if code != 200 {
			s.t.Fatalf("recommended status %d: %s", code, body)
		}
		want := "public, max-age=60"
		if a != nil {
			want = "private, no-store"
		}
		if hdr.Get("Cache-Control") != want {
			s.t.Fatal("cache control differs")
		}
		return js[recommendationPage](s.t, body)
	}
	reset := func(t *testing.T) {
		s.t = t
		if _, err := pg.Pool.Exec(ctx, `TRUNCATE media.videos CASCADE; DELETE FROM media.subscriptions; DELETE FROM analytics.video_coview; DELETE FROM analytics.viewer_history`); err != nil {
			t.Fatal(err)
		}
		if err := rc.FlushDB(ctx).Err(); err != nil {
			t.Fatal(err)
		}
		spy.computes.Store(0)
		cacheSpy.reads.Store(0)
		cacheSpy.writes.Store(0)
	}
	watch := func(t *testing.T, key string, id uuid.UUID, at time.Time) {
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO analytics.viewer_history (viewer_key,video_id,last_watched_at,watched_ms,refreshed_at) VALUES ($1,$2,$3,20000,$3)`, key, id, at); err != nil {
			t.Fatal(err)
		}
	}
	pair := func(t *testing.T, source, target uuid.UUID, score float64) {
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO analytics.video_coview (video_id,neighbor_id,co_viewers,score,refreshed_at) VALUES ($1,$2,3,$3,$4)`, source, target, score, now); err != nil {
			t.Fatal(err)
		}
	}
	trend := func(t *testing.T, id uuid.UUID, rank int) {
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO media.trending (video_id,rank,score,computed_at) VALUES ($1,$2,1,$3)`, id, rank, now); err != nil {
			t.Fatal(err)
		}
	}
	check := func(t *testing.T, got recommendationPage, want []uuid.UUID) {
		t.Helper()
		if !reflect.DeepEqual(got.ids(), want) {
			t.Fatalf("ordered IDs got %v want %v", got.ids(), want)
		}
	}

	t.Run("hand-computed ranking and heartbeat viewer key", func(t *testing.T) {
		reset(t)
		user := tu.SeedUser(t, pg.Pool, "reco_viewer", nil, "")
		a := &actor{id: user.ID, roles: "viewer"}
		owners := make([]tu.User, 7)
		for i := range owners {
			owners[i] = tu.SeedUser(t, pg.Pool, fmt.Sprintf("reco_rank_%d", i), nil, "")
		}
		seed := func(i int, title string, age time.Duration) uuid.UUID {
			return tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owners[i].ID, Title: title, Published: now.Add(-age)}).ID
		}
		h1, h2 := seed(0, "history one", 7*24*time.Hour), seed(1, "history two", time.Hour)
		vA, vB, vC := seed(2, "A coview and trending", 2*time.Hour), seed(3, "B strongest coview", time.Hour), seed(4, "C fresh subscription", 0)
		vD, vE := seed(5, "D trending", 5*time.Hour), seed(6, "E newest fill", -time.Minute)
		// Obtain the key from an actual R1 heartbeat response/event, not a duplicated implementation.
		body, _ := json.Marshal(map[string]any{"samples": []any{hbSample(uuid.New(), h1, "heartbeat", 1)}})
		code, _, _ := s.do(a, "POST", "/v1/playback/heartbeats", string(body))
		if code != 202 || len(pub.sent()) != 1 {
			t.Fatal("heartbeat did not publish")
		}
		var envelope struct {
			Data struct {
				Key string `json:"viewer_key"`
			} `json:"data"`
		}
		if err := json.Unmarshal(pub.sent()[0].Payload, &envelope); err != nil {
			t.Fatal(err)
		}
		key := envelope.Data.Key
		if key != analytics.ViewerKey([]byte(itSalt), "u:"+user.ID.String()) {
			t.Fatal("heartbeat key mismatch")
		}
		watch(t, key, h1, now.Add(-7*24*time.Hour))
		watch(t, key, h2, now)
		pair(t, h1, vA, 1)
		pair(t, h2, vB, .6)
		pair(t, h1, vC, .6)
		trend(t, vA, 1)
		trend(t, vD, 101)
		if err := st.Subscribe(ctx, user.ID, owners[4].ID, now); err != nil {
			t.Fatal(err)
		}
		// raw co-view A=.5 B=.6 C=.3 -> normalized 5/6,1,.5.
		// final C=1.2 A=1.133333 B=1 D=.15 E=0.
		check(t, request(a, "?limit=50"), []uuid.UUID{vC, vA, vB, vD, vE})
		if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET published_at=$2 WHERE id=$1`, vC, now.Add(-72*time.Hour)); err != nil {
			t.Fatal(err)
		}
		// C's subscription component halves: final .85, below A and B.
		check(t, request(a, "?limit=50"), []uuid.UUID{vA, vB, vC, vD, vE})
		if _, err := pg.Pool.Exec(ctx, `DELETE FROM media.trending WHERE video_id=$1`, vA); err != nil {
			t.Fatal(err)
		}
		check(t, request(a, "?limit=50"), []uuid.UUID{vB, vC, vA, vD, vE})
	})

	t.Run("exclusions and cached-page visibility", func(t *testing.T) {
		reset(t)
		user := tu.SeedUser(t, pg.Pool, "reco_ex_viewer", nil, "")
		a := &actor{id: user.ID}
		owner := tu.SeedUser(t, pg.Pool, "reco_ex_owner", nil, "")
		suspended := tu.SeedUser(t, pg.Pool, "reco_ex_suspended", nil, "SUSPENDED")
		key := analytics.ViewerKey([]byte(itSalt), "u:"+user.ID.String())
		for _, v := range []tu.Video{{Owner: user.ID}, {Owner: owner.ID, Visibility: "PRIVATE"}, {Owner: owner.ID, Visibility: "UNLISTED"}, {Owner: owner.ID, Hidden: true}, {Owner: owner.ID, Status: "PROCESSING"}, {Owner: suspended.ID}} {
			tu.SeedVideo(t, pg.Pool, v)
		}
		watched := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owner.ID}).ID
		watch(t, key, watched, now)
		// Exclude history beyond the 50 rows used for scoring, too.
		for i := 0; i < 51; i++ {
			watch(t, key, uuid.New(), now.Add(time.Duration(i+1)*time.Second))
		}
		v1 := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owner.ID, Published: now}).ID
		v2 := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owner.ID, Published: now.Add(-time.Hour)}).ID
		// This watched source is older than the top 50: it must neither appear nor boost v2.
		pair(t, watched, v2, 1)
		first := request(a, "?limit=1")
		check(t, first, []uuid.UUID{v1})
		if first.Next == nil {
			t.Fatal("missing cursor")
		}
		if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET visibility='PRIVATE' WHERE id=$1`, v2); err != nil {
			t.Fatal(err)
		}
		last := request(a, "?limit=1&cursor="+url.QueryEscape(*first.Next))
		if len(last.Items) != 0 || last.Next != nil || spy.computes.Load() != 1 {
			t.Fatal("cached page exposed stale video or recomputed")
		}
	})

	t.Run("diversity across pages and cache expiry", func(t *testing.T) {
		reset(t)
		user := tu.SeedUser(t, pg.Pool, "reco_div_viewer", nil, "")
		a := &actor{id: user.ID}
		main := tu.SeedUser(t, pg.Pool, "reco_div_main", nil, "")
		var expected []uuid.UUID
		for i := 0; i < 5; i++ {
			id := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: main.ID, Published: now.Add(-time.Duration(i) * time.Minute)}).ID
			trend(t, id, i+1)
		}
		for i := 0; i < 24; i++ {
			owner := tu.SeedUser(t, pg.Pool, fmt.Sprintf("reco_div_%d", i), nil, "")
			tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owner.ID, Published: now.Add(-time.Duration(i+5) * time.Minute)})
		}
		whole := request(a, "?limit=50")
		expected = whole.ids()
		if len(expected) != 29 {
			t.Fatal("diversity lost candidates")
		}
		for end := 10; end <= len(whole.Items); end++ {
			counts := map[string]int{}
			for _, it := range whole.Items[end-10 : end] {
				counts[it.Owner.ID]++
				if counts[it.Owner.ID] > 2 {
					t.Fatal("diversity window exceeded despite alternatives")
				}
			}
		}
		first := request(a, "?limit=7")
		all := first.ids()
		next := first.Next
		before := spy.computes.Load()
		for next != nil {
			p := request(a, "?limit=7&cursor="+url.QueryEscape(*next))
			all = append(all, p.ids()...)
			next = p.Next
		}
		if !reflect.DeepEqual(all, expected) || spy.computes.Load() != before {
			t.Fatal("cached pages changed order or recomputed")
		}
		keys, err := rc.Keys(ctx, "reco:"+user.ID.String()+":*").Result()
		if err != nil || len(keys) != 2 {
			t.Fatal("cache keys differ")
		}
		for _, k := range keys {
			ttl, err := rc.TTL(ctx, k).Result()
			if err != nil || ttl <= 9*time.Minute || ttl > 10*time.Minute {
				t.Fatal("cache TTL differs")
			}
		}
		if err := rc.Del(ctx, keys...).Err(); err != nil {
			t.Fatal(err)
		}
		expired := request(a, "?limit=7&cursor="+url.QueryEscape(*first.Next))
		check(t, expired, expected[7:14])
		if spy.computes.Load() != before+1 {
			t.Fatal("expired list was not recomputed")
		}
		other := tu.SeedUser(t, pg.Pool, "reco_div_other", nil, "")
		code, _, _ := s.do(&actor{id: other.ID}, "GET", "/v1/feed/recommended?cursor="+url.QueryEscape(*first.Next), "")
		if code != 400 {
			t.Fatal("cursor replay across users accepted")
		}
	})

	t.Run("cold start anonymous single channel and cap", func(t *testing.T) {
		reset(t)
		user := tu.SeedUser(t, pg.Pool, "reco_cold_viewer", nil, "")
		a := &actor{id: user.ID}
		if p := request(nil, ""); len(p.Items) != 0 || p.Next != nil {
			t.Fatal("empty catalog response differs")
		}
		owner := tu.SeedUser(t, pg.Pool, "reco_cold_owner", nil, "")
		var vids []uuid.UUID
		for i := 0; i < 205; i++ {
			vids = append(vids, tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owner.ID, Published: now.Add(-time.Duration(i) * time.Minute)}).ID)
		}
		trend(t, vids[100], 1)
		trend(t, vids[150], 2)
		want := []uuid.UUID{vids[100], vids[150]}
		for _, id := range vids {
			if id != vids[100] && id != vids[150] {
				want = append(want, id)
			}
		}
		var all []uuid.UUID
		p := request(a, "?limit=50")
		for {
			all = append(all, p.ids()...)
			if p.Next == nil {
				break
			}
			p = request(a, "?limit=50&cursor="+url.QueryEscape(*p.Next))
		}
		if !reflect.DeepEqual(all, want[:200]) {
			t.Fatal("single-channel fallback order or cap differs")
		}
		code, _, _ := s.do(a, "GET", "/v1/feed/recommended?limit=51", "")
		if code != 400 {
			t.Fatal("limit 51 accepted")
		}
		if err := rc.FlushDB(ctx).Err(); err != nil {
			t.Fatal(err)
		}
		reads, writes := cacheSpy.reads.Load(), cacheSpy.writes.Load()
		check(t, request(nil, "?limit=50"), want[:50])
		if cacheSpy.reads.Load() != reads || cacheSpy.writes.Load() != writes {
			t.Fatal("anonymous request accessed recommendation cache")
		}
		if keys, err := rc.Keys(ctx, "reco:*").Result(); err != nil || len(keys) != 0 {
			t.Fatal("anonymous request used Valkey")
		}
		// With a small one-channel pool, every video is returned, even though the soft bound cannot hold.
		if _, err := pg.Pool.Exec(ctx, `DELETE FROM media.videos WHERE id <> ALL($1::uuid[])`, vids[:12]); err != nil {
			t.Fatal(err)
		}
		check(t, request(a, "?limit=50"), vids[:12])
	})

	t.Run("score ties and subscription cutoff", func(t *testing.T) {
		reset(t)
		user := tu.SeedUser(t, pg.Pool, "reco_tie_viewer", nil, "")
		owner := tu.SeedUser(t, pg.Pool, "reco_tie_owner", nil, "")
		other := tu.SeedUser(t, pg.Pool, "reco_tie_other", nil, "")
		older := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owner.ID, Published: now.Add(-15 * 24 * time.Hour)}).ID
		x := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: other.ID, Published: now}).ID
		y := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: other.ID, Published: now}).ID
		if x.String() < y.String() {
			x, y = y, x
		}
		if err := st.Subscribe(ctx, user.ID, owner.ID, now); err != nil {
			t.Fatal(err)
		}
		check(t, request(&actor{id: user.ID}, "?limit=50"), []uuid.UUID{x, y, older})
	})
}
