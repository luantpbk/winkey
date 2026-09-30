package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

const mediaBase = "https://media.winkey.vn"

// Fixed for the golden and signed-URL tests (SEC1).
const testLinkSecret = "test-media-link-secret-0123456789abcdef"

var testNow = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

var spec *contract.Spec

type who struct {
	id    uuid.UUID
	roles string
}

var (
	alice = &who{ids.New(), "viewer,creator"}
	bob   = &who{ids.New(), "viewer,creator"}
	mod   = &who{ids.New(), "viewer,moderator"}
	admin = &who{ids.New(), "admin"}
	anon  *who
)

type env struct {
	t     *testing.T
	h     http.Handler
	store *memStore
	objs  *testutil.MemObjects
	cache *memCache
	spec  *contract.Spec
	n     int
}

func newEnv(t *testing.T, withCache bool) *env {
	t.Helper()
	e := &env{t: t, store: newMemStore(), objs: testutil.NewMemObjects(), spec: contract.Load(t)}
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	h := &Handler{Store: e.store, Objects: e.objs, MediaBaseURL: mediaBase + "/", MediaBucket: "winkey-media",
		CursorSecret: []byte("test-cursor-secret-123456"), Log: log,
		MediaLinkSecret: []byte(testLinkSecret), Now: func() time.Time { return testNow }}
	if withCache {
		e.cache = newMemCache()
		h.Cache = e.cache
	}
	r := httpx.NewRouter("video-test", log)
	h.Routes(r)
	e.h = r
	return e
}

var videoPath = regexp.MustCompile(`^/v1/videos/[^/]+$`)
var moderationPath = regexp.MustCompile(`^/v1/videos/[^/]+/moderation$`)
var subtitlePath = regexp.MustCompile(`^/v1/videos/[^/]+/subtitles/[^/]+$`)

func templateFor(path string) string {
	p, _, _ := strings.Cut(path, "?")
	if videoPath.MatchString(p) {
		return "/v1/videos/{video_id}"
	}
	if subtitlePath.MatchString(p) {
		return "/v1/videos/{video_id}/subtitles/{lang}"
	}
	if moderationPath.MatchString(p) {
		return "/v1/videos/{video_id}/moderation"
	}
	return p
}

// req performs a request and validates the response against the contract.
func (e *env) req(u *who, method, path, body string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if u != nil {
		req.Header.Set("X-User-Id", u.id.String())
		req.Header.Set("X-User-Roles", u.roles)
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	e.spec.Check(e.t, method, templateFor(path), w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w
}

// reqNoContract is req without the contract check, for the answers the contract does not document (500).
func (e *env) reqNoContract(u *who, method, path, body string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if u != nil {
		req.Header.Set("X-User-Id", u.id.String())
		req.Header.Set("X-User-Roles", u.roles)
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	return w
}

func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("bad json: %v: %s", err, w.Body)
	}
	return v
}

func problemCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); ct != httpx.ProblemContentType {
		t.Fatalf("content-type %q: %s", ct, w.Body)
	}
	return decode[httpx.Problem](t, w).Code
}

// video inserts a video owned by owner (READY, PUBLIC, 3 renditions by default).
func (e *env) video(owner *who, mods ...func(*domain.Video)) domain.Video {
	e.n++
	id := ids.New()
	dur, w, h := 12345, 1920, 1080
	pub := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC).Add(time.Duration(e.n) * time.Minute)
	master, thumb := fmt.Sprintf("v/%s/a1/hls/master.m3u8", id), fmt.Sprintf("v/%s/a1/thumb/poster.jpg", id)
	avatar := "avatars/alice.jpg"
	v := domain.Video{
		ID: id, OwnerID: owner.id, Title: fmt.Sprintf("Video %d", e.n), Description: "desc",
		Visibility: domain.VisPublic, Status: domain.StatusReady,
		DurationMs: &dur, Width: &w, Height: &h, ViewCount: 42, LikeCount: 7,
		PublishedAt: &pub, CreatedAt: pub.Add(-time.Hour), HLSMasterKey: &master, ThumbnailKey: &thumb,
		Owner: domain.Profile{ID: owner.id, Handle: "alice", DisplayName: "Alice", AvatarKey: &avatar},
		Renditions: []domain.Rendition{{Name: "1080p", Width: 1920, Height: 1080, BitrateKbps: 5000},
			{Name: "720p", Width: 1280, Height: 720, BitrateKbps: 2800}, {Name: "480p", Width: 854, Height: 480, BitrateKbps: 1400}},
	}
	for _, m := range mods {
		m(&v)
	}
	e.store.raw[id] = [2]string{"winkey-raw", owner.id.String() + "/" + id.String() + "/source"}
	return e.store.put(v)
}

func notReady(status string) func(*domain.Video) {
	return func(v *domain.Video) {
		v.Status = status
		v.DurationMs, v.Width, v.Height, v.PublishedAt, v.HLSMasterKey, v.ThumbnailKey = nil, nil, nil, nil, nil, nil
		v.Renditions = nil
	}
}

func visibility(vis string) func(*domain.Video) { return func(v *domain.Video) { v.Visibility = vis } }

// --- GET /v1/videos/{id} -------------------------------------------------------

func TestGetPublicReadyVideo(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)

	for _, viewer := range []*who{anon, bob, alice} {
		w := e.req(viewer, "GET", "/v1/videos/"+v.ID.String(), "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "public, max-age=30" {
			t.Fatalf("%v: %d cache=%q", viewer, w.Code, w.Header().Get("Cache-Control"))
		}
	}
	out := decode[videoJSON](t, e.req(anon, "GET", "/v1/videos/"+v.ID.String(), ""))
	if out.Playback == nil || out.Playback.HLSURL != mediaBase+"/"+*v.HLSMasterKey ||
		out.Playback.ThumbnailURL != mediaBase+"/"+*v.ThumbnailKey || len(out.Playback.Renditions) != 3 ||
		out.Playback.Renditions[0].Name != "1080p" {
		t.Fatalf("playback: %+v", out.Playback)
	}
	if out.Owner.Handle != "alice" || out.Owner.AvatarURL == nil || *out.Owner.AvatarURL != mediaBase+"/avatars/alice.jpg" ||
		out.Owner.ID != alice.id.String() {
		t.Fatalf("owner: %+v", out.Owner)
	}
	if out.Status != "READY" || out.ViewCount != 42 || out.LikeCount != 7 || *out.DurationMs != 12345 || out.PublishedAt == nil {
		t.Fatalf("video: %+v", out)
	}
}

func TestOwnerWithoutAvatarHasNullAvatarURL(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice, func(v *domain.Video) { v.Owner.AvatarKey = nil })
	out := decode[videoJSON](t, e.req(anon, "GET", "/v1/videos/"+v.ID.String(), ""))
	if out.Owner.AvatarURL != nil {
		t.Fatalf("avatar_url %v", *out.Owner.AvatarURL)
	}
}

// The full visibility matrix of video.v1.yaml for GET by id.
func TestVisibilityMatrix(t *testing.T) {
	e := newEnv(t, false)
	type tc struct {
		name string
		v    domain.Video
		want map[*who]int // expected status per viewer
		cc   string       // Cache-Control when 200
	}
	pubReady := e.video(alice)
	unlisted := e.video(alice, visibility(domain.VisUnlisted))
	private := e.video(alice, visibility(domain.VisPrivate))
	processing := e.video(alice, notReady(domain.StatusProcessing))
	failed := e.video(alice, notReady(domain.StatusFailed))
	uploading := e.video(alice, notReady(domain.StatusUploading), visibility(domain.VisPrivate))
	suspendedOwner := e.video(alice, func(v *domain.Video) { v.Owner.Missing = true })

	all := func(anonC, bobC, aliceC, modC, adminC int) map[*who]int {
		return map[*who]int{anon: anonC, bob: bobC, alice: aliceC, mod: modC, admin: adminC}
	}
	cases := []tc{
		{"PUBLIC READY", pubReady, all(200, 200, 200, 200, 200), "public, max-age=30"},
		{"UNLISTED READY readable by id", unlisted, all(200, 200, 200, 200, 200), "private, no-store"},
		{"PRIVATE READY", private, all(404, 404, 200, 200, 200), "private, no-store"},
		{"PROCESSING", processing, all(404, 404, 200, 200, 200), "private, no-store"},
		{"FAILED", failed, all(404, 404, 200, 200, 200), "private, no-store"},
		{"UPLOADING", uploading, all(404, 404, 200, 200, 200), "private, no-store"},
		{"owner no longer ACTIVE", suspendedOwner, all(404, 404, 200, 200, 200), "private, no-store"}, // signed URLs: per viewer
	}
	for _, c := range cases {
		for u, want := range c.want {
			w := e.req(u, "GET", "/v1/videos/"+c.v.ID.String(), "")
			if w.Code != want {
				t.Errorf("%s / %s: got %d, want %d", c.name, name(u), w.Code, want)
				continue
			}
			if want == 200 && w.Header().Get("Cache-Control") != c.cc {
				t.Errorf("%s / %s: Cache-Control %q, want %q", c.name, name(u), w.Header().Get("Cache-Control"), c.cc)
			}
			if want == 404 && problemCode(t, w) != "NOT_FOUND" {
				t.Errorf("%s / %s: not a NOT_FOUND problem", c.name, name(u))
			}
		}
	}

	// Not-READY videos have playback null, and the owner placeholder is used for inactive owners.
	out := decode[videoJSON](t, e.req(alice, "GET", "/v1/videos/"+processing.ID.String(), ""))
	if out.Playback != nil || out.Status != "PROCESSING" || out.DurationMs != nil || out.PublishedAt != nil {
		t.Fatalf("processing: %+v", out)
	}
	out = decode[videoJSON](t, e.req(mod, "GET", "/v1/videos/"+suspendedOwner.ID.String(), ""))
	if out.Owner.Handle != "deleted_user" || out.Owner.AvatarURL != nil || out.Owner.ID != alice.id.String() {
		t.Fatalf("placeholder owner: %+v", out.Owner)
	}

	if w := e.req(anon, "GET", "/v1/videos/"+ids.NewString(), ""); w.Code != 404 {
		t.Errorf("unknown id: %d", w.Code)
	}
	if w := e.req(anon, "GET", "/v1/videos/not-a-uuid", ""); w.Code != 404 {
		t.Errorf("malformed id: %d", w.Code)
	}
}

func name(u *who) string {
	switch u {
	case anon:
		return "anonymous"
	case bob:
		return "other user"
	case alice:
		return "owner"
	case mod:
		return "moderator"
	case admin:
		return "admin"
	}
	return "?"
}

func TestMalformedIdentityHeaderIs401OnOptionalRoutes(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	req := httptest.NewRequest("GET", "/v1/videos/"+v.ID.String(), nil)
	req.Header.Set("X-User-Id", "not-a-uuid")
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatalf("%d", w.Code)
	}
}

// --- GET /v1/videos (feed) -------------------------------------------------------

func TestFeedListsOnlyPublicReadyNewestFirst(t *testing.T) {
	e := newEnv(t, false)
	first := e.video(alice)
	e.video(alice, visibility(domain.VisUnlisted))
	e.video(alice, visibility(domain.VisPrivate))
	e.video(alice, notReady(domain.StatusProcessing))
	e.video(alice, func(v *domain.Video) { v.Owner.Missing = true })
	last := e.video(bob, func(v *domain.Video) { v.Owner.Handle = "bobby" })

	for _, viewer := range []*who{anon, alice, mod, admin} { // even privileged callers get the public feed
		page := decode[pageJSON[summaryJSON]](t, e.req(viewer, "GET", "/v1/videos", ""))
		if len(page.Items) != 2 || page.NextCursor != nil {
			t.Fatalf("%s: %d items, next=%v", name(viewer), len(page.Items), page.NextCursor)
		}
		if page.Items[0].ID != last.ID.String() || page.Items[1].ID != first.ID.String() {
			t.Fatalf("%s: order %v", name(viewer), []string{page.Items[0].Title, page.Items[1].Title})
		}
	}
	page := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos", ""))
	s := page.Items[0]
	if s.Owner.Handle != "bobby" || s.ThumbnailURL != mediaBase+"/"+*last.ThumbnailKey || s.DurationMs != 12345 || s.ViewCount != 42 {
		t.Fatalf("summary: %+v", s)
	}
}

func TestFeedOwnerFilter(t *testing.T) {
	e := newEnv(t, false)
	e.video(alice)
	b1 := e.video(bob)
	page := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?owner_id="+bob.id.String(), ""))
	if len(page.Items) != 1 || page.Items[0].ID != b1.ID.String() {
		t.Fatalf("%+v", page.Items)
	}
	// Unlisted/private videos stay out of the channel listing even for their owner.
	e.video(bob, visibility(domain.VisPrivate))
	page = decode[pageJSON[summaryJSON]](t, e.req(bob, "GET", "/v1/videos?owner_id="+bob.id.String(), ""))
	if len(page.Items) != 1 {
		t.Fatalf("%d items", len(page.Items))
	}
	if w := e.req(anon, "GET", "/v1/videos?owner_id=nope", ""); w.Code != 400 || problemCode(t, w) != "VALIDATION_ERROR" {
		t.Fatalf("bad owner_id: %d", w.Code)
	}
}

func TestFeedPaginationKeyset(t *testing.T) {
	e := newEnv(t, false)
	var want []string
	for i := 0; i < 7; i++ {
		want = append([]string{e.video(alice).ID.String()}, want...) // newest first
	}
	var got []string
	cursor := ""
	pages := 0
	for {
		path := "/v1/videos?limit=3"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		page := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", path, ""))
		pages++
		for _, it := range page.Items {
			got = append(got, it.ID)
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if pages != 3 || strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("pages=%d\n got %v\nwant %v", pages, got, want)
	}
}

// Videos published at the same instant must be neither skipped nor repeated
// across pages (tie-break on id).
func TestFeedPaginationEqualTimestamps(t *testing.T) {
	e := newEnv(t, false)
	same := time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC)
	seen := map[string]int{}
	for i := 0; i < 9; i++ {
		v := e.video(alice, func(v *domain.Video) { v.PublishedAt = &same })
		seen[v.ID.String()] = 0
	}
	cursor := ""
	for i := 0; i < 20; i++ {
		path := "/v1/videos?limit=2"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		page := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", path, ""))
		for _, it := range page.Items {
			seen[it.ID]++
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("video %s returned %d times", id, n)
		}
	}
}

func TestFeedLimitAndCursorValidation(t *testing.T) {
	e := newEnv(t, false)
	for i := 0; i < 30; i++ {
		e.video(alice)
	}
	if page := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos", "")); len(page.Items) != 24 || page.NextCursor == nil {
		t.Fatalf("default limit: %d items", len(page.Items))
	}
	if page := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?limit=100", "")); len(page.Items) != 30 {
		t.Fatalf("limit 100: %d", len(page.Items))
	}
	for _, q := range []string{"limit=0", "limit=101", "limit=-1", "limit=abc"} {
		if w := e.req(anon, "GET", "/v1/videos?"+q, ""); w.Code != 400 || problemCode(t, w) != "VALIDATION_ERROR" {
			t.Errorf("%s: %d", q, w.Code)
		}
	}

	page := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?limit=5", ""))
	tok := *page.NextCursor
	body, mac, _ := strings.Cut(tok, ".")
	flip := func(s string) string {
		b := []byte(s)
		b[2] ^= 1
		return string(b)
	}
	for name, c := range map[string]string{
		"tampered payload": flip(body) + "." + mac, "tampered mac": body + "." + flip(mac),
		"garbage": "garbage", "unsigned payload": body, "oversized": strings.Repeat("A", 513),
	} {
		if w := e.req(anon, "GET", "/v1/videos?cursor="+c, ""); w.Code != 400 || problemCode(t, w) != "INVALID_CURSOR" {
			t.Errorf("%s: %d", name, w.Code)
		}
	}
	// A valid cursor cannot be reused with another filter or on another endpoint.
	if w := e.req(anon, "GET", "/v1/videos?cursor="+tok+"&owner_id="+alice.id.String(), ""); w.Code != 400 {
		t.Errorf("cursor reused with a filter: %d", w.Code)
	}
	if w := e.req(alice, "GET", "/v1/studio/videos?cursor="+tok, ""); w.Code != 400 {
		t.Errorf("feed cursor used on studio: %d", w.Code)
	}
}

// --- GET /v1/studio/videos -------------------------------------------------------

func TestStudioListsOwnVideosInEveryStatus(t *testing.T) {
	e := newEnv(t, false)
	ready := e.video(alice)
	proc := e.video(alice, notReady(domain.StatusProcessing), visibility(domain.VisPrivate))
	e.store.progress[proc.ID] = 42.5
	fail := e.video(alice, notReady(domain.StatusFailed))
	msg := "The video could not be encoded."
	e.store.errs[fail.ID] = msg
	e.video(bob) // someone else's

	page := decode[pageJSON[studioJSON]](t, e.req(alice, "GET", "/v1/studio/videos", ""))
	if len(page.Items) != 3 {
		t.Fatalf("%d items", len(page.Items))
	}
	by := map[string]studioJSON{}
	for _, it := range page.Items {
		by[it.ID] = it
	}
	if s := by[ready.ID.String()]; s.Progress != 100 || s.Status != "READY" || s.ThumbnailURL == nil || *s.ThumbnailURL != mediaBase+"/"+*ready.ThumbnailKey || *s.DurationMs != 12345 {
		t.Fatalf("ready: %+v", s)
	}
	if s := by[proc.ID.String()]; s.Progress != 42.5 || s.Status != "PROCESSING" || s.Visibility != "PRIVATE" || s.ThumbnailURL != nil || s.DurationMs != nil || s.Error != nil {
		t.Fatalf("processing: %+v", s)
	}
	if s := by[fail.ID.String()]; s.Error == nil || *s.Error != msg || s.Status != "FAILED" {
		t.Fatalf("failed: %+v", s)
	}
	w := e.req(alice, "GET", "/v1/studio/videos", "")
	if w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("Cache-Control %q", w.Header().Get("Cache-Control"))
	}
	if page = decode[pageJSON[studioJSON]](t, e.req(alice, "GET", "/v1/studio/videos?status=PROCESSING", "")); len(page.Items) != 1 || page.Items[0].ID != proc.ID.String() {
		t.Fatalf("status filter: %+v", page.Items)
	}
	// Moderators only see their own videos in the studio.
	if page = decode[pageJSON[studioJSON]](t, e.req(mod, "GET", "/v1/studio/videos", "")); len(page.Items) != 0 {
		t.Fatalf("moderator studio: %d", len(page.Items))
	}
}

func TestStudioValidationAuthAndPagination(t *testing.T) {
	e := newEnv(t, false)
	if w := e.req(anon, "GET", "/v1/studio/videos", ""); w.Code != 401 {
		t.Fatalf("anonymous: %d", w.Code)
	}
	if w := e.req(alice, "GET", "/v1/studio/videos?status=DONE", ""); w.Code != 400 {
		t.Fatalf("bad status: %d", w.Code)
	}
	if w := e.req(alice, "GET", "/v1/studio/videos?limit=500", ""); w.Code != 400 {
		t.Fatalf("bad limit: %d", w.Code)
	}
	for i := 0; i < 5; i++ {
		e.video(alice, notReady(domain.StatusProcessing))
	}
	seen := map[string]bool{}
	cursor := ""
	for i := 0; i < 5; i++ {
		path := "/v1/studio/videos?limit=2&status=PROCESSING"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		page := decode[pageJSON[studioJSON]](t, e.req(alice, "GET", path, ""))
		for _, it := range page.Items {
			if seen[it.ID] {
				t.Fatalf("duplicate %s", it.ID)
			}
			seen[it.ID] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 5 {
		t.Fatalf("saw %d of 5", len(seen))
	}
	// The cursor is bound to the user and to the status filter.
	page := decode[pageJSON[studioJSON]](t, e.req(alice, "GET", "/v1/studio/videos?limit=2&status=PROCESSING", ""))
	if w := e.req(alice, "GET", "/v1/studio/videos?limit=2&cursor="+*page.NextCursor, ""); w.Code != 400 {
		t.Errorf("cursor reused without the status filter: %d", w.Code)
	}
	if w := e.req(bob, "GET", "/v1/studio/videos?limit=2&status=PROCESSING&cursor="+*page.NextCursor, ""); w.Code != 400 {
		t.Errorf("cursor of another user: %d", w.Code)
	}
}

// --- PATCH ------------------------------------------------------------------------

func TestPatchOwnerOnly(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	path := "/v1/videos/" + v.ID.String()

	if w := e.req(anon, "PATCH", path, `{"title":"x"}`); w.Code != 401 || problemCode(t, w) != "UNAUTHORIZED" {
		t.Errorf("anonymous: %d", w.Code)
	}
	for _, u := range []*who{bob, mod, admin} { // visible but not theirs: 403
		if w := e.req(u, "PATCH", path, `{"title":"x"}`); w.Code != 403 || problemCode(t, w) != "FORBIDDEN" {
			t.Errorf("%s: %d", name(u), w.Code)
		}
	}
	// A video the caller cannot see is 404, not 403.
	priv := e.video(alice, visibility(domain.VisPrivate))
	if w := e.req(bob, "PATCH", "/v1/videos/"+priv.ID.String(), `{"title":"x"}`); w.Code != 404 {
		t.Errorf("private, other user: %d", w.Code)
	}
	if w := e.req(alice, "PATCH", "/v1/videos/"+ids.NewString(), `{"title":"x"}`); w.Code != 404 {
		t.Errorf("unknown: %d", w.Code)
	}
	if e.store.videos[v.ID].Title == "x" {
		t.Fatal("a rejected PATCH changed the video")
	}

	w := e.req(alice, "PATCH", path, `{"title":"New title","description":"","visibility":"UNLISTED"}`)
	out := decode[videoJSON](t, w)
	if w.Code != 200 || out.Title != "New title" || out.Description != "" || out.Visibility != "UNLISTED" ||
		w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("%d %+v cc=%q", w.Code, out, w.Header().Get("Cache-Control"))
	}
	// Partial update leaves the other fields alone; editing a video still being processed is allowed.
	p := e.video(alice, notReady(domain.StatusProcessing))
	out = decode[videoJSON](t, e.req(alice, "PATCH", "/v1/videos/"+p.ID.String(), `{"visibility":"PRIVATE"}`))
	if out.Title != p.Title || out.Visibility != "PRIVATE" || out.Playback != nil {
		t.Fatalf("%+v", out)
	}
}

func TestPatchValidation(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	path := "/v1/videos/" + v.ID.String()
	long := strings.Repeat("x", 101)
	longDesc := strings.Repeat("d", 5001)
	for name, body := range map[string]string{
		"empty object":     `{}`,
		"null body":        `null`,
		"empty title":      `{"title":""}`,
		"title too long":   `{"title":"` + long + `"}`,
		"description long": `{"description":"` + longDesc + `"}`,
		"bad visibility":   `{"visibility":"SECRET"}`,
		"unknown field":    `{"title":"ok","status":"READY"}`,
		"wrong type":       `{"title":5}`,
		"not json":         `nope`,
		"empty body":       ``,
	} {
		w := e.req(alice, "PATCH", path, body)
		if w.Code != 400 {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	// Limits are inclusive, counted in characters, not bytes.
	ok := strings.Repeat("é", 100)
	if w := e.req(alice, "PATCH", path, `{"title":"`+ok+`","description":"`+strings.Repeat("d", 5000)+`"}`); w.Code != 200 {
		t.Errorf("limits: %d %s", w.Code, w.Body)
	}
}

// --- DELETE -----------------------------------------------------------------------

func TestDelete(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	path := "/v1/videos/" + v.ID.String()

	if w := e.req(anon, "DELETE", path, ""); w.Code != 401 {
		t.Errorf("anonymous: %d", w.Code)
	}
	if w := e.req(bob, "DELETE", path, ""); w.Code != 403 || problemCode(t, w) != "FORBIDDEN" {
		t.Errorf("other user: %d", w.Code)
	}
	priv := e.video(alice, visibility(domain.VisPrivate))
	if w := e.req(bob, "DELETE", "/v1/videos/"+priv.ID.String(), ""); w.Code != 404 {
		t.Errorf("hidden video: %d", w.Code)
	}
	if len(e.store.deleted) != 0 {
		t.Fatal("rejected deletes must not delete")
	}

	if w := e.req(alice, "DELETE", path, ""); w.Code != 204 || w.Body.Len() != 0 {
		t.Fatalf("owner: %d", w.Code)
	}
	if len(e.store.deleted) != 1 {
		t.Fatalf("deleted: %+v", e.store.deleted)
	}
	ev := e.store.deleted[0]
	if ev.VideoID != v.ID.String() || ev.OwnerID != alice.id.String() || ev.RawBucket != "winkey-raw" ||
		ev.RawKey != e.store.raw[v.ID][1] || ev.MediaBucket != "winkey-media" || ev.MediaPrefix != "v/"+v.ID.String()+"/" {
		t.Fatalf("event: %+v", ev)
	}
	if w := e.req(alice, "DELETE", path, ""); w.Code != 404 {
		t.Errorf("second delete: %d", w.Code)
	}
	if w := e.req(anon, "GET", path, ""); w.Code != 404 {
		t.Errorf("get after delete: %d", w.Code)
	}
	// Moderators and admins can delete anyone's video, even a private one.
	for _, u := range []*who{mod, admin} {
		x := e.video(alice, visibility(domain.VisPrivate))
		if w := e.req(u, "DELETE", "/v1/videos/"+x.ID.String(), ""); w.Code != 204 {
			t.Errorf("%s: %d", name(u), w.Code)
		}
	}
}

// --- cache ------------------------------------------------------------------------

func TestCacheServesRepeatedReadsAndAppliesVisibilityAfterwards(t *testing.T) {
	e := newEnv(t, true)
	v := e.video(alice, visibility(domain.VisPrivate))
	path := "/v1/videos/" + v.ID.String()

	// The owner's read fills the cache with the (viewer independent) record ...
	if w := e.req(alice, "GET", path, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	gets := e.store.gets
	// ... and must not leak the private video to anyone else, nor cost another database read.
	if w := e.req(anon, "GET", path, ""); w.Code != 404 {
		t.Fatalf("anonymous read of a cached private video: %d", w.Code)
	}
	if w := e.req(mod, "GET", path, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if e.store.gets != gets || e.cache.hits < 2 {
		t.Fatalf("store reads %d -> %d, cache hits %d", gets, e.store.gets, e.cache.hits)
	}

	pub := e.video(alice)
	for i := 0; i < 3; i++ {
		e.req(anon, "GET", "/v1/videos/"+pub.ID.String(), "")
	}
	if e.cache.sets != 2 { // one per distinct video
		t.Fatalf("cache sets %d", e.cache.sets)
	}
}

func TestPatchAndDeleteInvalidateTheCache(t *testing.T) {
	e := newEnv(t, true)
	v := e.video(alice)
	path := "/v1/videos/" + v.ID.String()

	e.req(anon, "GET", path, "") // fill
	if w := e.req(alice, "PATCH", path, `{"title":"Edited","visibility":"PRIVATE"}`); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := e.req(anon, "GET", path, ""); w.Code != 404 {
		t.Fatalf("a stale cached PUBLIC record was served after the video became PRIVATE: %d", w.Code)
	}
	if out := decode[videoJSON](t, e.req(alice, "GET", path, "")); out.Title != "Edited" {
		t.Fatalf("stale title %q", out.Title)
	}
	e.req(alice, "GET", path, "") // fill again
	if w := e.req(alice, "DELETE", path, ""); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := e.req(alice, "GET", path, ""); w.Code != 404 {
		t.Fatalf("cached record served after delete: %d", w.Code)
	}
	if e.cache.inval < 2 {
		t.Fatalf("invalidations: %d", e.cache.inval)
	}
}

func TestAuthorisationNeverReadsTheCache(t *testing.T) {
	e := newEnv(t, true)
	v := e.video(alice)
	path := "/v1/videos/" + v.ID.String()
	e.req(anon, "GET", path, "") // fill
	// Change the owner behind the cache's back: PATCH/DELETE must decide from the database.
	stale := e.cache.m[v.ID]
	stale.OwnerID = bob.id
	e.cache.m[v.ID] = stale
	if w := e.req(bob, "PATCH", path, `{"title":"hijack"}`); w.Code != 403 {
		t.Fatalf("PATCH trusted the cache: %d", w.Code)
	}
	if w := e.req(bob, "DELETE", path, ""); w.Code != 403 {
		t.Fatalf("DELETE trusted the cache: %d", w.Code)
	}
}
