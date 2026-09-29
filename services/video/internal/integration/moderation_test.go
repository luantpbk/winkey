package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/cache"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
	"github.com/luantpbk/winkey/services/video/internal/views"
)

// These tests run PUT /v1/videos/{video_id}/moderation (task A2) on real
// PostgreSQL 17 (real migrations, including 000006), a real NATS JetStream with
// the VIDEO stream, and Valkey for recordView. Every response is validated
// against video.v1.yaml and every event against video.moderated.schema.json.

// testLog writes log lines to the test output.
type testLog struct{ t *testing.T }

func (l testLog) Write(p []byte) (int, error) {
	l.t.Helper()
	l.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}

type modStack struct {
	t     *testing.T
	pg    *testkit.Postgres
	nats  *testkit.NATS
	h     http.Handler
	spec  *contract.Spec
	owner testutil.User
	// consumer of video.moderated on the VIDEO stream
	cons jetstream.Consumer
}

var (
	modUser   = &actor{id: ids.New(), roles: "viewer,moderator"}
	adminUser = &actor{id: ids.New(), roles: "admin"}
	viewerU   = &actor{id: ids.New(), roles: "viewer"}
)

func startModeration(t *testing.T) *modStack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	nt := testkit.StartNATS(t)
	srv := startValkeyServer(t)
	// Errors of the handler and the relay show up in the test output.
	log := slog.New(slog.NewTextHandler(testLog{t}, &slog.HandlerOptions{Level: slog.LevelWarn}))

	rc, err := cache.NewClient(srv.URL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rc.Close() })
	st := &store.Postgres{Pool: pg.Pool}
	h := &api.Handler{Store: st, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("integration-cursor-secret"), Log: log,
		Views: views.NewValkey(rc, 30*time.Minute), ViewRateLimit: 100000}
	r := httpx.NewRouter("video-moderation-it", log)
	h.Routes(r)

	// The relay publishes the outbox to JetStream, like main does.
	outbox.SetProducer("video-svc")
	relay := &outbox.Relay{Pool: pg.Pool, Publisher: outbox.JetStreamPublisher{JS: nt.JS}, Schema: "media", Log: log, Listen: true}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = relay.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	cons, err := nt.JS.OrderedConsumer(context.Background(), "VIDEO", jetstream.OrderedConsumerConfig{
		FilterSubjects: []string{"video.moderated"},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := &modStack{t: t, pg: pg, nats: nt, h: r, spec: contract.Load(t), cons: cons}
	s.owner = testutil.SeedUser(t, pg.Pool, "owner", nil, "")
	return s
}

func (s *modStack) seed(v testutil.Video) uuid.UUID {
	s.t.Helper()
	if v.Owner == uuid.Nil {
		v.Owner = s.owner.ID
	}
	return testutil.SeedVideo(s.t, s.pg.Pool, v).ID
}

func (s *modStack) ownerActor() *actor { return &actor{id: s.owner.ID, roles: "viewer,creator"} }

// do sends a request and validates the response against the contract.
func (s *modStack) do(a *actor, method, path, body string) (int, http.Header, []byte) {
	s.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "198.51.100.10:4000"
	if a != nil {
		req.Header.Set("X-User-Id", a.id.String())
		req.Header.Set("X-User-Roles", a.roles)
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	p, _, _ := strings.Cut(path, "?")
	switch {
	case strings.HasSuffix(p, "/moderation"):
		p = "/v1/videos/{video_id}/moderation"
	case strings.HasSuffix(p, "/views"):
		p = "/v1/videos/{video_id}/views"
	case strings.HasPrefix(p, "/v1/videos/"):
		p = "/v1/videos/{video_id}"
	}
	s.spec.Check(s.t, method, p, w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w.Code, w.Header(), w.Body.Bytes()
}

func (s *modStack) moderate(a *actor, id uuid.UUID, body string) (int, []byte) {
	s.t.Helper()
	code, _, b := s.do(a, "PUT", fmt.Sprintf("/v1/videos/%s/moderation", id), body)
	return code, b
}

func hideBody(reason string) string {
	b, _ := json.Marshal(map[string]string{"state": "HIDDEN", "reason": reason})
	return string(b)
}

type row struct {
	State  string
	Reason *string
	By     *uuid.UUID
	At     *time.Time
}

func (s *modStack) row(id uuid.UUID) row {
	s.t.Helper()
	var r row
	err := s.pg.Pool.QueryRow(context.Background(),
		`SELECT moderation_state::text, moderation_reason, moderated_by, moderated_at FROM media.videos WHERE id=$1`, id).
		Scan(&r.State, &r.Reason, &r.By, &r.At)
	if err != nil {
		s.t.Fatal(err)
	}
	return r
}

func (s *modStack) outboxRows(id uuid.UUID) [][]byte {
	s.t.Helper()
	rows, err := s.pg.Pool.Query(context.Background(),
		`SELECT payload FROM media.outbox WHERE subject='video.moderated' AND payload->'data'->>'video_id' = $1 ORDER BY id`, id.String())
	if err != nil {
		s.t.Fatal(err)
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			s.t.Fatal(err)
		}
		out = append(out, b)
	}
	return out
}

// nextEvent waits for the next video.moderated message on the stream.
func (s *modStack) nextEvent() (data map[string]any, raw []byte) {
	s.t.Helper()
	msg, err := s.cons.Next(jetstream.FetchMaxWait(10 * time.Second))
	if err != nil {
		s.t.Fatalf("no video.moderated event on the VIDEO stream: %v", err)
	}
	raw = msg.Data()
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		s.t.Fatal(err)
	}
	return env.Data, raw
}

// expectNoEvent fails if another event is published within a short window.
func (s *modStack) expectNoEvent() {
	s.t.Helper()
	msg, err := s.cons.Next(jetstream.FetchMaxWait(1500 * time.Millisecond))
	if err == nil {
		s.t.Fatalf("unexpected event: %s", msg.Data())
	}
}

func TestModerationEndToEndOnPostgresAndNATS(t *testing.T) {
	s := startModeration(t)
	video := s.seed(testutil.Video{})
	other := s.seed(testutil.Video{})

	code, body := s.moderate(modUser, video, hideBody("  spam  "))
	if code != http.StatusOK {
		t.Fatalf("hide: %d %s", code, body)
	}
	var out struct {
		Moderation struct {
			State       string  `json:"state"`
			Reason      *string `json:"reason"`
			ModeratedAt *string `json:"moderated_at"`
		} `json:"moderation"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if out.Moderation.State != "HIDDEN" || out.Moderation.Reason == nil || *out.Moderation.Reason != "spam" || out.Moderation.ModeratedAt == nil {
		t.Fatalf("moderation: %s", body)
	}
	r := s.row(video)
	if r.State != "HIDDEN" || r.Reason == nil || *r.Reason != "spam" || r.By == nil || *r.By != modUser.id || r.At == nil {
		t.Fatalf("row: %+v", r)
	}
	if o := s.row(other); o.State != "VISIBLE" {
		t.Fatalf("another video changed: %+v", o)
	}

	// Exactly one outbox row, valid against the event schema, and it reaches the VIDEO stream.
	rows := s.outboxRows(video)
	if len(rows) != 1 {
		t.Fatalf("outbox rows: %d", len(rows))
	}
	validateEvent(t, "video.moderated", rows[0])
	data, raw := s.nextEvent()
	validateEvent(t, "video.moderated", raw)
	if data["video_id"] != video.String() || data["owner_id"] != s.owner.ID.String() ||
		data["state"] != "HIDDEN" || data["moderator_id"] != modUser.id.String() || len(data) != 4 {
		t.Fatalf("event data: %v", data)
	}

	// The same state again (another moderator, another reason): 200, nothing written, no event.
	code, body = s.moderate(adminUser, video, hideBody("different"))
	if code != http.StatusOK || !strings.Contains(string(body), `"reason":"spam"`) {
		t.Fatalf("no-op: %d %s", code, body)
	}
	if r2 := s.row(video); r2.By == nil || *r2.By != modUser.id || !r2.At.Equal(*r.At) || *r2.Reason != "spam" {
		t.Fatalf("a no-op changed the row: %+v", r2)
	}
	if len(s.outboxRows(video)) != 1 {
		t.Fatalf("a no-op wrote an outbox row")
	}
	s.expectNoEvent()

	// Restore: reason cleared, second event.
	code, body = s.moderate(adminUser, video, `{"state":"VISIBLE"}`)
	if code != http.StatusOK || !strings.Contains(string(body), `"state":"VISIBLE"`) {
		t.Fatalf("restore: %d %s", code, body)
	}
	if r3 := s.row(video); r3.State != "VISIBLE" || r3.Reason != nil || *r3.By != adminUser.id {
		t.Fatalf("row after restore: %+v", r3)
	}
	data, raw = s.nextEvent()
	validateEvent(t, "video.moderated", raw)
	if data["state"] != "VISIBLE" || data["moderator_id"] != adminUser.id.String() {
		t.Fatalf("event: %v", data)
	}
	// Restoring a visible video again is a no-op too.
	if code, _ := s.moderate(modUser, video, `{"state":"VISIBLE"}`); code != http.StatusOK {
		t.Fatal(code)
	}
	if len(s.outboxRows(video)) != 2 {
		t.Fatalf("outbox rows: %d", len(s.outboxRows(video)))
	}
	s.expectNoEvent()
}

func TestModerationRolesAndValidationOnPostgres(t *testing.T) {
	s := startModeration(t)
	video := s.seed(testutil.Video{})
	owner := s.ownerActor()

	for name, c := range map[string]struct {
		who  *actor
		want int
	}{"anonymous": {nil, 401}, "viewer": {viewerU, 403}, "owner": {owner, 403}, "moderator": {modUser, 200}, "admin": {adminUser, 200}} {
		if code, b := s.moderate(c.who, video, hideBody("x")); code != c.want {
			t.Errorf("%s: %d, want %d (%s)", name, code, c.want, b)
		}
		s.moderate(adminUser, video, `{"state":"VISIBLE"}`)
	}
	for name, body := range map[string]string{
		"no state": `{}`, "bad state": `{"state":"GONE"}`, "HIDDEN without reason": `{"state":"HIDDEN"}`,
		"blank reason": hideBody("   "), "long reason": hideBody(strings.Repeat("y", 501)), "unknown field": `{"state":"VISIBLE","x":1}`,
	} {
		if code, b := s.moderate(modUser, video, body); code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, code, b)
		}
	}
	if code, _ := s.moderate(modUser, ids.New(), hideBody("x")); code != http.StatusNotFound {
		t.Errorf("unknown video: %d", code)
	}
	// 500 characters fit the column constraint, which counts characters, not bytes.
	// Multi-byte characters prove that on a UTF8 server (CI); the embedded PostgreSQL used
	// on Windows without Docker is WIN1252 and miscounts them, so there ASCII is used.
	var enc string
	if err := s.pg.Pool.QueryRow(context.Background(), `SHOW server_encoding`).Scan(&enc); err != nil {
		t.Fatal(err)
	}
	ch := "é"
	if enc != "UTF8" {
		ch = "e"
	}
	if code, b := s.moderate(modUser, video, hideBody(strings.Repeat(ch, 500))); code != http.StatusOK {
		t.Errorf("500 characters (%s, server_encoding %s): %d %s", ch, enc, code, b)
	}
}

// Concurrent identical requests: the row lock serialises them, so exactly one
// changes the state and emits exactly one event.
func TestConcurrentModerationEmitsOneEvent(t *testing.T) {
	s := startModeration(t)
	video := s.seed(testutil.Video{})
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			m := &actor{id: ids.New(), roles: "viewer,moderator"}
			if code, b := s.moderate(m, video, hideBody(fmt.Sprintf("report %d", i))); code != http.StatusOK {
				t.Errorf("request %d: %d %s", i, code, b)
			}
		}(i)
	}
	wg.Wait()
	if n := len(s.outboxRows(video)); n != 1 {
		t.Fatalf("outbox rows: %d, want 1", n)
	}
	if r := s.row(video); r.State != "HIDDEN" || r.Reason == nil || r.By == nil {
		t.Fatalf("row: %+v", r)
	}
	s.nextEvent()
	s.expectNoEvent()
}

// The state change and the event are one transaction: when the outbox insert
// fails, the video is left as it was.
func TestModerationIsAtomicWithTheOutbox(t *testing.T) {
	s := startModeration(t)
	video := s.seed(testutil.Video{})
	ctx := context.Background()
	for _, q := range []string{
		`CREATE FUNCTION media.refuse_moderated() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
			IF NEW.subject = 'video.moderated' THEN RAISE EXCEPTION 'outbox refuses video.moderated'; END IF; RETURN NEW; END $$`,
		`CREATE TRIGGER refuse_moderated BEFORE INSERT ON media.outbox FOR EACH ROW EXECUTE FUNCTION media.refuse_moderated()`,
	} {
		if _, err := s.pg.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	// A 500 is not in the contract, so this one request bypasses the contract check.
	req := httptest.NewRequest("PUT", fmt.Sprintf("/v1/videos/%s/moderation", video), strings.NewReader(hideBody("spam")))
	req.Header.Set("X-User-Id", modUser.id.String())
	req.Header.Set("X-User-Roles", modUser.roles)
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"INTERNAL"`) {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if r := s.row(video); r.State != "VISIBLE" || r.Reason != nil || r.By != nil || r.At != nil {
		t.Fatalf("the update survived a failed outbox insert: %+v", r)
	}
	if len(s.outboxRows(video)) != 0 {
		t.Fatal("outbox row without its update")
	}
	if _, err := s.pg.Pool.Exec(ctx, `DROP TRIGGER refuse_moderated ON media.outbox`); err != nil {
		t.Fatal(err)
	}
	if code, b := s.moderate(modUser, video, hideBody("spam")); code != http.StatusOK {
		t.Fatalf("after the fault is gone: %d %s", code, b)
	}
	if s.row(video).State != "HIDDEN" || len(s.outboxRows(video)) != 1 {
		t.Fatal("retry did not apply")
	}
}

func TestHiddenVideoOnPostgres(t *testing.T) {
	s := startModeration(t)
	owner := s.ownerActor()
	stranger := &actor{id: ids.New(), roles: "viewer"}
	shown := s.seed(testutil.Video{})
	hidden := s.seed(testutil.Video{})
	if code, b := s.moderate(modUser, hidden, hideBody("hate speech")); code != http.StatusOK {
		t.Fatalf("%d %s", code, b)
	}
	hp := "/v1/videos/" + hidden.String()

	// Reads: 404 for outsiders, 200 with `moderation` for the owner, moderators and admins.
	for name, a := range map[string]*actor{"anonymous": nil, "stranger": stranger} {
		code, _, body := s.do(a, "GET", hp, "")
		if code != http.StatusNotFound || strings.Contains(string(body), "hate speech") {
			t.Errorf("%s: %d %s", name, code, body)
		}
	}
	for name, a := range map[string]*actor{"owner": owner, "moderator": modUser, "admin": adminUser} {
		code, hdr, body := s.do(a, "GET", hp, "")
		var v struct {
			Moderation *struct {
				State  string  `json:"state"`
				Reason *string `json:"reason"`
			} `json:"moderation"`
		}
		_ = json.Unmarshal(body, &v)
		if code != http.StatusOK || v.Moderation == nil || v.Moderation.State != "HIDDEN" || *v.Moderation.Reason != "hate speech" || hdr.Get("Cache-Control") != "private, no-store" {
			t.Errorf("%s: %d cache=%q %s", name, code, hdr.Get("Cache-Control"), body)
		}
	}
	// `moderation` is never shown to outsiders, on a visible video either.
	if code, _, body := s.do(stranger, "GET", "/v1/videos/"+shown.String(), ""); code != 200 || strings.Contains(string(body), `"moderation"`) {
		t.Errorf("visible video for a stranger: %d %s", code, body)
	}

	// Feeds: the hidden video is in no list; the visible one is.
	listIDs := func(path string, a *actor) []string {
		_, _, body := s.do(a, "GET", path, "")
		var p struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, it := range p.Items {
			out = append(out, it.ID)
		}
		return out
	}
	contains := func(list []string, id uuid.UUID) bool {
		for _, x := range list {
			if x == id.String() {
				return true
			}
		}
		return false
	}
	for _, path := range []string{"/v1/videos", "/v1/videos?owner_id=" + s.owner.ID.String()} {
		for _, a := range []*actor{nil, owner, modUser} {
			l := listIDs(path, a)
			if contains(l, hidden) || !contains(l, shown) {
				t.Errorf("%s: %v", path, l)
			}
		}
	}
	// The owner's studio still lists it, with the moderation state and reason.
	_, _, body := s.do(owner, "GET", "/v1/studio/videos", "")
	var sp struct {
		Items []struct {
			ID         string `json:"id"`
			Moderation struct {
				State  string  `json:"state"`
				Reason *string `json:"reason"`
			} `json:"moderation"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &sp); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, it := range sp.Items {
		got[it.ID] = it.Moderation.State
	}
	if got[hidden.String()] != "HIDDEN" || got[shown.String()] != "VISIBLE" {
		t.Errorf("studio: %v", got)
	}

	// The owner can edit a hidden video but not un-hide it.
	if code, _, b := s.do(owner, "PATCH", hp, `{"title":"edited","visibility":"PUBLIC"}`); code != http.StatusOK || !strings.Contains(string(b), `"state":"HIDDEN"`) {
		t.Errorf("PATCH: %d %s", code, b)
	}
	if code, _, _ := s.do(stranger, "GET", hp, ""); code != http.StatusNotFound {
		t.Errorf("still hidden after the owner made it PUBLIC: %d", code)
	}

	// Restored: back in the feed and readable by everyone.
	s.moderate(modUser, hidden, `{"state":"VISIBLE"}`)
	if code, _, _ := s.do(stranger, "GET", hp, ""); code != http.StatusOK {
		t.Errorf("after restore: %d", code)
	}
	if !contains(listIDs("/v1/videos", nil), hidden) {
		t.Error("a restored video is listed again")
	}
}

func TestHiddenVideoIsNotCounted(t *testing.T) {
	s := startModeration(t)
	owner := s.ownerActor()
	video := s.seed(testutil.Video{})
	s.moderate(modUser, video, hideBody("spam"))
	vp := fmt.Sprintf("/v1/videos/%s/views", video)
	report := func() string { return fmt.Sprintf(`{"playback_id":%q,"watched_ms":40000}`, ids.NewString()) }

	// Outsiders: the video is not readable for them, so 404 like on GET (video.v1.yaml: recordView).
	for name, a := range map[string]*actor{"anonymous": nil, "stranger": viewerU} {
		if code, _, b := s.do(a, "POST", vp, report()); code != http.StatusNotFound {
			t.Errorf("%s: %d %s", name, code, b)
		}
	}
	// Those who can read it get 202 but nothing is counted.
	for name, a := range map[string]*actor{"owner": owner, "moderator": modUser, "admin": adminUser} {
		code, _, b := s.do(a, "POST", vp, report())
		if code != http.StatusAccepted || !strings.Contains(string(b), `"counted":false`) {
			t.Errorf("%s: %d %s", name, code, b)
		}
	}
	before := metric(t, "counted")
	// Restored: the owner counts again.
	s.moderate(modUser, video, `{"state":"VISIBLE"}`)
	code, _, b := s.do(owner, "POST", vp, report())
	if code != http.StatusAccepted || !strings.Contains(string(b), `"counted":true`) || metric(t, "counted")-before != 1 {
		t.Errorf("after restore: %d %s", code, b)
	}
}
