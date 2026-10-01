package integration

import (
	"context"
	"io"
	"log/slog"
	"strings"
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
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/store"
	tu "github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Task R2-c (ADR-025) on real PostgreSQL 17 with the real migrations and a real Valkey: GET /v1/videos/{id}/related.
// Every response is validated against video.v1.yaml.

// countingStore counts the queries of the three related sources, to prove a cache hit costs none.
type countingStore struct {
	domain.Store
	related atomic.Int64
}

func (c *countingStore) RelatedSimilar(ctx context.Context, x uuid.UUID, q string, n int) ([]domain.Summary, error) {
	c.related.Add(1)
	return c.Store.RelatedSimilar(ctx, x, q, n)
}
func (c *countingStore) RelatedSameChannel(ctx context.Context, o, x uuid.UUID, n int) ([]domain.Summary, error) {
	c.related.Add(1)
	return c.Store.RelatedSameChannel(ctx, o, x, n)
}
func (c *countingStore) RelatedTrending(ctx context.Context, x uuid.UUID, n int) ([]domain.Summary, error) {
	c.related.Add(1)
	return c.Store.RelatedTrending(ctx, x, n)
}

type relatedStack struct {
	*stack
	counter *countingStore
	srv     *valkeyServer
}

func startRelated(t *testing.T) *relatedStack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	srv := startValkeyServer(t)
	rc, err := cache.NewClient(srv.URL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rc.Close() })
	counter := &countingStore{Store: &store.Postgres{Pool: pg.Pool}}
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	h := &api.Handler{Store: counter, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("integration-cursor-secret"), Log: log, RelatedCache: cache.NewRelated(rc, log)}
	r := httpx.NewRouter("video-related-it", log)
	h.Routes(r)
	return &relatedStack{stack: &stack{t: t, pg: pg, h: r, spec: contract.Load(t)}, counter: counter, srv: srv}
}

type relItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func (s *relatedStack) related(a *actor, id uuid.UUID, q string) (int, string, []relItem) {
	s.t.Helper()
	code, hdr, body := s.do(a, "GET", "/v1/videos/"+id.String()+"/related"+q, "")
	if code != 200 {
		return code, hdr.Get("Cache-Control"), nil
	}
	return code, hdr.Get("Cache-Control"), js[struct {
		Items []relItem `json:"items"`
	}](s.t, body).Items
}

func relTitles(items []relItem) string {
	var t []string
	for _, i := range items {
		t = append(t, i.Title)
	}
	return strings.Join(t, " | ")
}

type relSeed struct {
	source                      uuid.UUID
	alice, bob, carol           tu.User
	private, hidden, processing uuid.UUID
}

// seedRelated: a source video, 3 videos with a similar title, 2 other videos of the source's owner, 5 trending
// rows, and 1 PRIVATE, 1 hidden and 1 PROCESSING video whose title matches the source.
func seedRelated(t *testing.T, s *relatedStack) relSeed {
	t.Helper()
	pool := s.pg.Pool
	r := relSeed{alice: tu.SeedUser(t, pool, "alice", nil, ""), bob: tu.SeedUser(t, pool, "bob", nil, ""), carol: tu.SeedUser(t, pool, "carol", nil, "")}
	base := time.Now().UTC().Add(-48 * time.Hour)
	at := func(minutes int) time.Time { return base.Add(time.Duration(minutes) * time.Minute) }
	seed := func(v tu.Video) uuid.UUID { return tu.SeedVideo(t, pool, v).ID }

	r.source = seed(tu.Video{Owner: r.alice.ID, Title: "Hà Nội mùa thu rực rỡ", Published: at(100)})
	// Similar titles: they share 6, 4 and 2 of the source's words, so ts_rank orders them S1 > S2 > S3.
	seed(tu.Video{Owner: r.bob.ID, Title: "Hà Nội mùa thu rực rỡ lần hai", Published: at(10)})
	seed(tu.Video{Owner: r.bob.ID, Title: "Hà Nội mùa thu", Published: at(20)})
	seed(tu.Video{Owner: r.bob.ID, Title: "Hà Nội cuối tuần", Published: at(30)})
	// Two more videos of the source's owner; unrelated titles. The newer one comes first.
	seed(tu.Video{Owner: r.alice.ID, Title: "Nấu phở bò", Published: at(60)})
	seed(tu.Video{Owner: r.alice.ID, Title: "Học guitar cơ bản", Published: at(70)})
	// Trending: the source, a PRIVATE video and a PROCESSING one are in the ranking too and must be left out.
	t1 := seed(tu.Video{Owner: r.carol.ID, Title: "Trend one", Published: at(1)})
	t2 := seed(tu.Video{Owner: r.carol.ID, Title: "Trend two", Published: at(2)})
	t3 := seed(tu.Video{Owner: r.carol.ID, Title: "Trend three", Published: at(3)})
	t4 := seed(tu.Video{Owner: r.carol.ID, Title: "Trend four", Published: at(4)})
	t5 := seed(tu.Video{Owner: r.carol.ID, Title: "Trend five", Published: at(5)})

	// Videos that match the title but must never be returned.
	r.private = seed(tu.Video{Owner: r.bob.ID, Title: "Hà Nội mùa thu rực rỡ private", Visibility: "PRIVATE", Published: at(40)})
	r.hidden = seed(tu.Video{Owner: r.bob.ID, Title: "Hà Nội mùa thu rực rỡ hidden", Hidden: true, Published: at(41)})
	r.processing = seed(tu.Video{Owner: r.bob.ID, Title: "Hà Nội mùa thu rực rỡ processing", Status: "PROCESSING", Attempts: []float32{5}})

	for rank, id := range []uuid.UUID{r.source, t1, t2, r.private, t3, r.processing, t4, t5, r.hidden} {
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO media.trending (video_id, rank, score, computed_at) VALUES ($1, $2, $3, now())`, id, rank+1, float64(100-rank)); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

func TestRelatedOnPostgresExactOrderAndExclusions(t *testing.T) {
	s := startRelated(t)
	d := seedRelated(t, s)

	// limit 12 (the default): similar, similar, channel, similar, trending, then the sources run dry in the fixed order.
	code, cc, items := s.related(nil, d.source, "")
	want12 := "Hà Nội mùa thu rực rỡ lần hai | Hà Nội mùa thu | Học guitar cơ bản | Hà Nội cuối tuần | Trend one | " +
		"Nấu phở bò | Trend two | Trend three | Trend four | Trend five"
	if code != 200 || cc != "public, max-age=300" || relTitles(items) != want12 {
		t.Fatalf("limit 12: %d %q\n got %s\nwant %s", code, cc, relTitles(items), want12)
	}
	// limit 3.
	_, _, items = s.related(nil, d.source, "?limit=3")
	if want := "Hà Nội mùa thu rực rỡ lần hai | Hà Nội mùa thu | Học guitar cơ bản"; relTitles(items) != want {
		t.Fatalf("limit 3:\n got %s\nwant %s", relTitles(items), want)
	}

	// Never the source, the PRIVATE, hidden or PROCESSING videos, and nothing twice (Trend* rows: the source, the
	// private and the processing ones were in media.trending).
	_, _, all := s.related(nil, d.source, "?limit=24")
	seen := map[string]bool{}
	for _, it := range all {
		if seen[it.ID] {
			t.Fatalf("%s twice", it.Title)
		}
		seen[it.ID] = true
		for _, bad := range []uuid.UUID{d.source, d.private, d.hidden, d.processing} {
			if it.ID == bad.String() {
				t.Fatalf("returned %s (%s)", it.Title, bad)
			}
		}
	}
	if len(all) != 10 {
		t.Fatalf("%d items, want 10 (every candidate exactly once)", len(all))
	}

	// The same for a signed-in caller (the answer is shared).
	if _, cc, items := s.related(&actor{d.bob.ID, "viewer,creator"}, d.source, ""); relTitles(items) != want12 || cc != "public, max-age=300" {
		t.Fatalf("signed in: %s", relTitles(items))
	}

	// A bad limit is 400 and does not reach the database.
	before := s.counter.related.Load()
	for _, q := range []string{"?limit=0", "?limit=25", "?limit=x"} {
		if code, _, _ := s.related(nil, d.source, q); code != 400 {
			t.Fatalf("%s: %d", q, code)
		}
	}
	if s.counter.related.Load() != before {
		t.Fatal("a rejected limit reached the store")
	}
}

func TestRelatedSourceVisibility(t *testing.T) {
	s := startRelated(t)
	d := seedRelated(t, s)
	aliceA, bobA := &actor{d.alice.ID, "viewer,creator"}, &actor{d.bob.ID, "viewer,creator"}
	// A PRIVATE source is 404 for everybody, its owner included (the answer is shared and cached publicly).
	for name, a := range map[string]*actor{"anonymous": nil, "owner": bobA, "another user": aliceA, "admin": {ids.New(), "admin"}} {
		if code, _, _ := s.related(a, d.private, ""); code != 404 {
			t.Errorf("private source for %s: %d", name, code)
		}
	}
	if code, _, _ := s.related(&actor{d.bob.ID, "viewer,creator"}, d.hidden, ""); code != 404 {
		t.Errorf("hidden source for its owner: %d", code)
	}
	if code, _, _ := s.related(bobA, d.processing, ""); code != 404 {
		t.Errorf("processing source for its owner: %d", code)
	}
	if code, _, _ := s.related(nil, ids.New(), ""); code != 404 {
		t.Errorf("unknown id: %d", code)
	}
	if code, _, _ := s.related(aliceA, d.source, ""); code != 200 {
		t.Errorf("a public source: %d", code)
	}
}

func TestRelatedSecondCallIsACacheHitWithZeroQueries(t *testing.T) {
	s := startRelated(t)
	d := seedRelated(t, s)
	hits0 := relatedCounter(t, "hit")
	miss0 := relatedCounter(t, "miss")

	_, _, first := s.related(nil, d.source, "?limit=7")
	if n := s.counter.related.Load(); n != 3 {
		t.Fatalf("a miss runs 3 queries, got %d", n)
	}
	_, _, second := s.related(&actor{d.carol.ID, "viewer"}, d.source, "?limit=7")
	if n := s.counter.related.Load(); n != 3 {
		t.Fatalf("the second call ran %d more queries, want 0", n-3)
	}
	if relTitles(first) != relTitles(second) || len(first) != 7 {
		t.Fatalf("%s vs %s", relTitles(first), relTitles(second))
	}
	if relatedCounter(t, "hit")-hits0 != 1 || relatedCounter(t, "miss")-miss0 != 1 {
		t.Fatal("video_related_cache_total{hit,miss} must each move by one")
	}
	// Another limit is another key; after the TTL-less stop of Valkey the answer is simply recomputed (fail open).
	s.related(nil, d.source, "?limit=8")
	if n := s.counter.related.Load(); n != 6 {
		t.Fatalf("%d queries after a different limit", n)
	}
	s.srv.Stop(t)
	if code, _, items := s.related(nil, d.source, "?limit=7"); code != 200 || len(items) != 7 {
		t.Fatalf("Valkey down: %d %d items", code, len(items))
	}
	if n := s.counter.related.Load(); n != 9 {
		t.Fatalf("with Valkey down the answer is recomputed: %d queries", n)
	}
}

// EXPLAIN: the similar query is a bitmap scan of the partial GIN index videos_search_fts. The table is filled with
// 30 000 public videos with a short description (about 1 in 200 mentions "Hà Nội") and ANALYZEd, so the planner chooses on cost alone: no
// enable_* switch is used.
func TestRelatedSimilarQueryUsesTheSearchIndex(t *testing.T) {
	s := startRelated(t)
	d := seedRelated(t, s)
	ctx := context.Background()
	if _, err := s.pg.Pool.Exec(ctx, `
		INSERT INTO media.videos (id, owner_id, title, description, raw_bucket, raw_key, content_type, size_bytes, status, hls_master_key,
		                          thumbnail_key, duration_ms, published_at)
		SELECT gen_random_uuid(), $1,
		       CASE WHEN i % 200 = 0 THEN 'Hà Nội clip ' || i ELSE 'Clip ' || i || ' video' END,
		       repeat('mô tả video ngắn gọn ', 40),
		       'raw', 'k' || i, 'video/mp4', 1000, 'READY', 'v/' || i || '/master.m3u8', 'v/' || i || '/thumb.jpg', 1000,
		       now() - (i || ' seconds')::interval
		FROM generate_series(1, 30000) AS i`, d.carol.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pg.Pool.Exec(ctx, `ANALYZE media.videos`); err != nil {
		t.Fatal(err)
	}
	q, ok := api.RelatedQuery("Hà Nội mùa thu rực rỡ")
	if !ok {
		t.Fatal("no query")
	}
	rows, err := s.pg.Pool.Query(ctx, `EXPLAIN `+store.RelatedSimilarSQL, d.source, q, 8)
	if err != nil {
		t.Fatal(err)
	}
	var plan []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, line)
	}
	rows.Close()
	text := strings.Join(plan, "\n")
	t.Logf("EXPLAIN of the similar query on %d videos:\n%s", 30000+11, text)
	if !strings.Contains(text, "Bitmap Index Scan on videos_search_fts") {
		t.Fatalf("the plan does not use videos_search_fts:\n%s", text)
	}
	if strings.Contains(text, "Seq Scan on videos") {
		t.Fatalf("sequential scan of media.videos:\n%s", text)
	}
}

// relatedCounter reads video_related_cache_total{result} from the default registry.
func relatedCounter(t *testing.T, result string) float64 {
	t.Helper()
	mfs, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "video_related_cache_total" {
			continue
		}
		for _, m := range mf.GetMetric() {
			for _, l := range m.GetLabel() {
				if l.GetName() == "result" && l.GetValue() == result {
					return m.GetCounter().GetValue()
				}
			}
		}
	}
	return 0
}
