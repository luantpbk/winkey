package store

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// These tests run the search on real PostgreSQL 17 with the real migrations
// (winkey_fold, search_vector, the two partial GIN indexes).

func titles(hits []domain.SearchHit) []string {
	var out []string
	for _, h := range hits {
		out = append(out, h.Title)
	}
	return out
}

func search(t *testing.T, st *Postgres, q string) domain.SearchResult {
	t.Helper()
	res, err := st.SearchVideos(context.Background(), domain.SearchQuery{Q: q, Limit: 50})
	if err != nil {
		t.Fatalf("search %q: %v", q, err)
	}
	return res
}

func TestSearchFoldsCaseAndVietnameseDiacritics(t *testing.T) {
	st, pg := setup(t)
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	hanoi := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Du lịch Hà Nội mùa thu"})
	dalat := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Đà Lạt mộng mơ"})

	for q, want := range map[string]uuid.UUID{
		"ha noi":    hanoi.ID, // no diacritics finds the accented title
		"HÀ NỘI":    hanoi.ID, // case and diacritics
		"Hà Nội":    hanoi.ID,
		"noi ha":    hanoi.ID, // every word must match, in any order
		"da lat":    dalat.ID, // đ folds to d
		"Đà Lạt":    dalat.ID,
		"ĐÀ LẠT":    dalat.ID,
		"  da lat ": dalat.ID,
		"mong mo":   dalat.ID,
	} {
		res := search(t, st, q)
		if res.Mode != domain.SearchFTS || len(res.Hits) != 1 || res.Hits[0].ID != want {
			t.Errorf("%q: mode=%s %v", q, res.Mode, titles(res.Hits))
		}
	}
	// Both words must match: "ha lat" is not a full-text hit (it can only come from the fallback).
	if res := search(t, st, "ha lat"); res.Mode == domain.SearchFTS && len(res.Hits) > 0 {
		t.Errorf("ha lat: %v", titles(res.Hits))
	}
	// Owner data comes with the row, as in the feed.
	h := search(t, st, "da lat").Hits[0]
	if h.Owner.Handle != "alice" || h.Owner.DisplayName != owner.Name || h.ThumbnailKey == "" || h.DurationMs == 0 || h.PublishedAt.IsZero() {
		t.Fatalf("%+v", h)
	}
}

func TestSearchTitleOutranksDescription(t *testing.T) {
	st, pg := setup(t)
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	now := time.Now().UTC().Truncate(time.Microsecond)
	// The description match is the NEWER video, so only the weights can put the title first.
	inTitle := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Hà Nội", Description: "xin chào các bạn", Published: now.Add(-time.Hour)})
	inDesc := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Du lịch", Description: "khám phá Hà Nội", Published: now})

	res := search(t, st, "ha noi")
	if res.Mode != domain.SearchFTS || len(res.Hits) != 2 || res.Hits[0].ID != inTitle.ID || res.Hits[1].ID != inDesc.ID {
		t.Fatalf("%s %v", res.Mode, titles(res.Hits))
	}
	if !(res.Hits[0].Rank > res.Hits[1].Rank) {
		t.Fatalf("ranks %v %v", res.Hits[0].Rank, res.Hits[1].Rank)
	}
}

func TestSearchTypoFallsBackToTrigrams(t *testing.T) {
	st, pg := setup(t)
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	pho := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Nấu phở bò tái"})
	testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Du lịch Hà Nội"})

	// "tia" is not a word of any title: full text finds nothing, the title is similar (0.67).
	res := search(t, st, "nau pho bo tia")
	if res.Mode != domain.SearchTrgm || len(res.Hits) != 1 || res.Hits[0].ID != pho.ID {
		t.Fatalf("%s %v", res.Mode, titles(res.Hits))
	}
	if res.Hits[0].Rank < 0.3 || res.Hits[0].Rank > 1 {
		t.Fatalf("similarity %v", res.Hits[0].Rank)
	}
	// Nothing similar: an empty page, in the last mode tried.
	if res := search(t, st, "quantum chromodynamics"); len(res.Hits) != 0 {
		t.Fatalf("%s %v", res.Mode, titles(res.Hits))
	}
	// A full-text hit never adds trigram results.
	if res := search(t, st, "pho"); res.Mode != domain.SearchFTS || len(res.Hits) != 1 {
		t.Fatalf("%s %v", res.Mode, titles(res.Hits))
	}
	// The fallback belongs to the first page only: a cursor pins its mode.
	after := &domain.SearchAfter{Rank: 2, T: time.Now().UTC(), ID: uuid.Max}
	res, err := st.SearchVideos(context.Background(), domain.SearchQuery{Q: "nau pho bo tia", Mode: domain.SearchFTS, After: after, Limit: 10})
	if err != nil || res.Mode != domain.SearchFTS || len(res.Hits) != 0 {
		t.Fatalf("fts page 2 must not fall back: %+v %v", res, err)
	}
	res, err = st.SearchVideos(context.Background(), domain.SearchQuery{Q: "nau pho bo tia", Mode: domain.SearchTrgm, After: after, Limit: 10})
	if err != nil || res.Mode != domain.SearchTrgm || len(res.Hits) != 1 {
		t.Fatalf("trgm page 2 continues in trgm: %+v %v", res, err)
	}
}

func TestSearchNeverReturnsWhatTheFeedHides(t *testing.T) {
	st, pg := setup(t)
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	ghost := testutil.SeedUser(t, pg.Pool, "ghost", nil, "SUSPENDED")
	gone := testutil.SeedUser(t, pg.Pool, "gone", nil, "DELETED")

	visible := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Title: "Ngựa vằn zebra", Description: "zebra"})
	for _, v := range []testutil.Video{
		{Owner: alice.ID, Visibility: "PRIVATE"},
		{Owner: alice.ID, Visibility: "UNLISTED"},
		{Owner: alice.ID, Status: "PROCESSING", Attempts: []float32{10}},
		{Owner: alice.ID, Status: "UPLOADED"},
		{Owner: alice.ID, Status: "FAILED", Error: "boom"},
		{Owner: alice.ID, Hidden: true},
		{Owner: ghost.ID},
		{Owner: gone.ID},
	} {
		v.Title, v.Description = "Ngựa vằn zebra", "zebra"
		testutil.SeedVideo(t, pg.Pool, v)
	}
	for _, q := range []string{"zebra", "ngua van", "ngua van zebrra"} { // full text, then the fallback
		res := search(t, st, q)
		if len(res.Hits) != 1 || res.Hits[0].ID != visible.ID {
			t.Errorf("%q (%s): got %d hits %v", q, res.Mode, len(res.Hits), titles(res.Hits))
		}
	}
	got, err := st.SuggestTitles(context.Background(), "ngua", 8)
	if err != nil || len(got) != 1 {
		t.Fatalf("suggest: %v %v", got, err)
	}
	// Restoring or hiding follows at once (no denormalised copy).
	if _, err := pg.Pool.Exec(context.Background(),
		`UPDATE media.videos SET moderation_state='HIDDEN', moderation_reason='x', moderated_by=owner_id, moderated_at=now() WHERE id=$1`, visible.ID); err != nil {
		t.Fatal(err)
	}
	if res := search(t, st, "zebra"); len(res.Hits) != 0 {
		t.Fatalf("hidden video still found: %v", titles(res.Hits))
	}
}

// pageAll walks the cursors the way the API does.
func pageAll(t *testing.T, st *Postgres, q string, limit int) (hits []domain.SearchHit, pages int) {
	t.Helper()
	sq := domain.SearchQuery{Q: q, Limit: limit + 1}
	for {
		res, err := st.SearchVideos(context.Background(), sq)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		n := min(len(res.Hits), limit)
		hits = append(hits, res.Hits[:n]...)
		if len(res.Hits) <= limit {
			return hits, pages
		}
		last := res.Hits[limit-1]
		sq.Mode = res.Mode
		sq.After = &domain.SearchAfter{Rank: last.Rank, T: last.PublishedAt, ID: last.ID}
		if pages > 100 {
			t.Fatal("paging does not end")
		}
	}
}

func TestSearchKeysetPagingIsStableWithEqualRanks(t *testing.T) {
	st, pg := setup(t)
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	base := time.Date(2026, 10, 1, 8, 0, 0, 123456000, time.UTC)
	// 12 identical titles published at the SAME instant (equal rank, equal time: only the id orders
	// them), 6 identical titles at distinct times, and 5 with the match in the description only.
	for i := 0; i < 12; i++ {
		testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Nhạc thư giãn", Published: base})
	}
	for i := 0; i < 6; i++ {
		testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Nhạc thư giãn", Published: base.Add(-time.Duration(i+1) * time.Minute)})
	}
	for i := 0; i < 5; i++ {
		testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: fmt.Sprintf("Playlist %d", i), Description: "nhạc thư giãn cuối tuần", Published: base.Add(time.Duration(i) * time.Minute)})
	}

	all := search(t, st, "nhac thu gian").Hits // one page holding everything (limit 50)
	if len(all) != 23 || all[0].Rank == all[len(all)-1].Rank {
		t.Fatalf("setup: %d hits, ranks %v..%v", len(all), all[0].Rank, all[len(all)-1].Rank)
	}
	want := slices.Clone(all)
	sort.SliceStable(want, func(i, j int) bool {
		a, b := want[i], want[j]
		if a.Rank != b.Rank {
			return a.Rank > b.Rank
		}
		if !a.PublishedAt.Equal(b.PublishedAt) {
			return a.PublishedAt.After(b.PublishedAt)
		}
		return a.ID.String() > b.ID.String()
	})
	for i := range all {
		if all[i].ID != want[i].ID {
			t.Fatalf("the query is not ordered by (rank, published_at, id) DESC at %d", i)
		}
	}

	for _, limit := range []int{1, 2, 5, 7, 22, 23, 24} {
		got, pages := pageAll(t, st, "nhac thu gian", limit)
		if len(got) != len(all) {
			t.Fatalf("limit %d: %d items in %d pages, want %d", limit, len(got), pages, len(all))
		}
		for i := range got {
			if got[i].ID != all[i].ID {
				t.Fatalf("limit %d: item %d is %s, want %s", limit, i, got[i].ID, all[i].ID)
			}
		}
	}
}

func TestSearchTrigramPagingIsStable(t *testing.T) {
	st, pg := setup(t)
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	base := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	for i := 0; i < 9; i++ {
		testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Nấu phở bò tái", Published: base.Add(time.Duration(i%3) * time.Minute)})
	}
	testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: "Nấu phở bò tái chín gầu", Published: base})
	all := search(t, st, "nau pho bo tia")
	if all.Mode != domain.SearchTrgm || len(all.Hits) != 10 {
		t.Fatalf("%s %d", all.Mode, len(all.Hits))
	}
	got, _ := pageAll(t, st, "nau pho bo tia", 3)
	if len(got) != 10 {
		t.Fatalf("%d", len(got))
	}
	for i := range got {
		if got[i].ID != all.Hits[i].ID {
			t.Fatalf("item %d differs", i)
		}
	}
}

func TestSuggestTitles(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	seed := func(title string, views int64) {
		testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Title: title, ViewCount: views})
	}
	// Duplicates by folded title collapse to one suggestion.
	seed("Hà Nội mùa thu", 5)
	seed("Hà Nội mùa thu", 9)
	seed("HA NOI MUA THU", 1)
	seed("Hà Giang loop", 3)
	seed("Cách nấu phở", 2) // similar to "nau pho", not a prefix
	seed("Nấu phở bò tái", 1)
	seed("Top 100% hay", 1)
	seed("Top 1000 hay", 1)

	got, err := st.SuggestTitles(ctx, "ha", 8)
	slices.Sort(got)
	if err != nil || !slices.Equal(got, []string{"Hà Giang loop", "Hà Nội mùa thu"}) { // the most viewed spelling represents its duplicates
		t.Fatalf("%v %v", got, err)
	}
	// Prefix matches come before merely similar titles; diacritics and case are folded.
	got, err = st.SuggestTitles(ctx, "NAU PHO", 8)
	if err != nil || len(got) != 2 || got[0] != "Nấu phở bò tái" || got[1] != "Cách nấu phở" {
		t.Fatalf("%v %v", got, err)
	}
	// LIKE wildcards in the query are text, not patterns.
	got, err = st.SuggestTitles(ctx, "top 100%", 8)
	if err != nil || len(got) == 0 || got[0] != "Top 100% hay" {
		t.Fatalf("%v %v", got, err)
	}
	for _, q := range []string{"__", "%%", `\\`} {
		if got, err = st.SuggestTitles(ctx, q, 8); err != nil || len(got) != 0 {
			t.Fatalf("%q matched %v (%v)", q, got, err)
		}
	}
	// At most limit titles, all distinct.
	for i := 0; i < 20; i++ {
		seed(fmt.Sprintf("Kem tươi số %d", i), int64(i))
	}
	got, err = st.SuggestTitles(ctx, "kem", 8)
	if err != nil || len(got) != 8 {
		t.Fatalf("%d titles: %v %v", len(got), got, err)
	}
	seen := map[string]bool{}
	for _, g := range got {
		if seen[g] {
			t.Fatalf("duplicate %q in %v", g, got)
		}
		seen[g] = true
	}
	if got, err = st.SuggestTitles(ctx, "zzzz", 8); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("no match must be an empty, non-nil slice: %#v %v", got, err)
	}
}

// ---- EXPLAIN: the queries must be able to use the partial indexes ---------------

type planNode struct {
	NodeType  string     `json:"Node Type"`
	IndexName string     `json:"Index Name"`
	Relation  string     `json:"Relation Name"`
	Plans     []planNode `json:"Plans"`
}

func (n planNode) walk(f func(planNode)) {
	f(n)
	for _, c := range n.Plans {
		c.walk(f)
	}
}

// explain plans sql for the first call as PostgreSQL would run it, with
// sequential scans discouraged: a table this small is otherwise always scanned.
// It answers "CAN the planner use the index" — which fails as soon as the query
// text drifts from the index expression or predicate.
func explain(t *testing.T, st *Postgres, sql string, args []any) planNode {
	t.Helper()
	ctx := context.Background()
	tx, err := st.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, s := range []string{`SET LOCAL enable_seqscan = off`, `SET LOCAL pg_trgm.similarity_threshold = ` + trigramThreshold} {
		if _, err := tx.Exec(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	var raw []byte
	if err := tx.QueryRow(ctx, `EXPLAIN (FORMAT JSON) `+sql, args...).Scan(&raw); err != nil {
		t.Fatalf("explain: %v\n%s", err, sql)
	}
	var top []struct {
		Plan planNode `json:"Plan"`
	}
	if err := json.Unmarshal(raw, &top); err != nil || len(top) != 1 {
		t.Fatalf("plan json: %v %s", err, raw)
	}
	return top[0].Plan
}

func usesIndex(p planNode, index string) bool {
	found := false
	p.walk(func(n planNode) {
		if n.NodeType == "Bitmap Index Scan" && n.IndexName == index {
			found = true
		}
	})
	return found
}

func (p planNode) String() string { b, _ := json.Marshal(p); return string(b) }

// seedMany bulk-inserts n READY PUBLIC videos through the state machine (in a few statements):
// the first `rare` are titled "Hà Nội mùa thu số i", the others "Bài hát số i".
func seedMany(t *testing.T, pg *testkit.Postgres, owner uuid.UUID, n, rare int) {
	t.Helper()
	ctx := context.Background()
	for _, q := range []string{
		`INSERT INTO media.videos (id, owner_id, title, description, raw_bucket, raw_key, content_type, size_bytes)
		 SELECT gen_random_uuid(), $1, CASE WHEN i <= $3 THEN 'Hà Nội mùa thu số ' ELSE 'Bài hát số ' END || i,
		        'phố cổ', 'winkey-raw', 'k' || i, 'video/mp4', 1000 FROM generate_series(1, $2::int) i`,
		`UPDATE media.videos SET status = 'UPLOADED'`,
		`UPDATE media.videos SET status = 'PROCESSING'`,
		`UPDATE media.videos SET status = 'READY', duration_ms = 1000, width = 1280, height = 720,
		        hls_master_key = 'h/' || id, thumbnail_key = 't/' || id, published_at = now() - (random() * interval '30 days')`,
	} {
		args := []any{}
		if strings.Contains(q, "$1") {
			args = []any{owner, n, rare}
		}
		if _, err := pg.Pool.Exec(ctx, q, args...); err != nil {
			t.Fatalf("seed many: %v: %s", err, q)
		}
	}
}

func TestSearchQueriesUseThePartialIndexes(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	// A realistic table: a few videos match, thousands do not. On a table where every row matches,
	// the planner rightly prefers the feed index.
	seedMany(t, pg, owner.ID, 3000, 5)
	if _, err := pg.Pool.Exec(ctx, `ANALYZE media.videos`); err != nil {
		t.Fatal(err)
	}
	after := &domain.SearchAfter{Rank: 0.1, T: time.Now().UTC(), ID: uuid.Max}

	for _, tc := range []struct {
		name, mode, index string
		after             *domain.SearchAfter
	}{
		{"fts first page", domain.SearchFTS, "videos_search_fts", nil},
		{"fts next page", domain.SearchFTS, "videos_search_fts", after},
		{"trgm first page", domain.SearchTrgm, "videos_search_title_trgm", nil},
		{"trgm next page", domain.SearchTrgm, "videos_search_title_trgm", after},
	} {
		sql, args := searchSQL(tc.mode, tc.after, 25)
		args[0] = "ha noi mua thu"
		plan := explain(t, st, sql, args)
		if !usesIndex(plan, tc.index) {
			t.Errorf("%s: %s is not used:\n%s", tc.name, tc.index, plan)
		}
		plan.walk(func(n planNode) {
			if n.NodeType == "Seq Scan" && n.Relation == "videos" {
				t.Errorf("%s: sequential scan of media.videos:\n%s", tc.name, plan)
			}
		})
	}

	// Sensitivity check: the same query without the moderation predicate is NOT covered by the
	// partial indexes, so this test would notice if the literal predicate drifted.
	for mode, index := range map[string]string{domain.SearchFTS: "videos_search_fts", domain.SearchTrgm: "videos_search_title_trgm"} {
		sql, args := searchSQL(mode, nil, 25)
		args[0] = "ha noi mua thu"
		drifted := strings.Replace(sql, ` AND v.moderation_state = 'VISIBLE'`, "", 1)
		if drifted == sql {
			t.Fatal("test bug: predicate text not found in the query")
		}
		if plan := explain(t, st, drifted, args); usesIndex(plan, index) {
			t.Errorf("%s used without the moderation predicate: the check cannot detect drift:\n%s", index, plan)
		}
	}
}
