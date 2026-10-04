package api

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

func batchPath(vs ...domain.Video) string {
	var s []string
	for _, v := range vs {
		s = append(s, v.ID.String())
	}
	return "/v1/videos/batch?ids=" + strings.Join(s, ",")
}

func itemIDs(t *testing.T, e *env, u *who, path string) []string {
	t.Helper()
	w := e.req(u, "GET", path, "")
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	out := []string{}
	for _, it := range decode[batchJSON](t, w).Items {
		out = append(out, it.ID)
	}
	return out
}

func idList(vs ...domain.Video) string {
	var s []string
	for _, v := range vs {
		s = append(s, v.ID.String())
	}
	return strings.Join(s, ",")
}

func TestBatchKeepsTheOrderOfIdsNotTheOrderOfCreation(t *testing.T) {
	e := newEnv(t, false)
	a, b, c := e.video(alice), e.video(alice), e.video(bob)
	if got := strings.Join(itemIDs(t, e, anon, batchPath(c, a, b)), ","); got != idList(c, a, b) {
		t.Fatalf("%v", got)
	}
	w := e.req(anon, "GET", batchPath(c, a, b), "")
	it := decode[batchJSON](t, w).Items[0]
	if it.Title != c.Title || it.DurationMs != 12345 || it.ViewCount != 42 || it.ThumbnailURL != mediaBase+"/"+*c.ThumbnailKey {
		t.Fatalf("%+v", it)
	}
}

func TestBatchOmitsWhatGetVideoWouldNotReturn(t *testing.T) {
	e := newEnv(t, false)
	ok := e.video(alice)
	private := e.video(alice, visibility(domain.VisPrivate))
	unlisted := e.video(alice, visibility(domain.VisUnlisted))
	hidden := e.video(alice, func(v *domain.Video) { v.ModerationState = domain.ModHidden })
	processing := e.video(alice, notReady(domain.StatusProcessing))
	suspended := e.video(alice, func(v *domain.Video) { v.Owner.Missing = true })
	unknown := domain.Video{ID: ids.New()}
	all := batchPath(private, ok, unknown, hidden, processing, unlisted, suspended)

	want := func(u *who, vs ...domain.Video) {
		t.Helper()
		if got := strings.Join(itemIDs(t, e, u, all), ","); got != idList(vs...) {
			t.Fatalf("got %v want %v", got, idList(vs...))
		}
	}
	want(anon, ok, unlisted) // PRIVATE, HIDDEN, non-READY, unknown, suspended owner: left out
	want(bob, ok, unlisted)  // another user sees what the anonymous caller sees
	want(alice, private, ok, hidden, unlisted, suspended)
	want(admin, private, ok, hidden, unlisted, suspended)

	// getVideo agrees with the batch for the same caller.
	for _, c := range []struct {
		u  *who
		v  domain.Video
		in bool
	}{{anon, private, false}, {bob, private, false}, {alice, private, true}, {anon, hidden, false}, {alice, hidden, true}} {
		code := e.req(c.u, "GET", "/v1/videos/"+c.v.ID.String(), "").Code
		if (code == 200) != c.in {
			t.Fatalf("getVideo answered %d, the batch rule says visible=%v", code, c.in)
		}
	}
}

func TestBatchPrivateThumbnailIsSignedPublicIsNot(t *testing.T) {
	e := newEnv(t, false)
	pub, priv := e.video(alice), e.video(alice, visibility(domain.VisPrivate))
	items := decode[batchJSON](t, e.req(alice, "GET", batchPath(pub, priv), "")).Items
	if len(items) != 2 || strings.Contains(items[0].ThumbnailURL, "/s/") || !strings.Contains(items[1].ThumbnailURL, mediaBase+"/s/") {
		t.Fatalf("%+v", items)
	}
}

func TestBatchRejectsBadIds(t *testing.T) {
	e := newEnv(t, false)
	a := e.video(alice)
	var fifty, fiftyOne []string
	for i := 0; i < 51; i++ {
		id := ids.New().String()
		fiftyOne = append(fiftyOne, id)
		if i < 50 {
			fifty = append(fifty, id)
		}
	}
	for name, path := range map[string]string{
		"missing":        "/v1/videos/batch",
		"empty":          "/v1/videos/batch?ids=",
		"only commas":    "/v1/videos/batch?ids=,",
		"bad uuid":       "/v1/videos/batch?ids=" + a.ID.String() + ",nope",
		"duplicate":      "/v1/videos/batch?ids=" + a.ID.String() + "," + a.ID.String(),
		"51 ids":         "/v1/videos/batch?ids=" + strings.Join(fiftyOne, ","),
		"trailing comma": "/v1/videos/batch?ids=" + a.ID.String() + ",",
		"braced uuid":    "/v1/videos/batch?ids=%7B" + a.ID.String() + "%7D",
	} {
		w := e.req(anon, "GET", path, "")
		if w.Code != 400 || problemCode(t, w) != "VALIDATION_ERROR" {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	if len(e.store.batchLookups) != 0 {
		t.Fatalf("rejected requests reached the store: %v", e.store.batchLookups)
	}
	if got := itemIDs(t, e, anon, "/v1/videos/batch?ids="+strings.Join(fifty, ",")); len(got) != 0 { // 50 unknown ids are fine
		t.Fatalf("%v", got)
	}
}

func TestBatchCacheControlDependsOnAuthentication(t *testing.T) {
	e := newEnv(t, false)
	a := e.video(alice)
	for u, want := range map[*who]string{anon: "public, max-age=30", bob: "private, no-store", alice: "private, no-store"} {
		if got := e.req(u, "GET", batchPath(a), "").Header().Get("Cache-Control"); got != want {
			t.Errorf("Cache-Control %q, want %q", got, want)
		}
	}
	if got := e.req(anon, "GET", batchPath(domain.Video{ID: ids.New()}), "").Header().Get("Cache-Control"); got != "public, max-age=30" {
		t.Fatal(got) // an empty result carries it too
	}
}

func TestBatchOneQueryForAllCacheMisses(t *testing.T) {
	e := newEnv(t, true)
	var vs []domain.Video
	for i := 0; i < 12; i++ {
		vs = append(vs, e.video(alice))
	}
	e.cache.Set(context.Background(), vs[0]) // two of them are cached already
	e.cache.Set(context.Background(), vs[7])
	if got := decode[batchJSON](t, e.req(anon, "GET", batchPath(vs...), "")).Items; len(got) != 12 {
		t.Fatalf("%d items", len(got))
	}
	if len(e.store.batchLookups) != 1 || e.store.batchLookups[0] != 10 {
		t.Fatalf("store lookups %v, want one for the 10 misses", e.store.batchLookups)
	}
	if e.cache.sets != 2 { // only this test's own two Set calls: the batch does not cache its partial rows
		t.Fatalf("the batch wrote to the cache: %d sets", e.cache.sets)
	}
	for _, v := range vs { // everything cached: no query at all
		e.cache.Set(context.Background(), v)
	}
	e.req(anon, "GET", batchPath(vs...), "")
	if len(e.store.batchLookups) != 1 {
		t.Fatalf("a fully cached batch queried the store: %v", e.store.batchLookups)
	}
}

// A cached full video is viewer independent; the batch still applies visibility to it.
func TestBatchAppliesVisibilityToCachedVideos(t *testing.T) {
	e := newEnv(t, true)
	priv := e.video(alice, visibility(domain.VisPrivate))
	e.cache.Set(context.Background(), priv)
	if got := itemIDs(t, e, bob, batchPath(priv)); len(got) != 0 {
		t.Fatalf("a cached PRIVATE video leaked: %v", got)
	}
	if got := itemIDs(t, e, alice, batchPath(priv)); len(got) != 1 {
		t.Fatalf("%v", got)
	}
}

// /v1/videos/batch must reach batchGetVideos, never getVideo with video_id "batch" (which would be a 404).
func TestBatchRouteIsNotCapturedByGetVideo(t *testing.T) {
	e := newEnv(t, false)
	a := e.video(alice)
	w := e.req(anon, "GET", batchPath(a), "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"items"`) || len(e.store.batchLookups) != 1 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := e.req(anon, "GET", "/v1/videos/batch", ""); w.Code != 400 { // getVideo would say 404
		t.Fatalf("/v1/videos/batch without ids: %d", w.Code)
	}
}

func TestBatchStoreErrorIs500AndTheMetricCountsIds(t *testing.T) {
	e := newEnv(t, false)
	a := e.video(alice)
	e.store.batchErr = errors.New("db down")
	if w := e.reqNoContract(anon, "GET", batchPath(a), ""); w.Code != 500 {
		t.Fatalf("%d", w.Code)
	}
	if testutil.CollectAndCount(batchGetIDs) != 1 {
		t.Fatal("histogram not exported")
	}
}
