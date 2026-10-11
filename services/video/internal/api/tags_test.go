package api

import (
	"net/url"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// withTags sets the tags and, like the generated column tag_slugs, their slugs.
func withTags(tags ...string) func(*domain.Video) {
	return func(v *domain.Video) { v.Tags, v.TagSlugs = tags, testSlugs(tags) }
}

func pageTitles(p pageJSON[summaryJSON]) string {
	var out []string
	for _, s := range p.Items {
		out = append(out, s.Title)
	}
	return strings.Join(out, "|")
}

func TestListVideosByTag(t *testing.T) {
	e := newEnv(t, false)
	a := e.video(alice, withTags("Phim ngắn", "Dân gian"))
	b := e.video(bob, withTags("phim  NGẮN"))
	e.video(alice, withTags("Du lịch"))
	e.video(alice, withTags("Phim ngắn"), visibility(domain.VisPrivate)) // never listed
	e.video(alice, withTags("!!!"))                                      // empty slug: never a tag

	// Slug and tag text select the same videos, newest first; the response is publicly cacheable.
	for _, tag := range []string{"phim-ngan", "Phim ngắn", " PHIM NGAN "} {
		w := e.req(anon, "GET", "/v1/videos?tag="+url.QueryEscape(tag), "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "public, max-age=60" {
			t.Fatalf("%q: %d %q", tag, w.Code, w.Header().Get("Cache-Control"))
		}
		if got := pageTitles(decode[pageJSON[summaryJSON]](t, w)); got != b.Title+"|"+a.Title {
			t.Fatalf("%q: %s", tag, got)
		}
	}
	// tag combines with owner_id.
	out := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?tag=phim-ngan&owner_id="+alice.id.String(), ""))
	if pageTitles(out) != a.Title {
		t.Fatalf("owner+tag: %s", pageTitles(out))
	}
	// An input with an empty slug matches nothing (not the punctuation-only tag).
	out = decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?tag=%21%21%21", ""))
	if len(out.Items) != 0 {
		t.Fatalf("empty slug: %s", pageTitles(out))
	}
	// Without tag, the feed is unchanged and carries no tag cache header.
	if w := e.req(anon, "GET", "/v1/videos", ""); w.Code != 200 || w.Header().Get("Cache-Control") == "public, max-age=60" {
		t.Fatalf("plain feed: %d %q", w.Code, w.Header().Get("Cache-Control"))
	}

	if w := e.req(anon, "GET", "/v1/videos?sort=trending&tag=phim-ngan", ""); w.Code != 400 || problemCode(t, w) != "INVALID_SORT" {
		t.Errorf("trending+tag: %d %s", w.Code, w.Body)
	}
	for name, q := range map[string]string{"blank": "tag=%20%20", "empty": "tag=", "too long": "tag=" + strings.Repeat("a", 101)} {
		if w := e.req(anon, "GET", "/v1/videos?"+q, ""); w.Code != 400 || problemCode(t, w) != "VALIDATION_ERROR" {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
}

func TestListVideosByTagPaging(t *testing.T) {
	e := newEnv(t, false)
	a := e.video(alice, withTags("Phở"))
	e.video(alice, withTags("Bún"))
	b := e.video(alice, withTags("pho"))

	first := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?tag=pho&limit=1", ""))
	if pageTitles(first) != b.Title || first.NextCursor == nil {
		t.Fatalf("page 1: %s %v", pageTitles(first), first.NextCursor)
	}
	c := url.QueryEscape(*first.NextCursor)
	second := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?tag=pho&limit=1&cursor="+c, ""))
	if pageTitles(second) != a.Title || second.NextCursor != nil {
		t.Fatalf("page 2: %s %v", pageTitles(second), second.NextCursor)
	}
	// The cursor belongs to its tag: reusing it on the plain feed or another tag is rejected.
	for _, q := range []string{"cursor=" + c, "tag=bun&cursor=" + c} {
		if w := e.req(anon, "GET", "/v1/videos?"+q, ""); w.Code != 400 || problemCode(t, w) != "INVALID_CURSOR" {
			t.Errorf("%s: %d %s", q, w.Code, w.Body)
		}
	}
}

func TestListTags(t *testing.T) {
	e := newEnv(t, false)
	e.video(alice, withTags("Phim ngắn", "Dân gian"))
	e.video(bob, withTags("phim ngắn"))
	e.video(alice, withTags("phim ngắn", "Du lịch"))
	e.video(alice, withTags("Ẩm thực"), visibility(domain.VisPrivate))
	e.video(alice, withTags("!!!"))

	w := e.req(anon, "GET", "/v1/tags", "")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "public, max-age=300" {
		t.Fatalf("%d %q", w.Code, w.Header().Get("Cache-Control"))
	}
	type list struct{ Items []tagJSON }
	got := decode[list](t, w).Items
	// Ranked by count, then slug; the name is the most used spelling; private and empty-slug tags are absent.
	if len(got) != 3 || got[0].Slug != "phim-ngan" || got[0].Name != "phim ngắn" || got[0].VideoCount != 3 ||
		got[1].Slug != "dan-gian" || got[1].Name != "Dân gian" || got[2].Slug != "du-lich" {
		t.Fatalf("ranking: %+v", got)
	}
	if got[0].LatestPublishedAt.IsZero() {
		t.Fatalf("latest_published_at missing: %+v", got[0])
	}
	if got := decode[list](t, e.req(anon, "GET", "/v1/tags?min_videos=2", "")).Items; len(got) != 1 {
		t.Fatalf("min_videos: %+v", got)
	}
	if got := decode[list](t, e.req(anon, "GET", "/v1/tags?limit=2", "")).Items; len(got) != 2 {
		t.Fatalf("limit: %+v", got)
	}
	for _, q := range []string{"limit=0", "limit=1001", "limit=x", "min_videos=0"} {
		if w := e.req(anon, "GET", "/v1/tags?"+q, ""); w.Code != 400 || problemCode(t, w) != "VALIDATION_ERROR" {
			t.Errorf("%s: %d", q, w.Code)
		}
	}
	// An empty catalogue is an empty list, never null.
	if w := newEnv(t, false).req(anon, "GET", "/v1/tags", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"items":[]`) {
		t.Fatalf("empty: %d %s", w.Code, w.Body)
	}
}

func TestGetTag(t *testing.T) {
	e := newEnv(t, false)
	e.video(alice, withTags("Phim ngắn"))
	e.video(bob, withTags("Phim ngắn"))
	e.video(alice, withTags("Ẩm thực"), visibility(domain.VisPrivate))

	// Tag text resolves to the canonical slug (the web redirects to it).
	for _, in := range []string{"phim-ngan", url.PathEscape("Phim ngắn")} {
		w := e.req(anon, "GET", "/v1/tags/"+in, "")
		got := decode[tagJSON](t, w)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "public, max-age=60" || got.Slug != "phim-ngan" ||
			got.Name != "Phim ngắn" || got.VideoCount != 2 {
			t.Fatalf("%s: %d %+v", in, w.Code, got)
		}
	}
	for _, in := range []string{"khong-co", "am-thuc", "%21%21%21"} {
		if w := e.req(anon, "GET", "/v1/tags/"+in, ""); w.Code != 404 {
			t.Errorf("%s: %d", in, w.Code)
		}
	}
}

func TestVideoTagSlugs(t *testing.T) {
	e := newEnv(t, true)
	v := e.video(alice)
	path := "/v1/videos/" + v.ID.String()

	if w := e.req(anon, "GET", path, ""); !strings.Contains(w.Body.String(), `"tag_slugs":[]`) {
		t.Fatalf("no tags: %s", w.Body)
	}
	out := decode[videoJSON](t, e.req(alice, "PATCH", path, `{"tags":["Phim ngắn","!!!","Hà Nội"]}`))
	if strings.Join(out.TagSlugs, "|") != "phim-ngan||ha-noi" {
		t.Fatalf("aligned slugs: %q", out.TagSlugs)
	}
	out = decode[videoJSON](t, e.req(anon, "GET", path, ""))
	if len(out.TagSlugs) != 3 || out.TagSlugs[2] != "ha-noi" {
		t.Fatalf("get: %q", out.TagSlugs)
	}

	// A cache entry written before SEO2 has tags but no slugs: tag_slugs is padded, never misaligned.
	old := e.video(alice, withTags("a", "b"))
	old.TagSlugs = nil
	e.cache.Set(t.Context(), old)
	out = decode[videoJSON](t, e.req(anon, "GET", "/v1/videos/"+old.ID.String(), ""))
	if len(out.TagSlugs) != 2 || out.TagSlugs[0] != "" {
		t.Fatalf("old cache entry: %q", out.TagSlugs)
	}
}
