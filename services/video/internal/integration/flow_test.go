// Package integration runs video-svc's HTTP API on the real PostgreSQL store
// (testkit: PostgreSQL 17 with the real migrations). Every response is
// validated against contracts/openapi/video.v1.yaml and the video.deleted
// event against its JSON Schema. Skips when Docker is unavailable.
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

const mediaBase = "https://media.winkey.vn"

type actor struct {
	id    uuid.UUID
	roles string
}

type stack struct {
	t    *testing.T
	pg   *testkit.Postgres
	h    http.Handler
	spec *contract.Spec
}

func start(t *testing.T) *stack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	spec := contract.Load(t)
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	h := &api.Handler{Store: &store.Postgres{Pool: pg.Pool}, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("integration-cursor-secret"), Log: log}
	r := httpx.NewRouter("video-it", log)
	h.Routes(r)
	return &stack{t: t, pg: pg, h: r, spec: spec}
}

var videoPath = regexp.MustCompile(`^/v1/videos/[^/]+$`)

func (s *stack) do(a *actor, method, path, body string) (int, http.Header, []byte) {
	s.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if a != nil {
		req.Header.Set("X-User-Id", a.id.String())
		req.Header.Set("X-User-Roles", a.roles)
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	p, _, _ := strings.Cut(path, "?")
	if strings.HasPrefix(p, "/v1/videos/") && strings.HasSuffix(p, "/related") {
		p = "/v1/videos/{video_id}/related"
	}
	if strings.HasPrefix(p, "/v1/studio/videos/") && strings.HasSuffix(p, "/stats") {
		p = "/v1/studio/videos/{video_id}/stats"
	}
	if videoPath.MatchString(p) && p != "/v1/videos/batch" {
		p = "/v1/videos/{video_id}"
	}
	s.spec.Check(s.t, method, p, w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w.Code, w.Header(), w.Body.Bytes()
}

func js[T any](t *testing.T, b []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("%v: %s", err, b)
	}
	return v
}

type page struct {
	Items []struct {
		ID           string `json:"id"`
		Status       string `json:"status"`
		Progress     float64
		ThumbnailURL *string `json:"thumbnail_url"`
		Owner        struct {
			Handle    string  `json:"handle"`
			AvatarURL *string `json:"avatar_url"`
		} `json:"owner"`
	} `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

func strp(s string) *string { return &s }

func TestVideoAPIOnPostgres(t *testing.T) {
	s := start(t)
	ctx := context.Background()
	pool := s.pg.Pool

	aliceU := testutil.SeedUser(t, pool, "alice", strp("avatars/alice.jpg"), "")
	bobU := testutil.SeedUser(t, pool, "bobby", nil, "")
	modU := testutil.SeedUser(t, pool, "moddy", nil, "")
	alice := &actor{aliceU.ID, "viewer,creator"}
	bob := &actor{bobU.ID, "viewer,creator"}
	mod := &actor{modU.ID, "viewer,moderator"}

	same := time.Date(2026, 10, 1, 8, 0, 0, 654321000, time.UTC)
	var pubIDs []string
	for i := 0; i < 7; i++ { // 7 public videos sharing one timestamp
		pubIDs = append(pubIDs, testutil.SeedVideo(t, pool, testutil.Video{Owner: aliceU.ID, Published: same}).ID.String())
	}
	private := testutil.SeedVideo(t, pool, testutil.Video{Owner: aliceU.ID, Visibility: "PRIVATE"})
	unlisted := testutil.SeedVideo(t, pool, testutil.Video{Owner: aliceU.ID, Visibility: "UNLISTED"})
	proc := testutil.SeedVideo(t, pool, testutil.Video{Owner: aliceU.ID, Status: "PROCESSING", Attempts: []float32{55}})
	bobs := testutil.SeedVideo(t, pool, testutil.Video{Owner: bobU.ID, Published: same.Add(time.Minute)})

	// --- feed: every public video exactly once across pages; hidden ones never
	seen := map[string]int{}
	cursor := ""
	for i := 0; i < 10; i++ {
		path := "/v1/videos?limit=3"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		code, _, body := s.do(nil, "GET", path, "")
		if code != 200 {
			t.Fatalf("%d %s", code, body)
		}
		p := js[page](t, body)
		for _, it := range p.Items {
			seen[it.ID]++
		}
		if p.NextCursor == nil {
			break
		}
		cursor = *p.NextCursor
	}
	if len(seen) != 8 { // 7 alice + 1 bob
		t.Fatalf("feed returned %d distinct videos, want 8", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("%s returned %d times", id, n)
		}
	}
	for _, hidden := range []string{private.ID.String(), unlisted.ID.String(), proc.ID.String()} {
		if seen[hidden] != 0 {
			t.Errorf("hidden video %s is in the feed", hidden)
		}
	}
	code, _, body := s.do(nil, "GET", "/v1/videos?limit=1", "")
	first := js[page](t, body)
	if code != 200 || first.Items[0].ID != bobs.ID.String() || first.Items[0].Owner.Handle != "bobby" {
		t.Fatalf("newest first: %+v", first.Items)
	}
	code, _, body = s.do(nil, "GET", "/v1/videos?owner_id="+aliceU.ID.String()+"&limit=100", "")
	if got := js[page](t, body); code != 200 || len(got.Items) != 7 || got.Items[0].Owner.AvatarURL == nil || *got.Items[0].Owner.AvatarURL != mediaBase+"/avatars/alice.jpg" {
		t.Fatalf("channel page: %d %+v", code, got.Items)
	}
	if code, _, _ = s.do(nil, "GET", "/v1/videos?cursor=AAAA.BBBB", ""); code != 400 {
		t.Errorf("tampered cursor: %d", code)
	}

	// --- watch page and visibility on real rows
	type vid struct {
		Title      string
		Status     string
		Visibility string
		Owner      struct{ Handle string }
		Playback   *struct {
			HLSURL       string `json:"hls_url"`
			ThumbnailURL string `json:"thumbnail_url"`
			Renditions   []struct{ Name string }
		}
	}
	code, hdr, body := s.do(nil, "GET", "/v1/videos/"+pubIDs[0], "")
	v := js[vid](t, body)
	if code != 200 || hdr.Get("Cache-Control") != "public, max-age=30" || v.Playback == nil ||
		v.Playback.HLSURL != mediaBase+"/v/"+pubIDs[0]+"/a1/hls/master.m3u8" ||
		v.Playback.ThumbnailURL != mediaBase+"/v/"+pubIDs[0]+"/a1/thumb/poster.jpg" ||
		len(v.Playback.Renditions) != 3 || v.Playback.Renditions[0].Name != "1080p" {
		t.Fatalf("watch page: %d %s", code, body)
	}
	for _, c := range []struct {
		who  *actor
		id   uuid.UUID
		want int
		cc   string
	}{
		{nil, unlisted.ID, 200, "private, no-store"},
		{nil, private.ID, 404, ""}, {bob, private.ID, 404, ""}, {alice, private.ID, 200, "private, no-store"}, {mod, private.ID, 200, "private, no-store"},
		{nil, proc.ID, 404, ""}, {alice, proc.ID, 200, "private, no-store"},
	} {
		code, hdr, body := s.do(c.who, "GET", "/v1/videos/"+c.id.String(), "")
		if code != c.want || (code == 200 && hdr.Get("Cache-Control") != c.cc) {
			t.Errorf("%v %s: %d cc=%q", c.who != nil, c.id, code, hdr.Get("Cache-Control"))
		}
		if c.id == proc.ID && code == 200 && js[vid](t, body).Playback != nil {
			t.Error("playback must be null while PROCESSING")
		}
	}

	// --- studio
	code, _, body = s.do(alice, "GET", "/v1/studio/videos?limit=100", "")
	st := js[page](t, body)
	if code != 200 || len(st.Items) != 10 {
		t.Fatalf("studio: %d, %d items", code, len(st.Items))
	}
	for _, it := range st.Items {
		switch it.ID {
		case proc.ID.String():
			if it.Progress != 55 || it.Status != "PROCESSING" || it.ThumbnailURL != nil {
				t.Errorf("processing item: %+v", it)
			}
		case pubIDs[0]:
			if it.Progress != 100 || it.ThumbnailURL == nil {
				t.Errorf("ready item: %+v", it)
			}
		}
	}
	if code, _, body = s.do(alice, "GET", "/v1/studio/videos?status=PROCESSING", ""); js[page](t, body).Items[0].ID != proc.ID.String() || code != 200 {
		t.Error("studio status filter")
	}
	if code, _, _ = s.do(nil, "GET", "/v1/studio/videos", ""); code != 401 {
		t.Errorf("studio anonymous: %d", code)
	}

	// --- PATCH
	if code, _, _ = s.do(bob, "PATCH", "/v1/videos/"+pubIDs[0], `{"title":"nope"}`); code != 403 {
		t.Errorf("PATCH by other user: %d", code)
	}
	code, _, body = s.do(alice, "PATCH", "/v1/videos/"+pubIDs[0], `{"title":"Edited","visibility":"UNLISTED"}`)
	if got := js[vid](t, body); code != 200 || got.Title != "Edited" || got.Visibility != "UNLISTED" || got.Playback == nil {
		t.Fatalf("PATCH: %d %s", code, body)
	}
	if code, _, _ = s.do(nil, "GET", "/v1/videos?owner_id="+aliceU.ID.String()+"&limit=100", ""); code != 200 {
		t.Fatal(code)
	}
	_, _, body = s.do(nil, "GET", "/v1/videos?owner_id="+aliceU.ID.String()+"&limit=100", "")
	for _, it := range js[page](t, body).Items {
		if it.ID == pubIDs[0] {
			t.Error("a video made UNLISTED is still in the feed")
		}
	}
	if code, _, _ = s.do(alice, "PATCH", "/v1/videos/"+pubIDs[0], `{}`); code != 400 {
		t.Errorf("empty PATCH: %d", code)
	}

	// --- DELETE by a moderator: row + renditions gone, one contract-valid video.deleted event
	target := pubIDs[1]
	if code, _, _ = s.do(bob, "DELETE", "/v1/videos/"+target, ""); code != 403 {
		t.Errorf("DELETE by other user: %d", code)
	}
	if code, _, _ = s.do(mod, "DELETE", "/v1/videos/"+target, ""); code != 204 {
		t.Fatalf("DELETE by moderator: %d", code)
	}
	if code, _, _ = s.do(alice, "GET", "/v1/videos/"+target, ""); code != 404 {
		t.Errorf("GET after delete: %d", code)
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM media.video_renditions WHERE video_id=$1`, target).Scan(&n)
	if n != 0 {
		t.Errorf("%d renditions survived", n)
	}
	var payload []byte
	if err := pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject='video.deleted'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	validateEvent(t, "video.deleted", payload)
	var env struct {
		Data struct {
			VideoID     string `json:"video_id"`
			MediaPrefix string `json:"media_prefix"`
			RawKey      string `json:"raw_key"`
		}
	}
	_ = json.Unmarshal(payload, &env)
	if env.Data.VideoID != target || env.Data.MediaPrefix != "v/"+target+"/" || !strings.HasSuffix(env.Data.RawKey, "/"+target+"/source") {
		t.Fatalf("event data: %s", payload)
	}
}

// validateEvent checks an outbox payload against envelope.schema.json and the
// event's own schema from contracts/events.
func validateEvent(t *testing.T, name string, payload []byte) {
	t.Helper()
	dir := ""
	wd, _ := os.Getwd()
	for i := 0; i < 8; i++ {
		if st, err := os.Stat(filepath.Join(wd, "contracts", "events")); err == nil && st.IsDir() {
			dir = filepath.Join(wd, "contracts", "events")
			break
		}
		wd = filepath.Dir(wd)
	}
	if dir == "" {
		t.Fatal("contracts/events not found")
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	for _, f := range []string{"envelope.schema.json", name + ".schema.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := c.AddResource("https://winkey.vn/contracts/events/"+f, doc); err != nil {
			t.Fatal(err)
		}
	}
	schema, err := c.Compile("https://winkey.vn/contracts/events/" + name + ".schema.json")
	if err != nil {
		t.Fatal(err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(inst); err != nil {
		t.Fatalf("%s violates its contract: %v\n%s", name, err, payload)
	}
}
