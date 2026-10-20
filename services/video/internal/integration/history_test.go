package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Watch history (task HIST1) on real PostgreSQL and Valkey: written by view reports, read and cleared through
// /v1/me/history; every response is validated against video.v1.yaml.

type historyPage struct {
	Items []struct {
		Video struct {
			ID string `json:"id"`
		} `json:"video"`
		WatchedMs int64 `json:"watched_ms"`
	} `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

func (s *viewStack) history(who *actor, method, path, op string, want int) []byte {
	s.t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if who != nil {
		req.Header.Set("X-User-Id", who.id.String())
		req.Header.Set("X-User-Roles", who.roles)
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	if w.Code != want {
		s.t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body)
	}
	s.spec.Check(s.t, method, op, w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w.Body.Bytes()
}

func (s *viewStack) historyIDs(who *actor, path string) ([]string, *string) {
	s.t.Helper()
	var p historyPage
	if err := json.Unmarshal(s.history(who, "GET", path, "/v1/me/history", http.StatusOK), &p); err != nil {
		s.t.Fatal(err)
	}
	out := make([]string, len(p.Items))
	for i, it := range p.Items {
		out[i] = it.Video.ID
	}
	return out, p.NextCursor
}

func TestWatchHistory(t *testing.T) {
	s := startViews(t, viewOpts{})
	memberU := testutil.SeedUser(t, s.pg.Pool, "member", nil, "")
	member := &actor{memberU.ID, "viewer"}
	a, b := s.seed(testutil.Video{Title: "A"}), s.seed(testutil.Video{Title: "B"})
	unlisted := s.seed(testutil.Video{Title: "U", Visibility: "UNLISTED"})

	// Below the threshold, or anonymous: nothing is recorded.
	s.counted(report{who: member}, a, 1000)
	s.counted(report{}, b, 40000)
	if got, _ := s.historyIDs(member, "/v1/me/history"); len(got) != 0 {
		t.Fatalf("history %v", got)
	}

	// Past the threshold: most recent first; a second watch (a duplicate view) moves it to the top again.
	s.counted(report{who: member}, a, 31000)
	s.counted(report{who: member}, b, 32000)
	s.counted(report{who: member}, unlisted, 33000)
	s.counted(report{who: member}, a, 34000)
	got, _ := s.historyIDs(member, "/v1/me/history")
	if len(got) != 3 || got[0] != a.String() || got[1] != unlisted.String() || got[2] != b.String() {
		t.Fatalf("history %v (a %s, b %s, u %s)", got, a, b, unlisted)
	}

	// Pages walk with the cursor.
	first, next := s.historyIDs(member, "/v1/me/history?limit=2")
	if len(first) != 2 || next == nil {
		t.Fatalf("first page %v %v", first, next)
	}
	rest, end := s.historyIDs(member, "/v1/me/history?limit=2&cursor="+*next)
	if len(rest) != 1 || rest[0] != b.String() || end != nil {
		t.Fatalf("second page %v %v", rest, end)
	}

	// A video made private is skipped, not removed: it comes back when it is public again.
	if _, err := s.pg.Pool.Exec(context.Background(), `UPDATE media.videos SET visibility = 'PRIVATE' WHERE id = $1`, b); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.historyIDs(member, "/v1/me/history"); len(got) != 2 {
		t.Fatalf("private video listed: %v", got)
	}
	if _, err := s.pg.Pool.Exec(context.Background(), `UPDATE media.videos SET visibility = 'PUBLIC' WHERE id = $1`, b); err != nil {
		t.Fatal(err)
	}

	// Another user's history is their own; anonymous callers get 401.
	other := &actor{testutil.SeedUser(t, s.pg.Pool, "other", nil, "").ID, "viewer"}
	if got, _ := s.historyIDs(other, "/v1/me/history"); len(got) != 0 {
		t.Fatalf("other user sees %v", got)
	}
	s.history(nil, "GET", "/v1/me/history", "/v1/me/history", http.StatusUnauthorized)

	// Remove one (twice is fine, so is a malformed id), then clear all.
	s.history(member, "DELETE", "/v1/me/history/"+a.String(), "/v1/me/history/{video_id}", http.StatusNoContent)
	s.history(member, "DELETE", "/v1/me/history/"+a.String(), "/v1/me/history/{video_id}", http.StatusNoContent)
	s.history(member, "DELETE", "/v1/me/history/nope", "/v1/me/history/{video_id}", http.StatusNoContent)
	if got, _ := s.historyIDs(member, "/v1/me/history"); len(got) != 2 || got[0] != unlisted.String() {
		t.Fatalf("after remove %v", got)
	}
	s.history(member, "DELETE", "/v1/me/history", "/v1/me/history", http.StatusNoContent)
	if got, _ := s.historyIDs(member, "/v1/me/history"); len(got) != 0 {
		t.Fatalf("after clear %v", got)
	}
}

// RecordWatch keeps the newest MaxHistory rows per user.
func TestWatchHistoryIsPruned(t *testing.T) {
	s := startViews(t, viewOpts{})
	ctx := context.Background()
	user := uuid.New()
	v := s.seed(testutil.Video{Title: "old"})
	// MaxHistory rows already there, all older than now, the oldest for video v.
	if _, err := s.pg.Pool.Exec(ctx, `
		INSERT INTO media.watch_history (user_id, video_id, watched_at, watched_ms) VALUES ($1, $2, now() - interval '1 year', 1)`, user, v); err != nil {
		t.Fatal(err)
	}
	for i := 1; i < domain.MaxHistory; i++ {
		id := s.seed(testutil.Video{Title: "filler"})
		if _, err := s.pg.Pool.Exec(ctx, `
			INSERT INTO media.watch_history (user_id, video_id, watched_at, watched_ms) VALUES ($1, $2, now() - make_interval(secs => $3), 1)`,
			user, id, domain.MaxHistory-i); err != nil {
			t.Fatal(err)
		}
	}
	fresh := s.seed(testutil.Video{Title: "fresh"})
	if err := s.st.RecordWatch(ctx, user, fresh, 31000); err != nil {
		t.Fatal(err)
	}
	var n int
	var oldGone bool
	_ = s.pg.Pool.QueryRow(ctx, `SELECT count(*), NOT bool_or(video_id = $2) FROM media.watch_history WHERE user_id = $1`, user, v).Scan(&n, &oldGone)
	if n != domain.MaxHistory || !oldGone {
		t.Fatalf("%d rows, oldest gone %v", n, oldGone)
	}
	// A deleted video is not an error.
	if err := s.st.RecordWatch(ctx, user, uuid.New(), 31000); err != nil {
		t.Fatalf("unknown video: %v", err)
	}
}
