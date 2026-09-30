package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Golden: fixed secret, time and video id. The expected signature was computed
// independently (python: urlsafe_b64encode(md5("1790877600/v/<id>/ <secret>")) without
// padding), i.e. what nginx checks with secure_link_md5 "$secure_link_expires/v/$vid/ $media_link_secret".
func TestSignMediaURLGolden(t *testing.T) {
	id := uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d")
	exp := testNow.Add(mediaLinkTTL).Unix()
	if exp != 1790877600 {
		t.Fatalf("expiry %d", exp)
	}
	key := "v/" + id.String() + "/a1/hls/master.m3u8"
	want := "https://media.winkey.vn/s/1790877600/adq0Q-HN9fEZYFa8iHGwaQ/" + key
	for _, base := range []string{"https://media.winkey.vn", "https://media.winkey.vn/"} {
		if got := signMediaURL(base, []byte(testLinkSecret), id, "/"+key, exp); got != want {
			t.Fatalf("got  %s\nwant %s", got, want)
		}
	}
	// Any change of secret, id or expiry changes the signature.
	for name, got := range map[string]string{
		"secret": signMediaURL(mediaBase, []byte(testLinkSecret+"x"), id, key, exp),
		"id":     signMediaURL(mediaBase, []byte(testLinkSecret), ids.New(), key, exp),
		"expiry": signMediaURL(mediaBase, []byte(testLinkSecret), id, key, exp+1),
	} {
		if strings.Contains(got, "adq0Q-HN9fEZYFa8iHGwaQ") {
			t.Errorf("%s did not change the signature: %s", name, got)
		}
	}
}

func urlHasSig(u string) bool { return strings.Contains(u, "/s/") }

// Signed URLs and playback.expires_at exactly when the video is not publicly watchable.
func TestPlaybackIsSignedOnlyForVideosThePublicCannotWatch(t *testing.T) {
	e := newEnv(t, false)
	pub := e.video(alice)
	unlisted := e.video(alice, visibility(domain.VisUnlisted))
	private := e.video(alice, visibility(domain.VisPrivate))
	hidden := e.video(alice, func(v *domain.Video) { v.ModerationState = domain.ModHidden })
	ghost := e.video(alice, func(v *domain.Video) { v.Owner.Missing = true })

	wantExp := testNow.Add(mediaLinkTTL)
	for _, c := range []struct {
		name   string
		v      domain.Video
		viewer *who
		signed bool
	}{
		{"PUBLIC / anonymous", pub, anon, false},
		{"PUBLIC / owner", pub, alice, false},
		{"PUBLIC / moderator", pub, mod, false},
		{"UNLISTED / anonymous", unlisted, anon, false},
		{"UNLISTED / owner", unlisted, alice, false},
		{"PRIVATE / owner", private, alice, true},
		{"PRIVATE / moderator", private, mod, true},
		{"PRIVATE / admin", private, admin, true},
		{"HIDDEN / owner", hidden, alice, true},
		{"HIDDEN / moderator", hidden, mod, true},
		{"owner not ACTIVE / moderator", ghost, mod, true},
		{"owner not ACTIVE / admin", ghost, admin, true},
	} {
		w := e.req(c.viewer, "GET", "/v1/videos/"+c.v.ID.String(), "")
		if w.Code != 200 {
			t.Errorf("%s: %d", c.name, w.Code)
			continue
		}
		pb := decode[videoJSON](t, w).Playback
		if pb == nil {
			t.Errorf("%s: no playback", c.name)
			continue
		}
		if urlHasSig(pb.HLSURL) != c.signed || urlHasSig(pb.ThumbnailURL) != c.signed || (pb.ExpiresAt != nil) != c.signed {
			t.Errorf("%s: signed=%v want %v: %+v", c.name, urlHasSig(pb.HLSURL), c.signed, pb)
			continue
		}
		if !c.signed {
			if pb.HLSURL != mediaBase+"/"+*c.v.HLSMasterKey || pb.ThumbnailURL != mediaBase+"/"+*c.v.ThumbnailKey {
				t.Errorf("%s: plain URLs changed: %+v", c.name, pb)
			}
			if strings.Contains(w.Body.String(), "expires_at") {
				t.Errorf("%s: expires_at must be absent", c.name)
			}
			continue
		}
		if !pb.ExpiresAt.Equal(wantExp) {
			t.Errorf("%s: expires_at %v, want %v", c.name, pb.ExpiresAt, wantExp)
		}
		wantHLS := signMediaURL(mediaBase, []byte(testLinkSecret), c.v.ID, *c.v.HLSMasterKey, wantExp.Unix())
		wantThumb := signMediaURL(mediaBase, []byte(testLinkSecret), c.v.ID, *c.v.ThumbnailKey, wantExp.Unix())
		if pb.HLSURL != wantHLS || pb.ThumbnailURL != wantThumb {
			t.Errorf("%s: %s / %s", c.name, pb.HLSURL, pb.ThumbnailURL)
		}
		if !strings.HasPrefix(pb.HLSURL, mediaBase+"/s/1790877600/") || !strings.HasSuffix(pb.HLSURL, "/"+*c.v.HLSMasterKey) {
			t.Errorf("%s: shape %s", c.name, pb.HLSURL)
		}
		if cc := w.Header().Get("Cache-Control"); cc != "private, no-store" {
			t.Errorf("%s: signed URLs must not be cached publicly: %q", c.name, cc)
		}
	}
	// Not READY: no playback at all, so nothing to sign.
	proc := e.video(alice, notReady(domain.StatusProcessing))
	if out := decode[videoJSON](t, e.req(alice, "GET", "/v1/videos/"+proc.ID.String(), "")); out.Playback != nil {
		t.Fatalf("%+v", out.Playback)
	}
}

func TestPatchResponseFollowsTheNewVisibility(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	w := e.req(alice, "PATCH", "/v1/videos/"+v.ID.String(), `{"visibility":"PRIVATE"}`)
	if out := decode[videoJSON](t, w); w.Code != 200 || out.Playback == nil || !urlHasSig(out.Playback.HLSURL) || out.Playback.ExpiresAt == nil {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	w = e.req(alice, "PATCH", "/v1/videos/"+v.ID.String(), `{"visibility":"PUBLIC"}`)
	if out := decode[videoJSON](t, w); w.Code != 200 || out.Playback == nil || urlHasSig(out.Playback.HLSURL) || out.Playback.ExpiresAt != nil {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

type thumbPage struct {
	Items []struct {
		ID           string  `json:"id"`
		ThumbnailURL *string `json:"thumbnail_url"`
	} `json:"items"`
}

func TestStudioThumbnailsAreSignedWhenNotPubliclyWatchable(t *testing.T) {
	e := newEnv(t, false)
	pub := e.video(alice)
	unlisted := e.video(alice, visibility(domain.VisUnlisted))
	private := e.video(alice, visibility(domain.VisPrivate))
	hidden := e.video(alice, func(v *domain.Video) { v.ModerationState = domain.ModHidden })
	e.video(alice, notReady(domain.StatusProcessing))

	page := decode[thumbPage](t, e.req(alice, "GET", "/v1/studio/videos?limit=100", ""))
	want := map[string]bool{pub.ID.String(): false, unlisted.ID.String(): false, private.ID.String(): true, hidden.ID.String(): true}
	seen := 0
	for _, it := range page.Items {
		signed, ok := want[it.ID]
		if !ok {
			if it.ThumbnailURL != nil {
				t.Errorf("not READY video has a thumbnail: %s", *it.ThumbnailURL)
			}
			continue
		}
		seen++
		if it.ThumbnailURL == nil || urlHasSig(*it.ThumbnailURL) != signed {
			t.Errorf("%s: want signed=%v, got %v", it.ID, signed, it.ThumbnailURL)
		}
	}
	if seen != 4 {
		t.Fatalf("saw %d of 4 videos", seen)
	}
	// Feed lists public videos only: plain URLs.
	for _, it := range decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos", "")).Items {
		if urlHasSig(it.ThumbnailURL) {
			t.Errorf("feed thumbnail signed: %s", it.ThumbnailURL)
		}
	}
}

func (e *env) access(path string, headers map[string]string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	e.spec.Check(e.t, "GET", "/internal/media-access/{video_id}", w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w
}

func TestMediaAccess(t *testing.T) {
	e := newEnv(t, false)
	for _, c := range []struct {
		name  string
		v     domain.Video
		allow bool
	}{
		{"PUBLIC READY", e.video(alice), true},
		{"UNLISTED READY", e.video(alice, visibility(domain.VisUnlisted)), true},
		{"PRIVATE READY", e.video(alice, visibility(domain.VisPrivate)), false},
		{"HIDDEN READY", e.video(alice, func(v *domain.Video) { v.ModerationState = domain.ModHidden }), false},
		{"PROCESSING", e.video(alice, notReady(domain.StatusProcessing)), false},
		{"owner not ACTIVE", e.video(alice, func(v *domain.Video) { v.Owner.Missing = true }), false},
	} {
		// The answer never depends on identity headers: they are not read at all.
		for _, hdr := range []map[string]string{nil, {"X-User-Id": alice.id.String(), "X-User-Roles": "admin"}, {"X-User-Id": "garbage"}} {
			w := e.access("/internal/media-access/"+c.v.ID.String(), hdr)
			want := http.StatusForbidden
			if c.allow {
				want = http.StatusNoContent
			}
			if w.Code != want || w.Body.Len() != 0 || w.Header().Get("Cache-Control") != "max-age=30" {
				t.Errorf("%s: %d body=%q cc=%q", c.name, w.Code, w.Body, w.Header().Get("Cache-Control"))
			}
		}
	}
	// Unknown ids are 403, never 404.
	if w := e.access("/internal/media-access/"+ids.NewString(), nil); w.Code != 403 || w.Header().Get("Cache-Control") != "max-age=30" {
		t.Errorf("unknown id: %d %q", w.Code, w.Header().Get("Cache-Control"))
	}
	// Malformed ids are 400 and never reach the store.
	before := e.store.mediaChecks
	id := ids.NewString()
	for _, bad := range []string{"not-a-uuid", "123", strings.ReplaceAll(id, "-", ""), "urn:uuid:" + id, "{" + id + "}", id + "0", "x" + id[1:]} {
		w := e.access("/internal/media-access/"+bad, nil)
		if w.Code != 400 || problemCode(t, w) != "VALIDATION_ERROR" {
			t.Errorf("%q: %d %s", bad, w.Code, w.Body)
		}
	}
	if e.store.mediaChecks != before {
		t.Errorf("malformed ids reached the store")
	}
	// GET only.
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, httptest.NewRequest("POST", "/internal/media-access/"+id, nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", w.Code)
	}
}

func withStoryboard(v *domain.Video) {
	key := "v/" + v.ID.String() + "/a1/storyboard/storyboard.vtt"
	v.StoryboardKey = &key
}

// V5a: playback.storyboard_url follows the same rule as hls_url (plain for publicly watchable
// videos, signed with the same expiry otherwise) and is null, not absent, when there is none.
func TestPlaybackStoryboardURL(t *testing.T) {
	e := newEnv(t, false)
	pub := e.video(alice, withStoryboard)
	private := e.video(alice, visibility(domain.VisPrivate), withStoryboard)
	hidden := e.video(alice, withStoryboard, func(v *domain.Video) { v.ModerationState = domain.ModHidden })
	none := e.video(alice)
	noneSigned := e.video(alice, visibility(domain.VisPrivate))
	exp := testNow.Add(mediaLinkTTL)

	body := func(u *who, v domain.Video) (videoJSON, string) {
		w := e.req(u, "GET", "/v1/videos/"+v.ID.String(), "")
		if w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		return decode[videoJSON](t, w), w.Body.String()
	}

	if out, _ := body(anon, pub); out.Playback.StoryboardURL == nil || *out.Playback.StoryboardURL != mediaBase+"/"+*pub.StoryboardKey {
		t.Fatalf("public: %v", out.Playback.StoryboardURL)
	}
	for name, c := range map[string]struct {
		u *who
		v domain.Video
	}{"private / owner": {alice, private}, "private / moderator": {mod, private}, "hidden / owner": {alice, hidden}} {
		out, _ := body(c.u, c.v)
		want := signMediaURL(mediaBase, []byte(testLinkSecret), c.v.ID, *c.v.StoryboardKey, exp.Unix())
		if out.Playback.StoryboardURL == nil || *out.Playback.StoryboardURL != want {
			t.Errorf("%s: %v, want %s", name, out.Playback.StoryboardURL, want)
		}
		if out.Playback.ExpiresAt == nil || !out.Playback.ExpiresAt.Equal(exp) ||
			!strings.HasPrefix(*out.Playback.StoryboardURL, mediaBase+"/s/1790877600/") { // same expiry as hls_url
			t.Errorf("%s: expiry %v %s", name, out.Playback.ExpiresAt, *out.Playback.StoryboardURL)
		}
	}
	// The sheets are named relative to the track, so they live under the same signed prefix.
	out, _ := body(alice, private)
	dir := (*out.Playback.StoryboardURL)[:strings.LastIndex(*out.Playback.StoryboardURL, "/")+1]
	if !strings.HasPrefix(dir, mediaBase+"/s/") || !strings.HasSuffix(dir, "/v/"+private.ID.String()+"/a1/storyboard/") {
		t.Errorf("sheet directory %s", dir)
	}

	for name, c := range map[string]struct {
		u *who
		v domain.Video
	}{"public without storyboard": {anon, none}, "private without storyboard": {alice, noneSigned}} {
		out, raw := body(c.u, c.v)
		if out.Playback.StoryboardURL != nil || !strings.Contains(raw, `"storyboard_url":null`) {
			t.Errorf("%s: %v in %s", name, out.Playback.StoryboardURL, raw)
		}
	}
}
