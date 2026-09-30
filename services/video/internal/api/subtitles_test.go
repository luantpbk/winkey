package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/vtt"
)

const goodVTT = "WEBVTT\n\n00:00.000 --> 00:01.000\nXin chào\n"

func putBody(label, content string) string {
	b, _ := json.Marshal(map[string]string{"label": label, "content": content})
	return string(b)
}

func subPath(v domain.Video, lang string) string {
	return "/v1/videos/" + v.ID.String() + "/subtitles/" + lang
}

func objectCount(e *env, v domain.Video) int {
	return len(e.objs.Keys("winkey-media", "v/"+v.ID.String()+"/subtitles/"))
}

type trackOut struct {
	Lang, Label, Source, URL string
	UpdatedAt                string `json:"updated_at"`
}

func TestPutSubtitleCreatesThenReplaces(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	keyRe := regexp.MustCompile(`^v/` + v.ID.String() + `/subtitles/vi-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\.vtt$`)

	// Create: 201, the object holds the NORMALISED file (no BOM, LF, trailing newline), served as text/vtt.
	w := e.req(alice, "PUT", subPath(v, "vi"), putBody("  Tiếng Việt ", "\ufeffWEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nXin chào"))
	if w.Code != http.StatusCreated {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	first := decode[trackOut](t, w)
	if first.Lang != "vi" || first.Label != "Tiếng Việt" || first.Source != "UPLOAD" || first.UpdatedAt == "" ||
		!strings.HasPrefix(first.URL, mediaBase+"/v/"+v.ID.String()+"/subtitles/vi-") || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("track: %+v %v", first, w.Header())
	}
	keys := e.objs.Keys("winkey-media", "v/"+v.ID.String()+"/subtitles/")
	if len(keys) != 1 || !keyRe.MatchString(keys[0]) {
		t.Fatalf("keys %v", keys)
	}
	obj, _ := e.objs.Get("winkey-media", keys[0])
	if string(obj.Data) != "WEBVTT\n\n00:00.000 --> 00:01.000\nXin chào\n" || obj.ContentType != "text/vtt; charset=utf-8" ||
		obj.CacheControl != "public, max-age=31536000, immutable" {
		t.Fatalf("object: %q %q %q", obj.Data, obj.ContentType, obj.CacheControl)
	}
	if first.URL != mediaBase+"/"+keys[0] {
		t.Fatalf("url %s vs key %s", first.URL, keys[0])
	}

	// Replace: 200, a NEW key, the old object is gone, the label follows.
	w = e.req(alice, "PUT", subPath(v, "vi"), putBody("Vietnamese", "WEBVTT\n\n00:00.000 --> 00:02.000\nMới\n"))
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	second := decode[trackOut](t, w)
	now := e.objs.Keys("winkey-media", "v/"+v.ID.String()+"/subtitles/")
	if second.Label != "Vietnamese" || len(now) != 1 || now[0] == keys[0] || second.URL == first.URL || !keyRe.MatchString(now[0]) {
		t.Fatalf("after replace: %+v keys %v (was %v)", second, now, keys)
	}
	if _, still := e.objs.Get("winkey-media", keys[0]); still {
		t.Fatal("the replaced object must be deleted")
	}
	if got := decode[videoJSON](t, e.req(anon, "GET", "/v1/videos/"+v.ID.String(), "")).Playback.Subtitles; len(got) != 1 || got[0].Label != "Vietnamese" {
		t.Fatalf("playback: %+v", got)
	}
}

func TestPutSubtitleAuthorisation(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	private := e.video(alice, visibility(domain.VisPrivate))
	failed := e.video(alice, notReady(domain.StatusFailed))
	processing := e.video(alice, notReady(domain.StatusProcessing))

	for _, c := range []struct {
		name string
		who  *who
		v    domain.Video
		id   string
		want int
		code string
	}{
		{"other user", bob, v, "", 403, ""},
		{"moderator", mod, v, "", 403, ""},
		{"admin", admin, v, "", 403, ""},
		{"anonymous", anon, v, "", 401, ""},
		{"invisible video", bob, private, "", 404, ""},
		{"unknown video", alice, v, ids.NewString(), 404, ""},
		{"malformed id", alice, v, "not-a-uuid", 404, ""},
		{"FAILED video", alice, failed, "", 409, "VIDEO_FAILED"},
	} {
		path := subPath(c.v, "vi")
		if c.id != "" {
			path = "/v1/videos/" + c.id + "/subtitles/vi"
		}
		w := e.req(c.who, "PUT", path, putBody("Tiếng Việt", goodVTT))
		if w.Code != c.want || (c.code != "" && problemCode(t, w) != c.code) {
			t.Errorf("%s: %d %s", c.name, w.Code, w.Body)
		}
	}
	if len(e.objs.Puts) != 0 {
		t.Fatalf("a refused request uploaded %v", e.objs.Puts)
	}
	// A track can be prepared while the video is still processing (and on a PRIVATE one by its owner).
	for _, x := range []domain.Video{processing, private} {
		if w := e.req(alice, "PUT", subPath(x, "en"), putBody("English", goodVTT)); w.Code != http.StatusCreated {
			t.Errorf("owner on %s video: %d %s", x.Status, w.Code, w.Body)
		}
	}
}

func TestPutSubtitleValidation(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	bigBody := putBody("Big", "WEBVTT\n\n00:00.000 --> 00:01.000\n"+strings.Repeat("a", vtt.MaxBytes)+"\n")
	hugeBody := `{"label":"Big","content":"` + strings.Repeat("a", maxSubtitleBody) + `"}`
	for _, c := range []struct {
		name, lang, body, code string
		detail                 string // a fragment of `detail`
	}{
		{"invalid lang: upper case", "VI", putBody("x", goodVTT), "VALIDATION_ERROR", ""},
		{"invalid lang: word", "english", putBody("x", goodVTT), "VALIDATION_ERROR", ""},
		{"invalid lang: lower-case region", "en-us", putBody("x", goodVTT), "VALIDATION_ERROR", ""},
		{"invalid lang: one letter", "e", putBody("x", goodVTT), "VALIDATION_ERROR", ""},
		{"label missing", "vi", `{"content":"WEBVTT\n\n00:00.000 --> 00:01.000\nx\n"}`, "VALIDATION_ERROR", ""},
		{"label blank", "vi", putBody("   ", goodVTT), "VALIDATION_ERROR", ""},
		{"label too long", "vi", putBody(strings.Repeat("ế", 51), goodVTT), "VALIDATION_ERROR", ""},
		{"content missing", "vi", `{"label":"x"}`, "VALIDATION_ERROR", ""},
		{"unknown field", "vi", `{"label":"x","content":"` + strings.ReplaceAll(goodVTT, "\n", `\n`) + `","source":"AUTO"}`, "INVALID_JSON", ""},
		{"not JSON", "vi", `WEBVTT`, "INVALID_JSON", ""},
		{"no header", "vi", putBody("x", "00:00.000 --> 00:01.000\nx\n"), "INVALID_WEBVTT", "line 1:"},
		{"no cue", "vi", putBody("x", "WEBVTT\n\nNOTE only\n"), "INVALID_WEBVTT", "no cue"},
		{"end before start", "vi", putBody("x", "WEBVTT\n\n00:00.000 --> 00:01.000\nA\n\n00:03.000 --> 00:02.000\nB\n"), "INVALID_WEBVTT", "line 6: the cue must end after it starts"},
		{"NUL", "vi", putBody("x", "WEBVTT\n\n00:00.000 --> 00:01.000\nH\x00i\n"), "INVALID_WEBVTT", "line 4: the file contains a NUL"},
		{"too large", "vi", bigBody, "SUBTITLE_TOO_LARGE", "above the limit"},
		{"body far too large", "vi", hugeBody, "SUBTITLE_TOO_LARGE", ""},
	} {
		w := e.req(alice, "PUT", subPath(v, c.lang), c.body)
		if w.Code != 400 || problemCode(t, w) != c.code {
			t.Errorf("%s: %d %s", c.name, w.Code, truncate(w.Body.String()))
			continue
		}
		if c.detail != "" {
			if d := decode[struct {
				Detail string `json:"detail"`
			}](t, w).Detail; !strings.Contains(d, c.detail) {
				t.Errorf("%s: detail %q, want %q", c.name, d, c.detail)
			}
		}
	}
	if len(e.objs.Puts) != 0 || e.store.subtitleWrites != 0 {
		t.Fatalf("an invalid request reached storage: puts=%v writes=%d", e.objs.Puts, e.store.subtitleWrites)
	}
}

func truncate(s string) string {
	if len(s) > 200 {
		return s[:200] + "..."
	}
	return s
}

func TestPutSubtitleLimitOfTwentyLanguages(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	langs := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		langs = append(langs, fmt.Sprintf("a%c", 'a'+i))
	}
	for _, l := range langs {
		if w := e.req(alice, "PUT", subPath(v, l), putBody(l, goodVTT)); w.Code != http.StatusCreated {
			t.Fatalf("%s: %d %s", l, w.Code, w.Body)
		}
	}
	// The 21st language is refused and the object that was uploaded for it is removed again.
	w := e.req(alice, "PUT", subPath(v, "vi"), putBody("Tiếng Việt", goodVTT))
	if w.Code != http.StatusConflict || problemCode(t, w) != "TOO_MANY_SUBTITLES" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if n := objectCount(e, v); n != 20 || len(e.objs.Deletes) != 1 {
		t.Fatalf("%d objects, deletes %v", n, e.objs.Deletes)
	}
	// Replacing one of the 20 is always allowed.
	if w := e.req(alice, "PUT", subPath(v, langs[7]), putBody("again", goodVTT)); w.Code != http.StatusOK {
		t.Fatalf("replace at the limit: %d %s", w.Code, w.Body)
	}
	if n := objectCount(e, v); n != 20 {
		t.Fatalf("%d objects", n)
	}
	// After a delete a new language fits again.
	if w := e.req(alice, "DELETE", subPath(v, langs[0]), ""); w.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", w.Code)
	}
	if w := e.req(alice, "PUT", subPath(v, "vi"), putBody("Tiếng Việt", goodVTT)); w.Code != http.StatusCreated {
		t.Fatalf("after a delete: %d", w.Code)
	}
}

func TestPutSubtitleCleansUpWhenTheTransactionFails(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	e.store.putSubtitleErr = fmt.Errorf("database is on fire")
	rec := e.reqNoContract(alice, "PUT", subPath(v, "vi"), putBody("x", goodVTT)) // a 500 is not in the contract
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if n := objectCount(e, v); n != 0 || len(e.objs.Puts) != 1 || len(e.objs.Deletes) != 1 || e.objs.Puts[0] != e.objs.Deletes[0] {
		t.Fatalf("orphan: %d objects, puts %v deletes %v", n, e.objs.Puts, e.objs.Deletes)
	}
}

func TestPutSubtitleUploadFailureWritesNoRow(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	e.objs.PutErr = fmt.Errorf("garage unreachable")
	if rec := e.reqNoContract(alice, "PUT", subPath(v, "vi"), putBody("x", goodVTT)); rec.Code != http.StatusInternalServerError {
		t.Fatalf("%d", rec.Code)
	}
	if e.store.subtitleWrites != 0 {
		t.Fatal("a row was written for an object that does not exist")
	}
}

// A failing delete of the previous object is a warning, never an error for the caller.
func TestPutSubtitleSurvivesAFailingCleanup(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	e.req(alice, "PUT", subPath(v, "vi"), putBody("one", goodVTT))
	e.objs.DeleteErr = fmt.Errorf("garage unreachable")
	w := e.req(alice, "PUT", subPath(v, "vi"), putBody("two", goodVTT))
	if w.Code != http.StatusOK || decode[trackOut](t, w).Label != "two" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := e.req(alice, "DELETE", subPath(v, "vi"), ""); w.Code != http.StatusNoContent {
		t.Fatalf("delete with a failing cleanup: %d", w.Code)
	}
}

func TestDeleteSubtitle(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	private := e.video(alice, visibility(domain.VisPrivate))
	e.req(alice, "PUT", subPath(v, "vi"), putBody("Tiếng Việt", goodVTT))
	e.req(alice, "PUT", subPath(v, "en"), putBody("English", goodVTT))

	for name, c := range map[string]struct {
		who  *who
		path string
		want int
	}{
		"other user":  {bob, subPath(v, "vi"), 403},
		"moderator":   {mod, subPath(v, "vi"), 403},
		"admin":       {admin, subPath(v, "vi"), 403},
		"anonymous":   {anon, subPath(v, "vi"), 401},
		"invisible":   {bob, subPath(private, "vi"), 404},
		"unknown":     {alice, "/v1/videos/" + ids.NewString() + "/subtitles/vi", 404},
		"no track":    {alice, subPath(v, "fr"), 404},
		"invalid tag": {alice, subPath(v, "VI"), 404},
	} {
		if w := e.req(c.who, "DELETE", c.path, ""); w.Code != c.want {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	if objectCount(e, v) != 2 {
		t.Fatal("a refused delete removed something")
	}

	if w := e.req(alice, "DELETE", subPath(v, "vi"), ""); w.Code != http.StatusNoContent || w.Body.Len() != 0 {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	if w := e.req(alice, "DELETE", subPath(v, "vi"), ""); w.Code != http.StatusNotFound {
		t.Fatalf("second delete: %d", w.Code)
	}
	if n := objectCount(e, v); n != 1 {
		t.Fatalf("%d objects left, want 1", n)
	}
	if got := decode[videoJSON](t, e.req(anon, "GET", "/v1/videos/"+v.ID.String(), "")).Playback.Subtitles; len(got) != 1 || got[0].Lang != "en" {
		t.Fatalf("playback: %+v", got)
	}
}

// Playback.subtitles: always there, sorted by lang, plain for a publicly watchable video and signed (same
// expiry as hls_url) for any other; on every response that carries playback.
func TestPlaybackSubtitles(t *testing.T) {
	e := newEnv(t, false)
	pub := e.video(alice)
	private := e.video(alice, visibility(domain.VisPrivate))
	none := e.video(alice)
	for _, v := range []domain.Video{pub, private} {
		for _, l := range []string{"vi", "en-US", "en", "fr"} { // out of order on purpose
			if w := e.req(alice, "PUT", subPath(v, l), putBody("label "+l, goodVTT)); w.Code != http.StatusCreated {
				t.Fatalf("%s: %d %s", l, w.Code, w.Body)
			}
		}
	}
	order := func(tr []subtitleJSON) string {
		var l []string
		for _, s := range tr {
			l = append(l, s.Lang)
		}
		return strings.Join(l, ",")
	}

	out := decode[videoJSON](t, e.req(anon, "GET", "/v1/videos/"+pub.ID.String(), ""))
	if order(out.Playback.Subtitles) != "en,en-US,fr,vi" {
		t.Fatalf("order %s", order(out.Playback.Subtitles))
	}
	for _, s := range out.Playback.Subtitles {
		if !strings.HasPrefix(s.URL, mediaBase+"/v/"+pub.ID.String()+"/subtitles/"+s.Lang+"-") || s.Source != "UPLOAD" || s.Label != "label "+s.Lang {
			t.Errorf("public track %+v", s)
		}
	}
	if out.Playback.ExpiresAt != nil {
		t.Error("expires_at on a public video")
	}

	signed := decode[videoJSON](t, e.req(alice, "GET", "/v1/videos/"+private.ID.String(), ""))
	if order(signed.Playback.Subtitles) != "en,en-US,fr,vi" || signed.Playback.ExpiresAt == nil {
		t.Fatalf("private: %+v", signed.Playback)
	}
	for _, s := range signed.Playback.Subtitles {
		var key string
		for _, st := range e.store.videos[private.ID].Subtitles {
			if st.Lang == s.Lang {
				key = st.ObjectKey
			}
		}
		if want := signMediaURL(mediaBase, []byte(testLinkSecret), private.ID, key, signed.Playback.ExpiresAt.Unix()); s.URL != want {
			t.Errorf("%s: %s, want %s", s.Lang, s.URL, want)
		}
	}

	// No tracks: present and empty, never null or absent.
	w := e.req(anon, "GET", "/v1/videos/"+none.ID.String(), "")
	if !strings.Contains(w.Body.String(), `"subtitles":[]`) {
		t.Fatalf("empty subtitles: %s", w.Body)
	}

	// The other responses that carry playback.
	if w := e.req(alice, "PATCH", "/v1/videos/"+pub.ID.String(), `{"title":"New"}`); !strings.Contains(w.Body.String(), `"subtitles":[{"lang":"en"`) {
		t.Errorf("updateVideo: %s", w.Body)
	}
	if w := e.req(mod, "PUT", "/v1/videos/"+pub.ID.String()+"/moderation", `{"state":"HIDDEN","reason":"spam"}`); !strings.Contains(w.Body.String(), `"subtitles":[{"lang":"en"`) {
		t.Errorf("moderateVideo: %s", w.Body)
	}
}

// The cached watch page never shows a stale track list to this replica.
func TestSubtitleChangesInvalidateTheCache(t *testing.T) {
	e := newEnv(t, true)
	v := e.video(alice)
	get := func() []subtitleJSON {
		return decode[videoJSON](t, e.req(anon, "GET", "/v1/videos/"+v.ID.String(), "")).Playback.Subtitles
	}
	if len(get()) != 0 || len(get()) != 0 || e.cache.hits == 0 {
		t.Fatalf("the page should be cached: hits %d", e.cache.hits)
	}
	e.req(alice, "PUT", subPath(v, "vi"), putBody("Tiếng Việt", goodVTT))
	if len(get()) != 1 {
		t.Fatal("a new track is not visible")
	}
	e.req(alice, "DELETE", subPath(v, "vi"), "")
	if len(get()) != 0 {
		t.Fatal("a deleted track is still visible")
	}
}
