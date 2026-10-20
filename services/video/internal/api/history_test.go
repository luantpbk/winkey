package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

type historyOut struct {
	Items []struct {
		Video     summaryJSON `json:"video"`
		WatchedAt string      `json:"watched_at"`
		WatchedMs int64       `json:"watched_ms"`
	} `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// HIST1: the history lists watchable videos most recent first, pages with a cursor scoped to the caller, and
// can be pruned one video at a time or cleared.
func TestWatchHistoryEndpoints(t *testing.T) {
	e := newEnv(t, false)
	a, b := e.video(alice), e.video(alice)
	private := e.video(alice, visibility(domain.VisPrivate))
	ctx := context.Background()
	for _, v := range []domain.Video{a, private, b} {
		if err := e.store.RecordWatch(ctx, bob.id, v.ID, 31000); err != nil {
			t.Fatal(err)
		}
	}

	w := e.req(bob, "GET", "/v1/me/history?limit=1", "")
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("%d %s %v", w.Code, w.Body, w.Header())
	}
	page := decode[historyOut](t, w)
	if len(page.Items) != 1 || page.Items[0].Video.ID != b.ID.String() || page.Items[0].WatchedMs != 31000 ||
		page.Items[0].Video.ThumbnailURL == "" || page.NextCursor == nil {
		t.Fatalf("first page %+v", page)
	}
	// The private video is skipped.
	page = decode[historyOut](t, e.req(bob, "GET", "/v1/me/history?limit=1&cursor="+*page.NextCursor, ""))
	if len(page.Items) != 1 || page.Items[0].Video.ID != a.ID.String() || page.NextCursor != nil {
		t.Fatalf("second page %+v", page)
	}
	// Another caller cannot reuse the cursor, and has an empty history.
	first := decode[historyOut](t, e.req(bob, "GET", "/v1/me/history?limit=1", ""))
	if w := e.req(alice, "GET", "/v1/me/history?cursor="+*first.NextCursor, ""); w.Code != http.StatusBadRequest {
		t.Errorf("foreign cursor: %d", w.Code)
	}
	if got := decode[historyOut](t, e.req(alice, "GET", "/v1/me/history", "")); len(got.Items) != 0 {
		t.Errorf("alice sees %+v", got)
	}
	if w := e.req(anon, "GET", "/v1/me/history", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: %d", w.Code)
	}

	if w := e.req(bob, "DELETE", "/v1/me/history/"+b.ID.String(), ""); w.Code != http.StatusNoContent {
		t.Fatalf("remove: %d", w.Code)
	}
	if got := decode[historyOut](t, e.req(bob, "GET", "/v1/me/history", "")); len(got.Items) != 1 || got.Items[0].Video.ID != a.ID.String() {
		t.Fatalf("after remove %+v", got)
	}
	if w := e.req(bob, "DELETE", "/v1/me/history", ""); w.Code != http.StatusNoContent {
		t.Fatalf("clear: %d", w.Code)
	}
	if got := decode[historyOut](t, e.req(bob, "GET", "/v1/me/history", "")); len(got.Items) != 0 {
		t.Fatalf("after clear %+v", got)
	}
}
