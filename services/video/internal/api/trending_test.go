package api

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

func rank(e *env, vs ...domain.Video) {
	e.store.ranking = nil
	for i, v := range vs {
		e.store.ranking = append(e.store.ranking, rankedVideo{id: v.ID, rank: i + 1})
	}
}

func pageIDs(p pageJSON[summaryJSON]) []string {
	var out []string
	for _, it := range p.Items {
		out = append(out, it.ID)
	}
	return out
}

func TestTrendingPagesByRankWithACursor(t *testing.T) {
	e := newEnv(t, false)
	var vs []domain.Video
	for i := 0; i < 7; i++ {
		vs = append(vs, e.video(alice))
	}
	rank(e, vs...)

	var got []string
	path := "/v1/videos?sort=trending&limit=3"
	for pages := 0; ; pages++ {
		w := e.req(anon, "GET", path, "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "public, max-age=60" {
			t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body)
		}
		p := decode[pageJSON[summaryJSON]](t, w)
		got = append(got, pageIDs(p)...)
		if p.NextCursor == nil {
			if pages != 2 { // 3 + 3 + 1
				t.Fatalf("%d pages", pages+1)
			}
			break
		}
		path = "/v1/videos?sort=trending&limit=3&cursor=" + url.QueryEscape(*p.NextCursor)
	}
	for i, v := range vs {
		if got[i] != v.ID.String() {
			t.Fatalf("item %d is %s, want rank order %s", i, got[i], v.ID)
		}
	}
	if len(got) != 7 {
		t.Fatalf("%d items", len(got))
	}
}

func TestTrendingEmptyRankingIsAnEmptyPageNotAnError(t *testing.T) {
	e := newEnv(t, false)
	w := e.req(anon, "GET", "/v1/videos?sort=trending", "")
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"items":[],"next_cursor":null}` || w.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

// A video made PRIVATE, hidden, or whose owner is gone since the last recompute never shows up.
func TestTrendingReappliesThePublicFeedPredicateAtReadTime(t *testing.T) {
	e := newEnv(t, false)
	ok := e.video(alice)
	private := e.video(alice, visibility(domain.VisPrivate))
	unlisted := e.video(alice, visibility(domain.VisUnlisted))
	hidden := e.video(alice, func(v *domain.Video) { v.ModerationState = domain.ModHidden })
	ghost := e.video(alice, func(v *domain.Video) { v.Owner.Missing = true })
	processing := e.video(alice, notReady(domain.StatusProcessing))
	rank(e, private, unlisted, hidden, ghost, processing, ok)
	p := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?sort=trending", ""))
	if got := pageIDs(p); len(got) != 1 || got[0] != ok.ID.String() {
		t.Fatalf("%v", got)
	}
}

func TestTrendingSortValidation(t *testing.T) {
	e := newEnv(t, false)
	owner := "&owner_id=" + alice.id.String()
	for name, c := range map[string]struct{ path, code string }{
		"owner_id with trending":       {"/v1/videos?sort=trending" + owner, "INVALID_SORT"},
		"owner_id first":               {"/v1/videos?owner_id=" + alice.id.String() + "&sort=trending", "INVALID_SORT"},
		"owner_id even when malformed": {"/v1/videos?sort=trending&owner_id=nope", "INVALID_SORT"},
		"unknown sort":                 {"/v1/videos?sort=popular", "VALIDATION_ERROR"},
		"upper case":                   {"/v1/videos?sort=Trending", "VALIDATION_ERROR"},
		"bad limit":                    {"/v1/videos?sort=trending&limit=0", "VALIDATION_ERROR"},
		"garbage cursor":               {"/v1/videos?sort=trending&cursor=abc", "INVALID_CURSOR"},
	} {
		w := e.req(anon, "GET", c.path, "")
		if w.Code != 400 || problemCode(t, w) != c.code {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	// sort=newest and no sort are the feed as before, without the trending cache header.
	e.video(alice)
	for _, path := range []string{"/v1/videos", "/v1/videos?sort=newest"} {
		w := e.req(anon, "GET", path, "")
		if w.Code != 200 || len(decode[pageJSON[summaryJSON]](t, w).Items) != 1 || w.Header().Get("Cache-Control") != "" {
			t.Errorf("%s: %d %v %s", path, w.Code, w.Header(), w.Body)
		}
	}
	if e.store.trendingReads != 0 {
		t.Error("a rejected or newest request read the ranking")
	}
}

// A feed cursor is not a trending cursor and the other way round (the MAC covers the endpoint).
func TestTrendingAndFeedCursorsAreNotInterchangeable(t *testing.T) {
	e := newEnv(t, false)
	var vs []domain.Video
	for i := 0; i < 4; i++ {
		vs = append(vs, e.video(alice))
	}
	rank(e, vs...)
	feed := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?limit=2", ""))
	trend := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?sort=trending&limit=2", ""))
	if feed.NextCursor == nil || trend.NextCursor == nil {
		t.Fatal("expected two pages")
	}
	if w := e.req(anon, "GET", "/v1/videos?sort=trending&cursor="+url.QueryEscape(*feed.NextCursor), ""); w.Code != http.StatusBadRequest || problemCode(t, w) != "INVALID_CURSOR" {
		t.Errorf("feed cursor on trending: %d", w.Code)
	}
	if w := e.req(anon, "GET", "/v1/videos?cursor="+url.QueryEscape(*trend.NextCursor), ""); w.Code != http.StatusBadRequest || problemCode(t, w) != "INVALID_CURSOR" {
		t.Errorf("trending cursor on the feed: %d", w.Code)
	}
}
