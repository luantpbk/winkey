package api

import (
	"net/url"
	"testing"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

const adminVideosPath = "/v1/studio/admin/videos"

type adminVideoOut struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Status      string `json:"status"`
	Visibility  string `json:"visibility"`
	OwnerActive bool   `json:"owner_active"`
	Owner       struct {
		ID     string `json:"id"`
		Handle string `json:"handle"`
	} `json:"owner"`
	Moderation *struct {
		State string `json:"state"`
	} `json:"moderation"`
}

func adminTitles(t *testing.T, e *env, u *who, query string) []string {
	t.Helper()
	w := e.req(u, "GET", adminVideosPath+query, "")
	if w.Code != 200 {
		t.Fatalf("%s: %d %s", query, w.Code, w.Body)
	}
	var out []string
	for _, it := range decode[pageJSON[adminVideoOut]](t, w).Items {
		out = append(out, it.Title)
	}
	return out
}

// ADMV1 (ADR-047): moderators and admins list every video of every owner, in every state.
func TestAdminListVideosAccessAndScope(t *testing.T) {
	e := newEnv(t, false)
	pub := e.video(alice, func(v *domain.Video) { v.Title = "Public by Alice" })
	e.video(bob, visibility(domain.VisPrivate), func(v *domain.Video) { v.Title = "Private by Bob" })
	e.video(bob, func(v *domain.Video) { v.Title = "Processing by Bob"; v.Status = domain.StatusProcessing })
	e.video(alice, func(v *domain.Video) {
		v.Title = "Hidden by Alice"
		v.ModerationState = domain.ModHidden
	})
	gone := e.video(bob, func(v *domain.Video) { v.Title = "Owner gone"; v.Owner.Missing = true })

	if w := e.req(anon, "GET", adminVideosPath, ""); w.Code != 401 {
		t.Fatalf("anonymous: %d", w.Code)
	}
	for _, u := range []*who{alice, {ids.New(), "viewer"}} {
		if w := e.req(u, "GET", adminVideosPath, ""); w.Code != 403 {
			t.Fatalf("%s: %d, want 403", u.roles, w.Code)
		}
	}
	for _, u := range []*who{mod, admin} {
		w := e.req(u, "GET", adminVideosPath, "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != cachePrivate {
			t.Fatalf("%s: %d %q", u.roles, w.Code, w.Header().Get("Cache-Control"))
		}
		page := decode[pageJSON[adminVideoOut]](t, w)
		if len(page.Items) != 5 {
			t.Fatalf("%s sees %d videos, want all 5", u.roles, len(page.Items))
		}
		for _, it := range page.Items {
			switch it.ID {
			case pub.ID.String():
				if it.Owner.ID != alice.id.String() || !it.OwnerActive || it.Moderation == nil || it.Moderation.State != "VISIBLE" {
					t.Errorf("public item: %+v", it)
				}
			case gone.ID.String():
				if it.Owner.Handle != "deleted_user" || it.OwnerActive {
					t.Errorf("owner placeholder: %+v", it)
				}
			}
		}
	}
}

func TestAdminListVideosFilters(t *testing.T) {
	e := newEnv(t, false)
	e.video(alice, func(v *domain.Video) { v.Title = "Thiên Cơ Biến tập 1" })
	e.video(bob, visibility(domain.VisPrivate), func(v *domain.Video) { v.Title = "Bob private" })
	e.video(bob, func(v *domain.Video) { v.Title = "Bob failed"; v.Status = domain.StatusFailed })
	e.video(alice, func(v *domain.Video) { v.Title = "Alice hidden"; v.ModerationState = domain.ModHidden })

	cases := map[string]int{
		"?q=" + url.QueryEscape("thiên"):                  1,
		"?q=bob":                                          2,
		"?status=FAILED":                                  1,
		"?visibility=PRIVATE":                             1,
		"?moderation_state=HIDDEN":                        1,
		"?moderation_state=VISIBLE":                       3,
		"?owner_id=" + bob.id.String():                    2,
		"?owner_id=" + bob.id.String() + "&status=FAILED": 1,
	}
	for q, want := range cases {
		if got := adminTitles(t, e, admin, q); len(got) != want {
			t.Errorf("%s: %v, want %d items", q, got, want)
		}
	}
	for _, q := range []string{"?q=a", "?status=DONE", "?visibility=SECRET", "?moderation_state=GONE", "?owner_id=nope"} {
		if w := e.req(admin, "GET", adminVideosPath+q, ""); w.Code != 400 || problemCode(t, w) != "VALIDATION_ERROR" {
			t.Errorf("%s: %d", q, w.Code)
		}
	}
}

func TestAdminListVideosPagination(t *testing.T) {
	e := newEnv(t, false)
	for i := 0; i < 5; i++ {
		e.video(alice)
	}
	w := e.req(admin, "GET", adminVideosPath+"?limit=2", "")
	first := decode[pageJSON[adminVideoOut]](t, w)
	if len(first.Items) != 2 || first.NextCursor == nil {
		t.Fatalf("first page: %+v", first)
	}
	seen := map[string]bool{}
	for _, it := range first.Items {
		seen[it.ID] = true
	}
	cur := url.QueryEscape(*first.NextCursor)
	second := decode[pageJSON[adminVideoOut]](t, e.req(admin, "GET", adminVideosPath+"?limit=2&cursor="+cur, ""))
	for _, it := range second.Items {
		if seen[it.ID] {
			t.Fatalf("page overlap: %s", it.ID)
		}
	}
	// A cursor is bound to its filters.
	if w := e.req(admin, "GET", adminVideosPath+"?limit=2&status=READY&cursor="+cur, ""); w.Code != 400 {
		t.Fatalf("cursor reused with another filter: %d", w.Code)
	}
}
