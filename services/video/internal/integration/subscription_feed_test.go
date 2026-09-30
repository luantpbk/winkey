package integration

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Task R2-b (ADR-021) on real PostgreSQL 17: GET /v1/feed/subscriptions over media.subscriptions. The consumer
// that fills the table from NATS is tested in subscriptions_nats_test.go. Every response is validated against
// video.v1.yaml.

type feedStack struct {
	t    *testing.T
	pg   *testkit.Postgres
	st   *store.Postgres
	h    http.Handler
	spec *contract.Spec
}

func startFeed(t *testing.T) *feedStack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	st := &store.Postgres{Pool: pg.Pool}
	h := &api.Handler{Store: st, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("integration-cursor-secret"), Log: log}
	r := httpx.NewRouter("video-feed-it", log)
	h.Routes(r)
	return &feedStack{t: t, pg: pg, st: st, h: r, spec: contract.Load(t)}
}

func (s *feedStack) get(a *actor, path string) (int, http.Header, []byte) {
	s.t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	if a != nil {
		req.Header.Set("X-User-Id", a.id.String())
		req.Header.Set("X-User-Roles", a.roles)
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	p, _, _ := strings.Cut(path, "?")
	s.spec.Check(s.t, "GET", p, w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w.Code, w.Header(), w.Body.Bytes()
}

// feed reads every page of the subscription feed of a and returns the video ids in order.
func (s *feedStack) feed(a *actor, limit int) []string {
	s.t.Helper()
	var out []string
	path := fmt.Sprintf("/v1/feed/subscriptions?limit=%d", limit)
	for pages := 0; pages < 100; pages++ {
		code, hdr, body := s.get(a, path)
		if code != 200 || hdr.Get("Cache-Control") != "private, no-store" {
			s.t.Fatalf("%d %v %s", code, hdr, body)
		}
		p := js[searchPage](s.t, body)
		out = append(out, p.ids()...)
		if p.NextCursor == nil {
			return out
		}
		path = fmt.Sprintf("/v1/feed/subscriptions?limit=%d&cursor=%s", limit, url.QueryEscape(*p.NextCursor))
	}
	s.t.Fatal("paging does not end")
	return nil
}

func (s *feedStack) subscribe(sub, ch uuid.UUID) {
	s.t.Helper()
	if err := s.st.Subscribe(context.Background(), sub, ch, time.Now().UTC()); err != nil {
		s.t.Fatal(err)
	}
}

func (s *feedStack) unsubscribe(sub, ch uuid.UUID) {
	s.t.Helper()
	if err := s.st.Unsubscribe(context.Background(), sub, ch); err != nil {
		s.t.Fatal(err)
	}
}

func TestSubscriptionFeedOnPostgres(t *testing.T) {
	s := startFeed(t)
	ctx := context.Background()
	me := &actor{testutil.SeedUser(t, s.pg.Pool, "meuser", nil, "").ID, "viewer"}
	stranger := &actor{testutil.SeedUser(t, s.pg.Pool, "stranger", nil, "").ID, "viewer"}
	a := testutil.SeedUser(t, s.pg.Pool, "chana", nil, "")
	b := testutil.SeedUser(t, s.pg.Pool, "chanb", nil, "")
	unfollowed := testutil.SeedUser(t, s.pg.Pool, "chanc", nil, "")
	ghost := testutil.SeedUser(t, s.pg.Pool, "ghost", nil, "SUSPENDED")

	base := time.Date(2026, 10, 1, 8, 0, 0, 123456000, time.UTC)
	type vid struct {
		id string
		at time.Time
	}
	var expected []vid // every public video of a and b
	add := func(owner uuid.UUID, at time.Time) {
		id := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner, Published: at}).ID.String()
		expected = append(expected, vid{id, at})
	}
	for i := 0; i < 7; i++ {
		add(a.ID, base.Add(time.Duration(i)*time.Hour))
	}
	for i := 0; i < 4; i++ {
		add(b.ID, base.Add(time.Duration(i)*time.Hour+30*time.Minute))
	}
	// Three videos of different channels published at the very same instant: the id orders them.
	same := base.Add(48 * time.Hour)
	add(a.ID, same)
	add(b.ID, same)
	add(a.ID, same)
	// What must never be listed, on a followed channel.
	testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID, Visibility: "PRIVATE", Published: base.Add(100 * time.Hour)})
	testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID, Visibility: "UNLISTED", Published: base.Add(101 * time.Hour)})
	testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: a.ID, Hidden: true, Published: base.Add(102 * time.Hour)})
	testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: b.ID, Status: "PROCESSING", Attempts: []float32{5}})
	// A channel that is followed but suspended, and one that is not followed at all.
	testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: ghost.ID, Published: base.Add(103 * time.Hour)})
	testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: unfollowed.ID, Published: base.Add(104 * time.Hour)})

	// No subscriptions yet: an empty page.
	code, hdr, body := s.get(me, "/v1/feed/subscriptions")
	if code != 200 || strings.TrimSpace(string(body)) != `{"items":[],"next_cursor":null}` || hdr.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("no subscriptions: %d %v %s", code, hdr, body)
	}
	// Anonymous: 401.
	if code, _, body := s.get(nil, "/v1/feed/subscriptions"); code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d %s", code, body)
	}

	s.subscribe(me.id, a.ID)
	s.subscribe(me.id, b.ID)
	s.subscribe(me.id, ghost.ID)

	want := func(vs []vid) []string { // newest first, ties by id DESC
		cp := append([]vid(nil), vs...)
		for i := range cp {
			for j := i + 1; j < len(cp); j++ {
				if cp[j].at.After(cp[i].at) || cp[j].at.Equal(cp[i].at) && cp[j].id > cp[i].id {
					cp[i], cp[j] = cp[j], cp[i]
				}
			}
		}
		var out []string
		for _, v := range cp {
			out = append(out, v.id)
		}
		return out
	}
	for _, limit := range []int{4, 5, 100} { // paging across pages, whatever the page size
		got := s.feed(me, limit)
		w := want(expected)
		if len(got) != len(w) {
			t.Fatalf("limit %d: %d videos, want %d", limit, len(got), len(w))
		}
		for i := range w {
			if got[i] != w[i] {
				t.Fatalf("limit %d: item %d is %s, want %s", limit, i, got[i], w[i])
			}
		}
	}

	// A cursor belongs to its user.
	_, _, b1 := s.get(me, "/v1/feed/subscriptions?limit=2")
	cur := *js[searchPage](t, b1).NextCursor
	if code, _, body := s.get(stranger, "/v1/feed/subscriptions?cursor="+url.QueryEscape(cur)); code != 400 {
		t.Fatalf("another user's cursor: %d %s", code, body)
	}
	// The stranger follows nobody.
	if got := s.feed(stranger, 10); len(got) != 0 {
		t.Fatalf("stranger sees %v", got)
	}

	// Unsubscribe: that channel's videos are gone, the other's stay.
	s.unsubscribe(me.id, b.ID)
	var onlyA []vid
	for _, v := range expected {
		var owner uuid.UUID
		if err := s.pg.Pool.QueryRow(ctx, `SELECT owner_id FROM media.videos WHERE id = $1`, v.id).Scan(&owner); err != nil {
			t.Fatal(err)
		}
		if owner == a.ID {
			onlyA = append(onlyA, v)
		}
	}
	got := s.feed(me, 3)
	if w := want(onlyA); len(got) != len(w) || len(got) != 9 {
		t.Fatalf("after unsubscribing b: %d videos, want %d", len(got), len(w))
	} else {
		for i := range w {
			if got[i] != w[i] {
				t.Fatalf("after unsubscribing: item %d", i)
			}
		}
	}
	s.unsubscribe(me.id, a.ID)
	s.unsubscribe(me.id, ghost.ID)
	if got := s.feed(me, 10); len(got) != 0 {
		t.Fatalf("after unsubscribing everything: %v", got)
	}
}

// A video made private, hidden or whose owner is suspended after the subscription disappears from the feed at once
// (the feed reads the videos, not a copy of them).
func TestSubscriptionFeedFollowsTheVideoState(t *testing.T) {
	s := startFeed(t)
	ctx := context.Background()
	me := &actor{testutil.SeedUser(t, s.pg.Pool, "meuser", nil, "").ID, "viewer"}
	ch := testutil.SeedUser(t, s.pg.Pool, "chanel", nil, "")
	v1 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: ch.ID}).ID
	v2 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: ch.ID}).ID
	v3 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: ch.ID}).ID
	s.subscribe(me.id, ch.ID)
	if got := s.feed(me, 10); len(got) != 3 {
		t.Fatalf("%v", got)
	}
	for _, q := range []struct {
		sql string
		id  uuid.UUID
	}{
		{`UPDATE media.videos SET visibility = 'PRIVATE' WHERE id = $1`, v1},
		{`UPDATE media.videos SET moderation_state = 'HIDDEN', moderation_reason = 'spam', moderated_by = owner_id, moderated_at = now() WHERE id = $1`, v2},
	} {
		if _, err := s.pg.Pool.Exec(ctx, q.sql, q.id); err != nil {
			t.Fatal(err)
		}
	}
	if got := s.feed(me, 10); len(got) != 1 || got[0] != v3.String() {
		t.Fatalf("%v", got)
	}
	if _, err := s.pg.Pool.Exec(ctx, `UPDATE auth.users SET status = 'SUSPENDED' WHERE id = $1`, ch.ID); err != nil {
		t.Fatal(err)
	}
	if got := s.feed(me, 10); len(got) != 0 {
		t.Fatalf("suspended owner: %v", got)
	}
}

// Replaying the same changes any number of times leaves the same rows, and the first subscribed_at is kept.
func TestSubscriptionChangesAreIdempotent(t *testing.T) {
	s := startFeed(t)
	ctx := context.Background()
	me := testutil.SeedUser(t, s.pg.Pool, "meuser", nil, "")
	ch := testutil.SeedUser(t, s.pg.Pool, "chanel", nil, "")
	first := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		if err := s.st.Subscribe(ctx, me.ID, ch.ID, first.Add(time.Duration(i)*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	var at time.Time
	if err := s.pg.Pool.QueryRow(ctx, `SELECT count(*), min(subscribed_at) FROM media.subscriptions WHERE subscriber_id = $1`, me.ID).Scan(&n, &at); err != nil {
		t.Fatal(err)
	}
	if n != 1 || !at.Equal(first) {
		t.Fatalf("%d rows, subscribed_at %v (want the first event's %v)", n, at, first)
	}
	for i := 0; i < 3; i++ {
		if err := s.st.Unsubscribe(ctx, me.ID, ch.ID); err != nil {
			t.Fatal(err)
		}
	}
	_ = s.pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.subscriptions`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d rows", n)
	}
	// A channel cannot follow itself (the table refuses it, the consumer never sends it).
	if err := s.st.Subscribe(ctx, me.ID, me.ID, first); err == nil {
		t.Fatal("a self subscription was accepted")
	}
}

// Migration 000012 backfills media.subscriptions from social.subscriptions; re-running its statement (as after a
// partial run) changes nothing that is already there.
func TestMigrationBackfillCopiesSocialSubscriptions(t *testing.T) {
	s := startFeed(t)
	ctx := context.Background()
	raw, err := os.ReadFile(filepath.Join(testkit.RepoRoot(t), "db", "migrations", "000012_subscription_feed.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?s)INSERT INTO media\.subscriptions.*?ON CONFLICT DO NOTHING;`).Find(raw)
	if m == nil {
		t.Fatal("backfill statement not found in the migration")
	}
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	when := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	for _, p := range [][2]uuid.UUID{{a, b}, {a, c}, {b, c}} {
		if _, err := s.pg.Pool.Exec(ctx, `INSERT INTO social.subscriptions (subscriber_id, channel_id, created_at) VALUES ($1, $2, $3)`, p[0], p[1], when); err != nil {
			t.Fatal(err)
		}
	}
	// One pair is already there, with a later subscribed_at: it is kept.
	if _, err := s.pg.Pool.Exec(ctx, `INSERT INTO media.subscriptions (subscriber_id, channel_id, subscribed_at) VALUES ($1, $2, $3)`, a, b, when.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := s.pg.Pool.Exec(ctx, string(m)); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	var kept time.Time
	_ = s.pg.Pool.QueryRow(ctx, `SELECT count(*), max(subscribed_at) FILTER (WHERE subscriber_id = $1 AND channel_id = $2) FROM media.subscriptions`, a, b).Scan(&n, &kept)
	if n != 3 || !kept.Equal(when.Add(time.Hour)) {
		t.Fatalf("%d rows, kept %v", n, kept)
	}
}
