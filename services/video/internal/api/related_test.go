package api

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

func sums(prefix string, n int) []domain.Summary {
	out := make([]domain.Summary, n)
	for i := range out {
		out[i] = domain.Summary{ID: uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("%s%d", prefix, i+1))), Title: fmt.Sprintf("%s%d", prefix, i+1)}
	}
	return out
}

func titles(ss []domain.Summary) string {
	var t []string
	for _, s := range ss {
		t = append(t, s.Title)
	}
	return strings.Join(t, " ")
}

func TestMergeRelatedPattern(t *testing.T) {
	s, c, tr := sums("s", 8), sums("c", 4), sums("t", 30)
	for name, tc := range map[string]struct {
		s, c, t []domain.Summary
		limit   int
		want    string
	}{
		"all sources full, pattern 1 1 2 1 3 repeated": {s, c, tr, 12, "s1 s2 c1 s3 t1 s4 s5 c2 s6 t2 s7 s8"},
		"limit 24 continues until similar and channel run out, then trending": {s, c, tr, 24,
			"s1 s2 c1 s3 t1 s4 s5 c2 s6 t2 s7 s8 c3 t3 t4 c4 t5 t6 t7 t8 t9 t10 t11 t12"},
		"limit 1": {s, c, tr, 1, "s1"},
		"limit 3": {s, c, tr, 3, "s1 s2 c1"},
		"similar empty: slots of 1 take the next source of the pattern": {nil, c, tr, 8, "c1 c2 c3 t1 t2 c4 t3 t4"},
		"channel empty":               {s, nil, tr, 8, "s1 s2 s3 s4 t1 s5 s6 s7"},
		"trending empty":              {s, c, nil, 12, "s1 s2 c1 s3 s4 s5 s6 c2 s7 s8 c3 c4"},
		"only trending":               {nil, nil, tr, 5, "t1 t2 t3 t4 t5"},
		"nothing at all":              {nil, nil, nil, 12, ""},
		"fewer candidates than limit": {sums("s", 2), nil, sums("t", 1), 12, "s1 s2 t1"},
	} {
		if got := titles(MergeRelated(tc.s, tc.c, tc.t, tc.limit)); got != tc.want {
			t.Errorf("%s:\n got %q\nwant %q", name, got, tc.want)
		}
	}
}

func TestMergeRelatedSkipsDuplicatesAcrossSources(t *testing.T) {
	s, c, tr := sums("s", 4), sums("c", 4), sums("t", 10)
	c[0] = s[0] // the channel's newest video is also the best similar one
	tr[0], tr[1] = s[1], c[1]
	got := MergeRelated(s, c, tr, 12)
	seen := map[uuid.UUID]bool{}
	for _, v := range got {
		if seen[v.ID] {
			t.Fatalf("%s appears twice in %s", v.Title, titles(got))
		}
		seen[v.ID] = true
	}
	// s1 s2 | channel: c1 is s1 (taken) so c2 | s3 | trending: t1 is s2 (taken), t2 is c2 (taken), so t3 ...
	if want := "s1 s2 c2 s3 t3 s4 c3 c4 t4 t5 t6 t7"; titles(got) != want {
		t.Fatalf("got %q want %q", titles(got), want)
	}
	// limit is never exceeded, and a list never has more than the candidates.
	for _, limit := range []int{1, 2, 7, 24} {
		if n := len(MergeRelated(s, c, tr, limit)); n > limit {
			t.Fatalf("limit %d gave %d", limit, n)
		}
	}
}

func TestRelatedQuery(t *testing.T) {
	for name, tc := range map[string]struct {
		title string
		want  string
		ok    bool
	}{
		"words OR-ed and quoted":             {"Hà Nội mùa thu", "'hà' | 'nội' | 'mùa' | 'thu'", true},
		"lower case":                         {"HELLO World", "'hello' | 'world'", true},
		"punctuation is a separator":         {"a-b, c.d: ef!", "'ef'", true}, // single letters dropped
		"words shorter than 2 runes dropped": {"I am a ox", "'am' | 'ox'", true},
		"duplicates dropped":                 {"go go go Gopher", "'go' | 'gopher'", true},
		"digits kept":                        {"top 10 of 2026", "'top' | '10' | 'of' | '2026'", true},
		"operators and quotes cannot get in": {"a' | b & !c <-> d:* \\ 'drop table'", "'drop' | 'table'", true},
		"empty title":                        {"", "", false},
		"only symbols":                       {"!!! --- ???", "", false},
		"only short words":                   {"a b c", "", false},
		"a 2-rune word of 2 bytes each":      {"ôi ê", "'ôi'", true},
	} {
		got, ok := RelatedQuery(tc.title)
		if got != tc.want || ok != tc.ok {
			t.Errorf("%s: %q %v, want %q %v", name, got, ok, tc.want, tc.ok)
		}
	}
	// At most 12 words.
	long := "w01 w02 w03 w04 w05 w06 w07 w08 w09 w10 w11 w12 w13 w14"
	got, _ := RelatedQuery(long)
	if n := strings.Count(got, "|") + 1; n != 12 || strings.Contains(got, "w13") {
		t.Fatalf("%s", got)
	}
}

func TestParseRelatedLimit(t *testing.T) {
	for raw, want := range map[string]int{"": 12, "1": 1, "12": 12, "24": 24} {
		if got, ok := parseRelatedLimit(raw); !ok || got != want {
			t.Errorf("%q: %d %v", raw, got, ok)
		}
	}
	for _, raw := range []string{"0", "25", "-1", "abc", "1.5", " 3", "99999999999999999999"} {
		if _, ok := parseRelatedLimit(raw); ok {
			t.Errorf("%q accepted", raw)
		}
	}
}

// ---- handler -------------------------------------------------------------------------------------------------------

type memRelatedCache struct {
	mu   sync.Mutex
	m    map[string][]byte
	gets int
	sets int
	ttls []time.Duration
	keys []string
	fail bool // behaves like Valkey down: everything is a miss
}

func (c *memRelatedCache) GetRelated(_ context.Context, key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gets++
	if c.fail {
		return nil, false
	}
	b, ok := c.m[key]
	return b, ok
}

func (c *memRelatedCache) SetRelated(_ context.Context, key string, body []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sets++
	c.keys = append(c.keys, key)
	c.ttls = append(c.ttls, ttl)
	if c.m == nil {
		c.m = map[string][]byte{}
	}
	if !c.fail {
		c.m[key] = body
	}
}

func summaryFor(i int, title string) domain.Summary {
	pub := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Minute)
	return domain.Summary{ID: ids.New(), Title: title, Owner: domain.Profile{ID: alice.id, Handle: "alice", DisplayName: "Alice"},
		DurationMs: 1000 + i, ViewCount: int64(i), PublishedAt: pub, ThumbnailKey: fmt.Sprintf("v/%d/a1/thumb/poster.jpg", i)}
}

func relatedEnv(t *testing.T) (*env, *memRelatedCache) {
	e := newEnv(t, false)
	rc := &memRelatedCache{}
	e.h0.RelatedCache = rc
	return e, rc
}

func relPath(v domain.Video, q string) string { return "/v1/videos/" + v.ID.String() + "/related" + q }

func TestRelatedMergesTheThreeSourcesAndSetsHeaders(t *testing.T) {
	e, rc := relatedEnv(t)
	src := e.video(alice, func(v *domain.Video) { v.Title = "Hà Nội mùa thu" })
	e.store.relSimilar = []domain.Summary{summaryFor(1, "sim 1"), summaryFor(2, "sim 2"), summaryFor(3, "sim 3")}
	e.store.relChannel = []domain.Summary{summaryFor(4, "chan 1"), summaryFor(5, "chan 2")}
	e.store.relTrending = []domain.Summary{summaryFor(6, "trend 1"), summaryFor(7, "trend 2")}

	w := e.req(anon, "GET", relPath(src, ""), "")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "public, max-age=300" {
		t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body)
	}
	var got []string
	for _, it := range decode[relatedJSON](t, w).Items {
		got = append(got, it.Title)
	}
	if strings.Join(got, "|") != "sim 1|sim 2|chan 1|sim 3|trend 1|chan 2|trend 2" {
		t.Fatalf("%v", got)
	}
	if e.store.relQuery != "'hà' | 'nội' | 'mùa' | 'thu'" || e.store.relSimilarLimit != 8 || e.store.relChannelLimit != 4 || e.store.relTrendingLimit != 12+13 {
		t.Fatalf("query %q limits %d %d %d", e.store.relQuery, e.store.relSimilarLimit, e.store.relChannelLimit, e.store.relTrendingLimit)
	}
	if e.store.relSource != src.ID || e.store.relOwner != alice.id {
		t.Fatal("the three queries must exclude the source and the same-channel one use its owner")
	}
	if rc.sets != 1 || rc.ttls[0] != 300*time.Second || rc.keys[0] != "related:v1:"+src.ID.String()+":12" {
		t.Fatalf("cache writes: %+v", rc)
	}
}

func TestRelatedSecondCallIsServedFromTheCacheWithoutQueries(t *testing.T) {
	e, rc := relatedEnv(t)
	src := e.video(alice)
	e.store.relTrending = []domain.Summary{summaryFor(1, "t")}
	first := e.req(anon, "GET", relPath(src, "?limit=5"), "")
	calls := e.store.relCalls
	if calls != 3 {
		t.Fatalf("%d store calls for a miss, want 3 (similar, channel, trending)", calls)
	}
	second := e.req(bob, "GET", relPath(src, "?limit=5"), "") // another caller: the answer is shared
	if e.store.relCalls != calls || first.Body.String() != second.Body.String() || second.Header().Get("Cache-Control") != "public, max-age=300" {
		t.Fatalf("second call queried the store (%d) or differs", e.store.relCalls)
	}
	// Another limit is another key.
	e.req(anon, "GET", relPath(src, "?limit=6"), "")
	if e.store.relCalls != calls+3 || rc.sets != 2 {
		t.Fatalf("limit is part of the key: %d calls, %d sets", e.store.relCalls, rc.sets)
	}
}

func TestRelatedFailsOpenWhenTheCacheIsDown(t *testing.T) {
	e, rc := relatedEnv(t)
	rc.fail = true
	src := e.video(alice)
	for i := 0; i < 2; i++ {
		if w := e.req(anon, "GET", relPath(src, ""), ""); w.Code != 200 {
			t.Fatalf("%d", w.Code)
		}
	}
	if e.store.relCalls != 6 {
		t.Fatalf("a dead cache must recompute every time: %d calls", e.store.relCalls)
	}
}

func TestRelatedWithoutCacheAndWithEmptyTitleSkipsSimilar(t *testing.T) {
	e := newEnv(t, false)
	src := e.video(alice, func(v *domain.Video) { v.Title = "a !" })
	e.store.relChannel = []domain.Summary{summaryFor(1, "c")}
	w := e.req(anon, "GET", relPath(src, ""), "")
	if w.Code != 200 || len(decode[relatedJSON](t, w).Items) != 1 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if e.store.relSimilarCalls != 0 || e.store.relCalls != 2 {
		t.Fatalf("similar must be skipped for a title without words: similar %d total %d", e.store.relSimilarCalls, e.store.relCalls)
	}
	// An empty answer is a 200 with an empty list, not null.
	e2 := newEnv(t, false)
	s2 := e2.video(alice)
	if w := e2.req(anon, "GET", relPath(s2, ""), ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"items":[]`) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestRelatedSourceMustBeOpenToThePublic(t *testing.T) {
	e, _ := relatedEnv(t)
	private := e.video(alice, visibility(domain.VisPrivate))
	hidden := e.video(alice, func(v *domain.Video) { v.ModerationState = domain.ModHidden })
	processing := e.video(alice, notReady(domain.StatusProcessing))
	suspended := e.video(alice, func(v *domain.Video) { v.Owner.Missing = true })
	unlisted := e.video(alice, visibility(domain.VisUnlisted))
	ok := e.video(alice)
	for name, tc := range map[string]struct {
		u    *who
		v    domain.Video
		code int
	}{
		"private for anonymous":         {anon, private, 404},
		"private for another user":      {bob, private, 404},
		"private even for its owner":    {alice, private, 404},
		"hidden for anonymous":          {anon, hidden, 404},
		"hidden even for its owner":     {alice, hidden, 404},
		"hidden even for an admin":      {admin, hidden, 404},
		"processing even for its owner": {alice, processing, 404},
		"suspended owner":               {anon, suspended, 404},
		"unknown id":                    {anon, domain.Video{ID: ids.New()}, 404},
		"unlisted is fine":              {anon, unlisted, 200},
		"public":                        {anon, ok, 200},
		"public for the owner":          {alice, ok, 200},
	} {
		if w := e.req(tc.u, "GET", relPath(tc.v, ""), ""); w.Code != tc.code {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	if w := e.req(anon, "GET", "/v1/videos/not-a-uuid/related", ""); w.Code != 404 {
		t.Fatalf("bad id: %d", w.Code)
	}
}

func TestRelatedRejectsABadLimitBeforeAnyQuery(t *testing.T) {
	e, _ := relatedEnv(t)
	src := e.video(alice)
	for _, q := range []string{"?limit=0", "?limit=25", "?limit=-3", "?limit=abc", "?limit="} {
		w := e.req(anon, "GET", relPath(src, q), "")
		want := 400
		if q == "?limit=" { // empty means "not given": the default
			want = 200
		}
		if w.Code != want || (want == 400 && problemCode(t, w) != "VALIDATION_ERROR") {
			t.Errorf("%s: %d %s", q, w.Code, w.Body)
		}
	}
	if e.store.relCalls != 3 { // only the "limit=" request reached the store
		t.Fatalf("%d store calls", e.store.relCalls)
	}
}
