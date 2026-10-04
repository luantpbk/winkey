package integration

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
	"github.com/luantpbk/winkey/services/video/internal/trending"
)

// Task R2-a (ADR-020) on real PostgreSQL 17: the hourly view buckets written with the flush, the trending
// recompute, and GET /v1/videos?sort=trending. Every HTTP response is validated against video.v1.yaml.

type trendStack struct {
	t    *testing.T
	pg   *testkit.Postgres
	st   *store.Postgres
	h    http.Handler
	spec *contract.Spec
	log  *slog.Logger
}

func startTrending(t *testing.T) *trendStack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	st := &store.Postgres{Pool: pg.Pool}
	h := &api.Handler{Store: st, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("integration-cursor-secret"), Log: log}
	r := httpx.NewRouter("video-trending-it", log)
	h.Routes(r)
	return &trendStack{t: t, pg: pg, st: st, h: r, spec: contract.Load(t), log: log}
}

func (s *trendStack) job() *trending.Job { return &trending.Job{Pool: s.pg.Pool, Log: s.log} }

// bucket puts `views` in the bucket that started `hoursAgo` whole hours before the current hour.
func (s *trendStack) bucket(video uuid.UUID, hoursAgo int, views int64) {
	s.t.Helper()
	if _, err := s.pg.Pool.Exec(context.Background(), `
		INSERT INTO media.video_views_hourly (video_id, hour, views)
		VALUES ($1, date_trunc('hour', now()) - make_interval(hours => $2), $3)
		ON CONFLICT (video_id, hour) DO UPDATE SET views = media.video_views_hourly.views + EXCLUDED.views`, video, hoursAgo, views); err != nil {
		s.t.Fatal(err)
	}
}

func (s *trendStack) recompute() trending.Result {
	s.t.Helper()
	res, err := s.job().RunOnce(context.Background())
	if err != nil {
		s.t.Fatal(err)
	}
	return res
}

type ranked struct {
	Video uuid.UUID
	Rank  int
	Score float64
}

func (s *trendStack) ranking() []ranked {
	s.t.Helper()
	rows, err := s.pg.Pool.Query(context.Background(), `SELECT video_id, rank, score FROM media.trending ORDER BY rank`)
	if err != nil {
		s.t.Fatal(err)
	}
	defer rows.Close()
	var out []ranked
	for rows.Next() {
		var r ranked
		if err := rows.Scan(&r.Video, &r.Rank, &r.Score); err != nil {
			s.t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func (s *trendStack) get(path string) (int, http.Header, []byte) {
	s.t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	p, _, _ := strings.Cut(path, "?")
	s.spec.Check(s.t, "GET", p, w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w.Code, w.Header(), w.Body.Bytes()
}

func ids2(items []ranked) []uuid.UUID {
	var out []uuid.UUID
	for _, r := range items {
		out = append(out, r.Video)
	}
	return out
}

// ---- AddViews: the flush writes the hourly bucket in the same transaction --------------------------------

func TestAddViewsWritesTheHourlyBucketInTheSameTransaction(t *testing.T) {
	s := startTrending(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	a := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID, ViewCount: 5}).ID
	b := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	gone := uuid.New() // a video that does not exist (deleted meanwhile)

	// A batch with a deleted video: it does not fail the batch, and gets no bucket.
	matched, err := s.st.AddViews(ctx, []uuid.UUID{a, b, gone}, []int64{3, 4, 9})
	if err != nil || matched != 2 {
		t.Fatalf("matched %d, err %v", matched, err)
	}
	if _, err := s.st.AddViews(ctx, []uuid.UUID{a}, []int64{2}); err != nil { // same hour: the bucket accumulates
		t.Fatal(err)
	}
	get := func(id uuid.UUID) (views int64, buckets int, hour time.Time, want time.Time, viewCount int64) {
		if err := s.pg.Pool.QueryRow(ctx, `
			SELECT coalesce(sum(h.views), 0), count(h.*), coalesce(min(h.hour), 'epoch'),
			       date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', coalesce((SELECT view_count FROM media.videos WHERE id = $1), 0)
			FROM media.video_views_hourly h WHERE h.video_id = $1`, id).Scan(&views, &buckets, &hour, &want, &viewCount); err != nil {
			t.Fatal(err)
		}
		return
	}
	if v, n, hour, want, vc := get(a); v != 5 || n != 1 || !hour.Equal(want) || vc != 10 { // 5 + 3 + 2
		t.Fatalf("a: bucket views=%d buckets=%d hour=%v want %v view_count=%d", v, n, hour, want, vc)
	}
	if v, n, _, _, vc := get(b); v != 4 || n != 1 || vc != 4 {
		t.Fatalf("b: %d %d %d", v, n, vc)
	}
	if v, n, _, _, _ := get(gone); v != 0 || n != 0 {
		t.Fatalf("the deleted video got a bucket: %d %d", v, n)
	}
	// The bucket hour is a whole UTC hour.
	var offMinute int
	_ = s.pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.video_views_hourly WHERE hour <> date_trunc('hour', hour)`).Scan(&offMinute)
	if offMinute != 0 {
		t.Fatal("bucket not on the hour")
	}

	// A failing bucket write leaves NEITHER: view_count stays as it was.
	for _, q := range []string{
		`CREATE FUNCTION media.refuse_bucket() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'buckets refused'; END $$`,
		`CREATE TRIGGER refuse_bucket BEFORE INSERT OR UPDATE ON media.video_views_hourly FOR EACH ROW EXECUTE FUNCTION media.refuse_bucket()`,
	} {
		if _, err := s.pg.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.st.AddViews(ctx, []uuid.UUID{a, b}, []int64{100, 100}); err == nil {
		t.Fatal("a failing bucket write must fail the batch")
	}
	if v, _, _, _, vc := get(a); v != 5 || vc != 10 {
		t.Fatalf("a changed although the transaction failed: bucket %d view_count %d", v, vc)
	}
	if _, _, _, _, vc := get(b); vc != 4 {
		t.Fatalf("b view_count %d", vc)
	}
	if _, err := s.pg.Pool.Exec(ctx, `DROP TRIGGER refuse_bucket ON media.video_views_hourly`); err != nil {
		t.Fatal(err)
	}
	if m, err := s.st.AddViews(ctx, []uuid.UUID{a, b}, []int64{100, 100}); err != nil || m != 2 { // the retry applies it once
		t.Fatalf("retry: %d %v", m, err)
	}
	if v, _, _, _, vc := get(a); v != 105 || vc != 110 {
		t.Fatalf("a after the retry: %d %d", v, vc)
	}
	// Non-positive counts write nothing.
	if m, err := s.st.AddViews(ctx, []uuid.UUID{a}, []int64{0}); err != nil || m != 0 {
		t.Fatalf("zero count: %d %v", m, err)
	}
}

// A video deleted WHILE a batch is applied: the delete and the flush never break each other.
func TestDeleteRacingWithAFlushNeverFailsTheBatch(t *testing.T) {
	s := startTrending(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	vids := testutil.SeedManyReady(t, s.pg.Pool, owner.ID, 60)
	counts := make([]int64, len(vids))
	for i := range counts {
		counts[i] = 1
	}
	var wg sync.WaitGroup
	wg.Add(2)
	var flushErr error
	go func() {
		defer wg.Done()
		for i := 0; i < 20; i++ {
			if _, err := s.st.AddViews(ctx, vids, counts); err != nil {
				flushErr = err
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for _, id := range vids {
			if _, err := s.pg.Pool.Exec(ctx, `DELETE FROM media.videos WHERE id = $1`, id); err != nil {
				t.Errorf("delete: %v", err)
				return
			}
		}
	}()
	wg.Wait()
	if flushErr != nil {
		t.Fatalf("a flush failed while videos were deleted: %v", flushErr)
	}
	var n int
	_ = s.pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.video_views_hourly`).Scan(&n)
	if n != 0 { // every video is gone, so every bucket went with it (ON DELETE CASCADE)
		t.Fatalf("%d buckets of deleted videos", n)
	}
}

// ---- the ranking -------------------------------------------------------------------------------------------

func TestRankingFollowsTheFormula(t *testing.T) {
	s := startTrending(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	vid := func(title string) uuid.UUID {
		return testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID, Title: title}).ID
	}
	oldMany, freshFew := vid("old but many"), vid("fresh but fewer")
	mid, weak, tooOld, edge := vid("mid"), vid("weak"), vid("outside the window"), vid("inside the window")
	s.bucket(oldMany, 71, 1000)  // 1000 * 0.5^(71/24) ~ 129 (a little less: the bucket is older than 71 h)
	s.bucket(freshFew, 0, 200)   // ~ 195..200
	s.bucket(mid, 24, 380)       // ~ 190 (half of it: 24 hours old)
	s.bucket(mid, 30, 10)        // ~ 4 more: a second bucket adds up
	s.bucket(weak, 30, 1)        // 0.42: below the threshold, dropped
	s.bucket(tooOld, 73, 100000) // outside the 72 h window: does not count at all
	s.bucket(edge, 72, 100000)   // starts 72 h before the current hour: older than now() - 72 h, so also outside

	res := s.recompute()
	got := s.ranking()
	if !res.Ran || res.Size != len(got) {
		t.Fatalf("%+v", res)
	}
	order := ids2(got)
	inRanking := map[uuid.UUID]bool{}
	for _, id := range order {
		inRanking[id] = true
	}
	if inRanking[weak] || inRanking[tooOld] {
		t.Fatalf("weak=%v tooOld=%v must not be ranked", inRanking[weak], inRanking[tooOld])
	}
	if inRanking[edge] {
		t.Fatal("a bucket that started 72 h before the current hour is outside the window")
	}
	if len(order) != 3 || order[0] != freshFew || order[1] != mid || order[2] != oldMany {
		t.Fatalf("order %v, want fresh, mid, old (many old views rank below fewer fresh ones)", order)
	}
	for i, r := range got {
		if r.Rank != i+1 || r.Score < 1 {
			t.Fatalf("row %d: %+v", i, r)
		}
	}

	// The score is the formula: compare with trending.Score on the bucket ages the database saw.
	ctx := context.Background()
	rows, err := s.pg.Pool.Query(ctx, `
		SELECT h.video_id, h.views, extract(epoch FROM (now() - h.hour))
		FROM media.video_views_hourly h WHERE h.hour >= now() - interval '72 hours'`)
	if err != nil {
		t.Fatal(err)
	}
	want := map[uuid.UUID]float64{}
	for rows.Next() {
		var id uuid.UUID
		var views int64
		var ageSec float64
		if err := rows.Scan(&id, &views, &ageSec); err != nil {
			t.Fatal(err)
		}
		want[id] += trending.Score(views, time.Duration(ageSec*float64(time.Second)))
	}
	rows.Close()
	for _, r := range got {
		// The two clocks differ by the milliseconds between the recompute and this query.
		if math.Abs(r.Score-want[r.Video]) > 0.01*want[r.Video] {
			t.Errorf("%s: SQL score %v, Go score %v", r.Video, r.Score, want[r.Video])
		}
	}
	// A view of the current hour is worth about 1 (0.5^(age/24 h) with age below 1 h), one of 24 hours ago about 0.5.
	fresh, day := got[0].Score, got[1].Score
	if fresh < 190 || fresh > 200 || day < 185 || day > 195 {
		t.Fatalf("scores %v %v", fresh, day)
	}
}

func TestRankingKeepsTheTopTwoHundredWithStableTies(t *testing.T) {
	s := startTrending(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	vids := testutil.SeedManyReady(t, s.pg.Pool, owner.ID, 230)
	for i, id := range vids {
		switch {
		case i < 200:
			s.bucket(id, 2, 50) // 200 videos with EXACTLY the same score: only the id can order them
		case i < 220:
			s.bucket(id, 2, 5000) // 20 much better ones
		default:
			s.bucket(id, 2, 2) // 10 weaker ones that do not fit
		}
	}
	s.recompute()
	got := s.ranking()
	if len(got) != 200 {
		t.Fatalf("%d rows, want 200", len(got))
	}
	seen := map[int]bool{}
	for i, r := range got {
		if r.Rank != i+1 || seen[r.Rank] {
			t.Fatalf("ranks are not 1..200: %+v", r)
		}
		seen[r.Rank] = true
	}
	// The 20 best come first, then ties by id DESC; the weakest ten are out.
	top := map[uuid.UUID]bool{}
	for _, id := range vids[200:220] {
		top[id] = true
	}
	for i := 0; i < 20; i++ {
		if !top[got[i].Video] {
			t.Fatalf("rank %d is not one of the 20 best", i+1)
		}
	}
	for i := 1; i < 20; i++ { // equal scores among the best too: id DESC
		if got[i-1].Video.String() < got[i].Video.String() {
			t.Fatalf("tie at rank %d/%d is not ordered by id DESC", i, i+1)
		}
	}
	tied := got[20:]
	if !sort.SliceIsSorted(tied, func(i, j int) bool { return tied[i].Video.String() > tied[j].Video.String() }) {
		t.Fatal("the tied videos are not ordered by id DESC")
	}
	weak := map[uuid.UUID]bool{}
	for _, id := range vids[220:] {
		weak[id] = true
	}
	for _, r := range got {
		if weak[r.Video] {
			t.Fatal("a weaker video is in the top 200")
		}
	}
	// Recomputing gives the same ranking (stable), with a fresh computed_at.
	first := ids2(got)
	s.recompute()
	again := ids2(s.ranking())
	for i := range first {
		if first[i] != again[i] {
			t.Fatalf("the ranking changed at %d without new views", i)
		}
	}
}

func TestEmptyRankingWhenNothingQualifies(t *testing.T) {
	s := startTrending(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	s.bucket(v, 1, 500)
	if res := s.recompute(); res.Size != 1 {
		t.Fatalf("%+v", res)
	}
	// The views age out (the bucket is deleted): the next run publishes an EMPTY ranking, not the old one.
	if _, err := s.pg.Pool.Exec(context.Background(), `DELETE FROM media.video_views_hourly`); err != nil {
		t.Fatal(err)
	}
	if res := s.recompute(); !res.Ran || res.Size != 0 || len(s.ranking()) != 0 {
		t.Fatalf("%+v %v", res, s.ranking())
	}
	code, hdr, body := s.get("/v1/videos?sort=trending")
	if code != 200 || strings.TrimSpace(string(body)) != `{"items":[],"next_cursor":null}` || hdr.Get("Cache-Control") != "public, max-age=60" {
		t.Fatalf("%d %v %s", code, hdr, body)
	}
}

// ---- exclusion: at compute time and at read time -----------------------------------------------------------

func TestExcludedVideosAreNotRankedNorServed(t *testing.T) {
	s := startTrending(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	suspended := testutil.SeedUser(t, s.pg.Pool, "ghost", nil, "SUSPENDED")
	deleted := testutil.SeedUser(t, s.pg.Pool, "gone", nil, "DELETED")

	mk := func(v testutil.Video) uuid.UUID {
		if v.Owner == uuid.Nil {
			v.Owner = alice.ID
		}
		id := testutil.SeedVideo(t, s.pg.Pool, v).ID
		s.bucket(id, 1, 1000)
		return id
	}
	good := mk(testutil.Video{})
	private := mk(testutil.Video{Visibility: "PRIVATE"})
	unlisted := mk(testutil.Video{Visibility: "UNLISTED"})
	hidden := mk(testutil.Video{Hidden: true})
	proc := mk(testutil.Video{Status: "PROCESSING", Attempts: []float32{5}})
	susp := mk(testutil.Video{Owner: suspended.ID})
	del := mk(testutil.Video{Owner: deleted.ID})

	// At compute time only the good one is ranked.
	s.recompute()
	if got := ids2(s.ranking()); len(got) != 1 || got[0] != good {
		t.Fatalf("ranked %v, want only %s (excluded: %v)", got, good, []uuid.UUID{private, unlisted, hidden, proc, susp, del})
	}
	code, _, body := s.get("/v1/videos?sort=trending")
	if code != 200 || len(js[searchPage](t, body).Items) != 1 {
		t.Fatalf("%d %s", code, body)
	}

	// At read time: rank several videos, then close them WITHOUT a recompute (the ranking is up to 10 minutes old).
	extra := map[string]uuid.UUID{}
	for name, v := range map[string]testutil.Video{"a": {}, "b": {}, "c": {}, "d": {}, "e": {}} {
		extra[name] = mk(v)
	}
	s.recompute()
	if got := len(s.ranking()); got != 6 {
		t.Fatalf("%d ranked", got)
	}
	closers := []string{
		`UPDATE media.videos SET visibility = 'PRIVATE' WHERE id = $1`,
		`UPDATE media.videos SET moderation_state = 'HIDDEN', moderation_reason = 'spam', moderated_by = owner_id, moderated_at = now() WHERE id = $1`,
		`UPDATE media.videos SET visibility = 'UNLISTED' WHERE id = $1`,
	}
	closed := []uuid.UUID{extra["a"], extra["b"], extra["c"]}
	for i, id := range closed {
		if _, err := s.pg.Pool.Exec(ctx, closers[i], id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.pg.Pool.Exec(ctx, `UPDATE auth.users SET status = 'SUSPENDED' WHERE id = $1`, alice.ID); err != nil {
		t.Fatal(err)
	}
	// The owner of everything is suspended now: nothing may be served, whatever media.trending says.
	if code, _, body := s.get("/v1/videos?sort=trending"); code != 200 || len(js[searchPage](t, body).Items) != 0 {
		t.Fatalf("suspended owner: %d %s", code, body)
	}
	if _, err := s.pg.Pool.Exec(ctx, `UPDATE auth.users SET status = 'ACTIVE' WHERE id = $1`, alice.ID); err != nil {
		t.Fatal(err)
	}
	served := map[string]bool{}
	code, _, body = s.get("/v1/videos?sort=trending")
	if code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	for _, it := range js[searchPage](t, body).Items {
		served[it.ID] = true
	}
	if len(served) != 3 { // good + d + e
		t.Fatalf("served %v", served)
	}
	for _, id := range closed {
		if served[id.String()] {
			t.Fatalf("%s was closed since the last recompute but is served", id)
		}
	}
}

// ---- concurrency -------------------------------------------------------------------------------------------

// While one replica holds the advisory lock (it is recomputing), the others skip and touch nothing.
func TestConcurrentRecomputeRunsOnOneReplica(t *testing.T) {
	s := startTrending(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	s.bucket(v, 1, 100)

	// Another "replica" is in the middle of its run: it holds the lock.
	holder, err := s.pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_xact_lock(x'77696e6b65790001'::bigint)`); err != nil {
		t.Fatal(err)
	}
	var ran atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := s.job().RunOnce(ctx) // a job per replica
			if err != nil {
				t.Errorf("RunOnce: %v", err)
			}
			if res.Ran {
				ran.Add(1)
			}
		}()
	}
	wg.Wait()
	if ran.Load() != 0 || len(s.ranking()) != 0 {
		t.Fatalf("%d runs went ahead while the lock was held; ranking %v", ran.Load(), s.ranking())
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if res := s.recompute(); !res.Ran || len(s.ranking()) != 1 {
		t.Fatalf("after the lock is released: %+v", res)
	}
	// Also: the same Job value never overlaps with itself.
	j := s.job()
	var both atomic.Int32
	var wg2 sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg2.Add(1)
		go func() {
			defer wg2.Done()
			if res, err := j.RunOnce(ctx); err != nil {
				t.Errorf("%v", err)
			} else if res.Ran {
				both.Add(1)
			}
		}()
	}
	wg2.Wait()
	if both.Load() < 1 {
		t.Fatal("nobody ran")
	}
}

// Readers never see a half table: while recomputes keep replacing the ranking, every read (a single statement
// or a whole REPEATABLE READ transaction) sees N contiguous ranks, never zero rows, never a mix.
func TestReadersNeverSeeAHalfRanking(t *testing.T) {
	s := startTrending(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	vids := testutil.SeedManyReady(t, s.pg.Pool, owner.ID, 60)
	for i, id := range vids {
		s.bucket(id, 1, int64(100+i))
	}
	s.recompute()
	if len(s.ranking()) != 60 {
		t.Fatal("setup")
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup
	var reads, bad atomic.Int64
	check := func(n, maxRank int, minRank int, distinct int) bool {
		return n == 60 && maxRank == 60 && minRank == 1 && distinct == 60
	}
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func(txn bool) {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				var n, hi, lo, distinct int
				var err error
				if txn { // a parallel REPEATABLE READ transaction reads twice and must see the same ranking
					err = s.readInTransaction(ctx, &n, &hi, &lo, &distinct)
				} else {
					err = s.pg.Pool.QueryRow(ctx, `SELECT count(*), coalesce(max(rank),0), coalesce(min(rank),0), count(DISTINCT rank) FROM media.trending`).Scan(&n, &hi, &lo, &distinct)
				}
				if err != nil {
					t.Errorf("read: %v", err)
					return
				}
				reads.Add(1)
				if !check(n, hi, lo, distinct) {
					bad.Add(1)
					t.Errorf("half ranking: %d rows, ranks %d..%d, %d distinct", n, lo, hi, distinct)
					return
				}
			}
		}(r%2 == 1)
	}
	// Meanwhile: new views arrive and the ranking is recomputed again and again.
	for i := 0; i < 25; i++ {
		s.bucket(vids[i%len(vids)], 0, int64(50+i))
		if res, err := s.job().RunOnce(ctx); err != nil || !res.Ran {
			t.Fatalf("run %d: %+v %v", i, res, err)
		}
	}
	close(stop)
	wg.Wait()
	if reads.Load() < 20 || bad.Load() != 0 {
		t.Fatalf("%d reads, %d bad", reads.Load(), bad.Load())
	}
}

// readInTransaction reads the ranking twice in one REPEATABLE READ transaction; both reads must match.
func (s *trendStack) readInTransaction(ctx context.Context, n, hi, lo, distinct *int) error {
	tx, err := s.pg.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `SELECT count(*), coalesce(max(rank),0), coalesce(min(rank),0), count(DISTINCT rank), coalesce(sum(score),0) FROM media.trending`
	var sum1, sum2 float64
	var n2, hi2, lo2, d2 int
	if err := tx.QueryRow(ctx, q).Scan(n, hi, lo, distinct, &sum1); err != nil {
		return err
	}
	time.Sleep(2 * time.Millisecond)
	if err := tx.QueryRow(ctx, q).Scan(&n2, &hi2, &lo2, &d2, &sum2); err != nil {
		return err
	}
	if *n != n2 || sum1 != sum2 {
		return fmt.Errorf("a repeatable-read transaction saw two rankings: %d rows/%v then %d rows/%v", *n, sum1, n2, sum2)
	}
	return nil
}

// ---- retention ---------------------------------------------------------------------------------------------

func TestRetentionDeletesBucketsOlderThanEightDays(t *testing.T) {
	s := startTrending(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	keep := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	// Around the 8 day line: 7 days 22 hours old stays, 8 days 2 hours old goes.
	s.bucket(keep, 7*24+22, 3)
	s.bucket(keep, 8*24+2, 3)
	s.bucket(keep, 0, 3)
	// More old buckets than one batch (5000): 12 000 hours between 9 days and ~509 days back.
	if _, err := s.pg.Pool.Exec(ctx, `
		INSERT INTO media.video_views_hourly (video_id, hour, views)
		SELECT $1, date_trunc('hour', now()) - make_interval(hours => 9 * 24 + g), 1 FROM generate_series(0, 11999) g`, v); err != nil {
		t.Fatal(err)
	}
	res := s.recompute()
	if !res.Ran || res.Retired != 12001 {
		t.Fatalf("retired %d, want 12001 (12000 + the one 8 days 2 h old)", res.Retired)
	}
	var old, recent int
	_ = s.pg.Pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE hour < now() - interval '8 days'), count(*) FROM media.video_views_hourly`).Scan(&old, &recent)
	if old != 0 || recent != 2 {
		t.Fatalf("%d old buckets left, %d buckets in all (want 0 and 2)", old, recent)
	}
	// Idempotent.
	if res := s.recompute(); res.Retired != 0 {
		t.Fatalf("%+v", res)
	}
}

// ---- GET /v1/videos?sort=trending --------------------------------------------------------------------------

func TestListVideosTrendingOverHTTP(t *testing.T) {
	s := startTrending(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	vids := testutil.SeedManyReady(t, s.pg.Pool, owner.ID, 7)
	for i, id := range vids {
		s.bucket(id, 3, int64(10*(i+1))) // distinct scores: vids[6] first
	}
	s.recompute()
	want := ids2(s.ranking())
	if len(want) != 7 || want[0] != vids[6] || want[6] != vids[0] {
		t.Fatalf("ranking %v", want)
	}

	var got []string
	path := "/v1/videos?sort=trending&limit=3"
	for pages := 1; ; pages++ {
		code, hdr, body := s.get(path)
		if code != 200 || hdr.Get("Cache-Control") != "public, max-age=60" {
			t.Fatalf("%d %v %s", code, hdr, body)
		}
		p := js[searchPage](t, body)
		for _, it := range p.Items {
			got = append(got, it.ID)
		}
		if p.NextCursor == nil {
			if pages != 3 {
				t.Fatalf("%d pages", pages)
			}
			break
		}
		path = "/v1/videos?sort=trending&limit=3&cursor=" + url.QueryEscape(*p.NextCursor)
	}
	for i := range want {
		if got[i] != want[i].String() {
			t.Fatalf("position %d: %s, want %s", i, got[i], want[i])
		}
	}

	for _, c := range []struct{ path, code string }{
		{"/v1/videos?sort=trending&owner_id=" + owner.ID.String(), "INVALID_SORT"},
		{"/v1/videos?owner_id=" + owner.ID.String() + "&sort=trending", "INVALID_SORT"},
		{"/v1/videos?sort=popular", "VALIDATION_ERROR"},
		{"/v1/videos?sort=trending&cursor=garbage", "INVALID_CURSOR"},
	} {
		code, _, body := s.get(c.path)
		if code != 400 || js[struct {
			Code string `json:"code"`
		}](t, body).Code != c.code {
			t.Errorf("%s: %d %s", c.path, code, body)
		}
	}
	// sort=newest and no sort still are the feed (newest first, no trending cache header).
	for _, path := range []string{"/v1/videos", "/v1/videos?sort=newest"} {
		code, hdr, body := s.get(path)
		if code != 200 || len(js[searchPage](t, body).Items) != 7 || hdr.Get("Cache-Control") == "public, max-age=60" {
			t.Errorf("%s: %d %v", path, code, hdr)
		}
	}
	// A channel page is unaffected by the ranking.
	if code, _, body := s.get("/v1/videos?owner_id=" + owner.ID.String()); code != 200 || len(js[searchPage](t, body).Items) != 7 {
		t.Fatalf("owner feed: %d %s", code, body)
	}
}

// The view flusher (C3) writes the hourly bucket: what it counts is what trending ranks.
func TestFlushFeedsTheTrendingBuckets(t *testing.T) {
	s := startViews(t, viewOpts{})
	video := s.seed(testutil.Video{})
	for i := 0; i < 5; i++ {
		if !s.counted(report{ua: fmt.Sprintf("ua-%d", i)}, video, 40_000) {
			t.Fatalf("view %d was not counted", i)
		}
	}
	s.flush()
	var views, count int64
	if err := s.pg.Pool.QueryRow(context.Background(), `
		SELECT (SELECT coalesce(sum(views), 0) FROM media.video_views_hourly WHERE video_id = $1),
		       (SELECT view_count FROM media.videos WHERE id = $1)`, video).Scan(&views, &count); err != nil {
		t.Fatal(err)
	}
	if views != 5 || count != 5 {
		t.Fatalf("bucket %d, view_count %d", views, count)
	}
}
