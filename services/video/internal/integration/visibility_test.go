package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Task C4-b: PATCH /v1/videos/{id} writes video.visibility_changed to media.outbox in the same
// transaction as the update, and only when the visibility really changes. Real PostgreSQL 17
// (real migrations); every response is validated against video.v1.yaml and every payload against
// video.visibility_changed.schema.json.

func visibilityRows(t *testing.T, s *stack, id uuid.UUID) [][]byte {
	t.Helper()
	rows, err := s.pg.Pool.Query(context.Background(),
		`SELECT payload FROM media.outbox WHERE subject='video.visibility_changed' AND payload->'data'->>'video_id' = $1 ORDER BY id`, id.String())
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			t.Fatal(err)
		}
		out = append(out, b)
	}
	return out
}

func eventData(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		t.Fatal(err)
	}
	return env.Data
}

func patch(t *testing.T, s *stack, a *actor, id uuid.UUID, body string) int {
	t.Helper()
	code, _, b := s.do(a, "PATCH", "/v1/videos/"+id.String(), body)
	if code >= 500 {
		t.Fatalf("PATCH: %d %s", code, b)
	}
	return code
}

func TestVisibilityChangeWritesExactlyOneEventInTheSameTransaction(t *testing.T) {
	s := start(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID

	// PUBLIC -> PRIVATE: exactly one row, valid against its schema.
	if code := patch(t, s, alice, video, `{"visibility":"PRIVATE"}`); code != 200 {
		t.Fatalf("PATCH: %d", code)
	}
	rows := visibilityRows(t, s, video)
	if len(rows) != 1 {
		t.Fatalf("%d outbox rows, want 1", len(rows))
	}
	validateEvent(t, "video.visibility_changed", rows[0])
	if d := eventData(t, rows[0]); d["video_id"] != video.String() || d["owner_id"] != owner.ID.String() || d["visibility"] != "PRIVATE" || len(d) != 3 {
		t.Fatalf("data: %v", d)
	}

	// Every later change adds one, in order, carrying the NEW value.
	for i, v := range []string{"UNLISTED", "PUBLIC", "PRIVATE"} {
		if code := patch(t, s, alice, video, fmt.Sprintf(`{"visibility":%q}`, v)); code != 200 {
			t.Fatalf("PATCH %s: %d", v, code)
		}
		rows = visibilityRows(t, s, video)
		if len(rows) != i+2 {
			t.Fatalf("after %s: %d rows", v, len(rows))
		}
		validateEvent(t, "video.visibility_changed", rows[len(rows)-1])
		if got := eventData(t, rows[len(rows)-1])["visibility"]; got != v {
			t.Fatalf("event carries %v, want %s", got, v)
		}
	}
	// The changes came with the event: the row says PRIVATE too.
	var vis string
	if err := s.pg.Pool.QueryRow(context.Background(), `SELECT visibility::text FROM media.videos WHERE id=$1`, video).Scan(&vis); err != nil || vis != "PRIVATE" {
		t.Fatalf("%s %v", vis, err)
	}
}

func TestNoVisibilityEventWhenTheVisibilityDoesNotChange(t *testing.T) {
	s := start(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID // PUBLIC

	for name, body := range map[string]string{
		"same visibility":            `{"visibility":"PUBLIC"}`,
		"title only":                 `{"title":"A new title"}`,
		"description only":           `{"description":"A new description"}`,
		"title and the same value":   `{"title":"Another title","visibility":"PUBLIC"}`,
		"everything but visibility":  `{"title":"T","description":"D"}`,
		"same visibility once again": `{"visibility":"PUBLIC"}`,
	} {
		if code := patch(t, s, alice, video, body); code != 200 {
			t.Fatalf("%s: %d", name, code)
		}
		if n := len(visibilityRows(t, s, video)); n != 0 {
			t.Fatalf("%s wrote %d visibility_changed rows", name, n)
		}
	}
	// A real change after the no-ops is the first and only event.
	patch(t, s, alice, video, `{"title":"Last","visibility":"UNLISTED"}`)
	if n := len(visibilityRows(t, s, video)); n != 1 {
		t.Fatalf("%d rows", n)
	}
	var title string
	_ = s.pg.Pool.QueryRow(context.Background(), `SELECT title FROM media.videos WHERE id=$1`, video).Scan(&title)
	if title != "Last" {
		t.Fatalf("title %q", title)
	}
}

func TestFailedUpdatesLeaveNoVisibilityEvent(t *testing.T) {
	s := start(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	stranger := &actor{testutil.SeedUser(t, s.pg.Pool, "mallory", nil, "").ID, "viewer,creator"}
	moderator := &actor{testutil.SeedUser(t, s.pg.Pool, "moddy", nil, "").ID, "viewer,moderator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	private := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID, Visibility: "PRIVATE"}).ID

	// 403: a visible video the caller does not own (also a moderator: only the owner edits).
	for _, a := range []*actor{stranger, moderator} {
		if code := patch(t, s, a, video, `{"visibility":"PRIVATE"}`); code != http.StatusForbidden {
			t.Fatalf("non-owner: %d", code)
		}
	}
	// 404: a PRIVATE video the caller may not even see; unknown id.
	if code := patch(t, s, stranger, private, `{"visibility":"PUBLIC"}`); code != http.StatusNotFound {
		t.Fatalf("invisible video: %d", code)
	}
	if code := patch(t, s, alice, uuid.New(), `{"visibility":"PRIVATE"}`); code != http.StatusNotFound {
		t.Fatalf("unknown video: %d", code)
	}
	// 400: invalid values, empty body.
	for _, body := range []string{`{"visibility":"SECRET"}`, `{}`, `{"visibility":"PRIVATE","title":""}`} {
		if code := patch(t, s, alice, video, body); code != http.StatusBadRequest {
			t.Fatalf("%s: %d", body, code)
		}
	}
	// 401: no identity.
	if code := patch(t, s, nil, video, `{"visibility":"PRIVATE"}`); code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", code)
	}
	for _, id := range []uuid.UUID{video, private} {
		if n := len(visibilityRows(t, s, id)); n != 0 {
			t.Fatalf("a failed update left %d outbox rows", n)
		}
	}
	var vis string
	_ = s.pg.Pool.QueryRow(context.Background(), `SELECT visibility::text FROM media.videos WHERE id=$1`, video).Scan(&vis)
	if vis != "PUBLIC" {
		t.Fatalf("a rejected update changed the video: %s", vis)
	}
}

// The update and its event are ONE transaction: when the outbox insert fails, the video keeps its
// old visibility and title, and nothing is queued.
func TestVisibilityUpdateIsAtomicWithTheOutbox(t *testing.T) {
	s := start(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID, Title: "Before"}).ID
	for _, q := range []string{
		`CREATE FUNCTION media.refuse_visibility() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
			IF NEW.subject = 'video.visibility_changed' THEN RAISE EXCEPTION 'outbox refuses video.visibility_changed'; END IF; RETURN NEW; END $$`,
		`CREATE TRIGGER refuse_visibility BEFORE INSERT ON media.outbox FOR EACH ROW EXECUTE FUNCTION media.refuse_visibility()`,
	} {
		if _, err := s.pg.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	// A 500 is not in the contract, so this request bypasses the contract check.
	req := httptest.NewRequest("PATCH", "/v1/videos/"+video.String(), strings.NewReader(`{"visibility":"PRIVATE","title":"After"}`))
	req.Header.Set("X-User-Id", alice.id.String())
	req.Header.Set("X-User-Roles", alice.roles)
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var vis, title string
	_ = s.pg.Pool.QueryRow(ctx, `SELECT visibility::text, title FROM media.videos WHERE id=$1`, video).Scan(&vis, &title)
	if vis != "PUBLIC" || title != "Before" || len(visibilityRows(t, s, video)) != 0 {
		t.Fatalf("the update survived a failed outbox insert: %s %q", vis, title)
	}
	// A title-only edit does not touch the outbox, so it goes through even with the fault in place.
	if code := patch(t, s, alice, video, `{"title":"Fine"}`); code != 200 {
		t.Fatalf("title only: %d", code)
	}
	if _, err := s.pg.Pool.Exec(ctx, `DROP TRIGGER refuse_visibility ON media.outbox`); err != nil {
		t.Fatal(err)
	}
	if code := patch(t, s, alice, video, `{"visibility":"PRIVATE"}`); code != 200 || len(visibilityRows(t, s, video)) != 1 {
		t.Fatalf("retry: %d", code)
	}
}

// Concurrent identical PATCHes: the row lock serialises them, so the change is seen (and announced) once.
func TestConcurrentVisibilityChangesEmitOneEvent(t *testing.T) {
	s := start(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code := patch(t, s, alice, video, `{"visibility":"PRIVATE"}`); code != 200 {
				t.Errorf("PATCH: %d", code)
			}
		}()
	}
	wg.Wait()
	if n := len(visibilityRows(t, s, video)); n != 1 {
		t.Fatalf("%d events for one change", n)
	}
}

// The relay publishes the row on subject video.visibility_changed of the VIDEO stream.
func TestRelayPublishesVisibilityChangedOnTheVideoStream(t *testing.T) {
	s := startModeration(t) // PostgreSQL + NATS with the VIDEO stream + the outbox relay
	cons, err := s.nats.JS.OrderedConsumer(context.Background(), "VIDEO", jetstream.OrderedConsumerConfig{
		FilterSubjects: []string{"video.visibility_changed"},
	})
	if err != nil {
		t.Fatal(err)
	}
	video := s.seed(testutil.Video{})
	owner := s.ownerActor()
	if code, _, b := s.do(owner, "PATCH", "/v1/videos/"+video.String(), `{"visibility":"PRIVATE"}`); code != 200 {
		t.Fatalf("PATCH: %d %s", code, b)
	}
	msg, err := cons.Next(jetstream.FetchMaxWait(10 * time.Second))
	if err != nil {
		t.Fatalf("nothing on video.visibility_changed: %v", err)
	}
	if msg.Subject() != "video.visibility_changed" {
		t.Fatalf("subject %s", msg.Subject())
	}
	validateEvent(t, "video.visibility_changed", msg.Data())
	if d := eventData(t, msg.Data()); d["video_id"] != video.String() || d["visibility"] != "PRIVATE" || d["owner_id"] != s.owner.ID.String() {
		t.Fatalf("data: %v", d)
	}
	// A no-op reaches nobody.
	s.do(owner, "PATCH", "/v1/videos/"+video.String(), `{"visibility":"PRIVATE","title":"x"}`)
	if m, err := cons.Next(jetstream.FetchMaxWait(1500 * time.Millisecond)); err == nil {
		t.Fatalf("unexpected event: %s", m.Data())
	}
}
