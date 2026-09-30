package api

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

func TestSubscriptionFeedRequiresIdentity(t *testing.T) {
	e := newEnv(t, false)
	if w := e.req(anon, "GET", "/v1/feed/subscriptions", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestSubscriptionFeedListsFollowedChannelsNewestFirstAcrossPages(t *testing.T) {
	e := newEnv(t, false)
	chanA, chanB, other := &who{id: ids.New()}, &who{id: ids.New()}, &who{id: ids.New()}
	var want []domain.Video // oldest first here
	for i := 0; i < 5; i++ {
		want = append(want, e.video(chanA), e.video(chanB))
	}
	e.video(other) // a channel bob does not follow
	e.store.follow(bob.id, chanA.id)
	e.store.follow(bob.id, chanB.id)

	var got []string
	path := "/v1/feed/subscriptions?limit=4"
	for pages := 1; ; pages++ {
		w := e.req(bob, "GET", path, "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body)
		}
		p := decode[pageJSON[summaryJSON]](t, w)
		got = append(got, pageIDs(p)...)
		if p.NextCursor == nil {
			if pages != 3 { // 4 + 4 + 2
				t.Fatalf("%d pages", pages)
			}
			break
		}
		path = "/v1/feed/subscriptions?limit=4&cursor=" + url.QueryEscape(*p.NextCursor)
	}
	if len(got) != 10 {
		t.Fatalf("%d items", len(got))
	}
	for i := range got { // newest first: the last video created is first
		if got[i] != want[len(want)-1-i].ID.String() {
			t.Fatalf("item %d is %s, want %s", i, got[i], want[len(want)-1-i].ID)
		}
	}
}

func TestSubscriptionFeedWithoutSubscriptionsIsAnEmptyPage(t *testing.T) {
	e := newEnv(t, false)
	e.video(alice)
	w := e.req(bob, "GET", "/v1/feed/subscriptions", "")
	p := decode[pageJSON[summaryJSON]](t, w)
	if w.Code != 200 || p.Items == nil || len(p.Items) != 0 || p.NextCursor != nil || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body)
	}
}

func TestSubscriptionFeedNeverListsWhatThePublicFeedHides(t *testing.T) {
	e := newEnv(t, false)
	ch := &who{id: ids.New()}
	ok := e.video(ch)
	e.video(ch, visibility(domain.VisPrivate))
	e.video(ch, visibility(domain.VisUnlisted))
	e.video(ch, func(v *domain.Video) { v.ModerationState = domain.ModHidden })
	e.video(ch, notReady(domain.StatusProcessing))
	e.video(ch, func(v *domain.Video) { v.Owner.Missing = true })
	e.store.follow(bob.id, ch.id)
	p := decode[pageJSON[summaryJSON]](t, e.req(bob, "GET", "/v1/feed/subscriptions", ""))
	if got := pageIDs(p); len(got) != 1 || got[0] != ok.ID.String() {
		t.Fatalf("%v", got)
	}
}

func TestSubscriptionFeedValidationAndCursors(t *testing.T) {
	e := newEnv(t, false)
	ch := &who{id: ids.New()}
	for i := 0; i < 3; i++ {
		e.video(ch)
	}
	e.store.follow(bob.id, ch.id)
	e.store.follow(alice.id, ch.id)
	first := decode[pageJSON[summaryJSON]](t, e.req(bob, "GET", "/v1/feed/subscriptions?limit=1", ""))
	if first.NextCursor == nil {
		t.Fatal("no cursor")
	}
	feed := decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos?limit=1", ""))
	for name, c := range map[string]struct {
		who  *who
		path string
	}{
		"limit 0":           {bob, "/v1/feed/subscriptions?limit=0"},
		"limit 101":         {bob, "/v1/feed/subscriptions?limit=101"},
		"garbage cursor":    {bob, "/v1/feed/subscriptions?cursor=abc"},
		"another user's":    {alice, "/v1/feed/subscriptions?cursor=" + url.QueryEscape(*first.NextCursor)},
		"the public feed's": {bob, "/v1/feed/subscriptions?cursor=" + url.QueryEscape(*feed.NextCursor)},
	} {
		w := e.req(c.who, "GET", c.path, "")
		want := "VALIDATION_ERROR"
		if c.who != bob || name != "limit 0" && name != "limit 101" {
			want = "INVALID_CURSOR"
		}
		if w.Code != 400 || problemCode(t, w) != want {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	// A subscription cursor is not a feed cursor either.
	if w := e.req(bob, "GET", "/v1/videos?cursor="+url.QueryEscape(*first.NextCursor), ""); w.Code != 400 || problemCode(t, w) != "INVALID_CURSOR" {
		t.Errorf("subscription cursor on the public feed: %d", w.Code)
	}
}
