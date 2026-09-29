package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

func setup(t *testing.T) (*Postgres, *testkit.Postgres) {
	t.Helper()
	pg := testkit.StartPostgres(t)
	return &Postgres{Pool: pg.Pool}, pg
}

func strp(s string) *string { return &s }

func TestGetVideo(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", strp("avatars/alice.jpg"), "")
	ghost := testutil.SeedUser(t, pg.Pool, "ghost", nil, "SUSPENDED")

	ready := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, ViewCount: 99, Renditions: []string{"480p", "1080p", "720p"}})
	proc := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Status: "PROCESSING", Visibility: "PRIVATE"})
	orphan := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: ghost.ID})

	v, err := st.GetVideo(ctx, ready.ID)
	if err != nil {
		t.Fatal(err)
	}
	if v.OwnerID != alice.ID || v.Title != ready.Title || v.Description != "about it" || v.Status != "READY" || v.Visibility != "PUBLIC" ||
		v.ViewCount != 99 || v.DurationMs == nil || *v.DurationMs != 61000 || *v.Width != 1920 || v.PublishedAt == nil ||
		v.HLSMasterKey == nil || v.ThumbnailKey == nil {
		t.Fatalf("video: %+v", v)
	}
	if v.Owner.Missing || v.Owner.Handle != "alice" || v.Owner.DisplayName != alice.Name || v.Owner.AvatarKey == nil || *v.Owner.AvatarKey != "avatars/alice.jpg" {
		t.Fatalf("owner: %+v", v.Owner)
	}
	var names []string
	for _, r := range v.Renditions {
		names = append(names, r.Name)
	}
	if strings.Join(names, ",") != "1080p,720p,480p" { // highest first, whatever the insert order
		t.Fatalf("renditions %v", names)
	}

	p, err := st.GetVideo(ctx, proc.ID)
	if err != nil || p.Status != "PROCESSING" || p.DurationMs != nil || p.PublishedAt != nil || p.HLSMasterKey != nil ||
		len(p.Renditions) != 0 || p.Renditions == nil {
		t.Fatalf("processing: %+v %v", p, err)
	}
	// An owner who is not ACTIVE has no row in auth.public_profiles.
	o, err := st.GetVideo(ctx, orphan.ID)
	if err != nil || !o.Owner.Missing || o.OwnerID != ghost.ID {
		t.Fatalf("suspended owner: %+v %v", o.Owner, err)
	}
	if _, err := st.GetVideo(ctx, uuid.New()); err != domain.ErrNotFound {
		t.Fatalf("missing: %v", err)
	}
}

func TestFeedFiltersAndOrder(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", strp("a.jpg"), "")
	bob := testutil.SeedUser(t, pg.Pool, "bobby", nil, "")
	ghost := testutil.SeedUser(t, pg.Pool, "ghost", nil, "SUSPENDED")
	base := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)

	v1 := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Published: base.Add(1 * time.Minute)})
	testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Visibility: "UNLISTED", Published: base.Add(2 * time.Minute)})
	testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Visibility: "PRIVATE", Published: base.Add(3 * time.Minute)})
	testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Status: "PROCESSING"})
	testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Status: "FAILED"})
	testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: ghost.ID, Published: base.Add(4 * time.Minute)})
	v2 := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: bob.ID, Published: base.Add(5 * time.Minute)})

	got, err := st.ListFeed(ctx, domain.FeedQuery{Limit: 50})
	if err != nil || len(got) != 2 || got[0].ID != v2.ID || got[1].ID != v1.ID {
		t.Fatalf("feed: %+v %v", got, err)
	}
	if got[0].Owner.Handle != "bobby" || got[0].Owner.AvatarKey != nil || got[1].Owner.AvatarKey == nil || got[1].DurationMs != 61000 ||
		got[0].ThumbnailKey == "" || !got[0].PublishedAt.Equal(base.Add(5*time.Minute)) {
		t.Fatalf("fields: %+v", got)
	}
	if got, _ = st.ListFeed(ctx, domain.FeedQuery{OwnerID: &alice.ID, Limit: 50}); len(got) != 1 || got[0].ID != v1.ID {
		t.Fatalf("owner filter: %+v", got)
	}
	if got, _ = st.ListFeed(ctx, domain.FeedQuery{OwnerID: &ghost.ID, Limit: 50}); len(got) != 0 {
		t.Fatalf("suspended owner listed: %+v", got)
	}
	if got, _ = st.ListFeed(ctx, domain.FeedQuery{Limit: 1}); len(got) != 1 {
		t.Fatalf("limit: %d", len(got))
	}
}

// Keyset pagination across equal timestamps, with microsecond precision, must
// return every video exactly once, in (published_at DESC, id DESC) order.
func TestFeedKeysetAcrossEqualTimestamps(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	same := time.Date(2026, 10, 1, 8, 0, 0, 123456000, time.UTC) // microsecond part must survive the round trip
	other := same.Add(-time.Second)
	want := map[uuid.UUID]bool{}
	for i := 0; i < 13; i++ {
		ts := same
		if i%4 == 3 {
			ts = other
		}
		want[testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Published: ts}).ID] = true
	}

	var all []domain.Summary
	var after *domain.Position
	for page := 0; page < 10; page++ {
		rows, err := st.ListFeed(ctx, domain.FeedQuery{After: after, Limit: 5 + 1})
		if err != nil {
			t.Fatal(err)
		}
		n := min(len(rows), 5)
		all = append(all, rows[:n]...)
		if len(rows) <= 5 {
			break
		}
		after = &domain.Position{T: rows[n-1].PublishedAt, ID: rows[n-1].ID}
	}
	if len(all) != 13 {
		t.Fatalf("got %d videos, want 13", len(all))
	}
	for i, s := range all {
		if !want[s.ID] {
			t.Errorf("unexpected or duplicate video %s", s.ID)
		}
		delete(want, s.ID)
		if i > 0 {
			p := all[i-1]
			if s.PublishedAt.After(p.PublishedAt) || (s.PublishedAt.Equal(p.PublishedAt) && s.ID.String() > p.ID.String()) {
				t.Errorf("order broken at %d", i)
			}
		}
	}
	if len(want) != 0 {
		t.Errorf("%d videos never returned", len(want))
	}
}

func TestStudio(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	bob := testutil.SeedUser(t, pg.Pool, "bobby", nil, "")
	base := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)

	up := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Status: "UPLOADING", Visibility: "PRIVATE", Created: base.Add(1 * time.Minute)})
	proc := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Status: "PROCESSING", Created: base.Add(2 * time.Minute), Attempts: []float32{100, 33.5}})
	failed := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Status: "FAILED", Error: "The video could not be encoded.", Created: base.Add(3 * time.Minute), Attempts: []float32{10}})
	ready := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Created: base.Add(4 * time.Minute), Attempts: []float32{100}})
	testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: bob.ID, Created: base.Add(5 * time.Minute)})

	rows, err := st.ListStudio(ctx, domain.StudioQuery{UserID: alice.ID, Limit: 50})
	if err != nil || len(rows) != 4 {
		t.Fatalf("%d rows, %v", len(rows), err)
	}
	if rows[0].ID != ready.ID || rows[1].ID != failed.ID || rows[2].ID != proc.ID || rows[3].ID != up.ID {
		t.Fatalf("order: %v", []uuid.UUID{rows[0].ID, rows[1].ID, rows[2].ID, rows[3].ID})
	}
	by := map[uuid.UUID]domain.StudioItem{}
	for _, r := range rows {
		by[r.ID] = r
	}
	if p := by[proc.ID]; p.Progress != 33.5 || p.Status != "PROCESSING" || p.ThumbnailKey != nil || p.DurationMs != nil {
		t.Fatalf("progress must come from the latest attempt: %+v", p)
	}
	if f := by[failed.ID]; f.Error == nil || *f.Error != "The video could not be encoded." || f.Progress != 10 {
		t.Fatalf("failed: %+v", f)
	}
	if r := by[ready.ID]; r.ThumbnailKey == nil || r.DurationMs == nil || r.Visibility != "PUBLIC" {
		t.Fatalf("ready: %+v", r)
	}
	if u := by[up.ID]; u.Progress != 0 || u.Visibility != "PRIVATE" || u.Status != "UPLOADING" {
		t.Fatalf("uploading: %+v", u)
	}

	if rows, _ = st.ListStudio(ctx, domain.StudioQuery{UserID: alice.ID, Status: "PROCESSING", Limit: 50}); len(rows) != 1 || rows[0].ID != proc.ID {
		t.Fatalf("status filter: %+v", rows)
	}
	// keyset: page of 2, then the rest
	page1, _ := st.ListStudio(ctx, domain.StudioQuery{UserID: alice.ID, Limit: 2})
	page2, _ := st.ListStudio(ctx, domain.StudioQuery{UserID: alice.ID, Limit: 50,
		After: &domain.Position{T: page1[1].CreatedAt, ID: page1[1].ID}})
	if len(page1) != 2 || len(page2) != 2 || page2[0].ID != proc.ID || page2[1].ID != up.ID {
		t.Fatalf("paging: %d + %d", len(page1), len(page2))
	}
}

// The queries must be able to use the indexes the schema provides for them.
func TestQueriesUseTheirIndexes(t *testing.T) {
	_, pg := setup(t)
	ctx := context.Background()
	explain := func(sql string, args []any) string {
		t.Helper()
		tx, err := pg.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan = off`); err != nil { // the tables are tiny: force the choice
			t.Fatal(err)
		}
		rows, err := tx.Query(ctx, "EXPLAIN "+sql, args...)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var sb strings.Builder
		for rows.Next() {
			var line string
			_ = rows.Scan(&line)
			sb.WriteString(line + "\n")
		}
		return sb.String()
	}
	pos := &domain.Position{T: time.Now(), ID: uuid.New()}
	owner := uuid.New()

	sql, args := feedSQL(domain.FeedQuery{After: pos, Limit: 25})
	if plan := explain(sql, args); !strings.Contains(plan, "videos_public_feed") {
		t.Errorf("feed does not use videos_public_feed:\n%s", plan)
	}
	sql, args = studioSQL(domain.StudioQuery{UserID: owner, After: pos, Limit: 25})
	if plan := explain(sql, args); !strings.Contains(plan, "videos_owner_created") {
		t.Errorf("studio does not use videos_owner_created:\n%s", plan)
	}
	sql, args = studioSQL(domain.StudioQuery{UserID: owner, Status: "READY", Limit: 25})
	if plan := explain(sql, args); !strings.Contains(plan, "videos_owner_created") {
		t.Errorf("studio with a status filter does not use videos_owner_created:\n%s", plan)
	}
}

func TestUpdateVideo(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	bob := testutil.SeedUser(t, pg.Pool, "bobby", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID})

	if _, err := st.UpdateVideo(ctx, v.ID, bob.ID, domain.Update{Title: strp("hijacked")}); err != domain.ErrNotFound {
		t.Fatalf("other owner: %v", err)
	}
	if _, err := st.UpdateVideo(ctx, uuid.New(), alice.ID, domain.Update{Title: strp("x")}); err != domain.ErrNotFound {
		t.Fatalf("unknown: %v", err)
	}
	got, _ := st.GetVideo(ctx, v.ID)
	if got.Title != v.Title {
		t.Fatalf("rejected update changed the title to %q", got.Title)
	}

	// Partial update: only the given fields change; an empty description is a real value.
	u, err := st.UpdateVideo(ctx, v.ID, alice.ID, domain.Update{Title: strp("New"), Description: strp("")})
	if err != nil || u.Title != "New" || u.Description != "" || u.Visibility != "PUBLIC" || len(u.Renditions) != 3 {
		t.Fatalf("%+v %v", u, err)
	}
	u, err = st.UpdateVideo(ctx, v.ID, alice.ID, domain.Update{Visibility: strp("UNLISTED")})
	if err != nil || u.Title != "New" || u.Visibility != "UNLISTED" {
		t.Fatalf("%+v %v", u, err)
	}
	var updatedAt, createdAt time.Time
	_ = pg.Pool.QueryRow(ctx, `SELECT updated_at, created_at FROM media.videos WHERE id=$1`, v.ID).Scan(&updatedAt, &createdAt)
	if !updatedAt.After(createdAt) {
		t.Error("updated_at was not bumped")
	}
}

func TestDeleteVideoCascadesAndEnqueuesOneEvent(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Attempts: []float32{100, 100}})
	other := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID})
	count := func(q string, args ...any) int {
		var n int
		if err := pg.Pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count(`SELECT count(*) FROM media.video_renditions WHERE video_id=$1`, v.ID) != 3 || count(`SELECT count(*) FROM media.transcode_jobs WHERE video_id=$1`, v.ID) != 2 {
		t.Fatal("fixture")
	}

	deleted, err := st.DeleteVideo(ctx, v.ID, "winkey-media")
	if err != nil || !deleted {
		t.Fatalf("%v %v", deleted, err)
	}
	if count(`SELECT count(*) FROM media.videos WHERE id=$1`, v.ID) != 0 ||
		count(`SELECT count(*) FROM media.video_renditions WHERE video_id=$1`, v.ID) != 0 ||
		count(`SELECT count(*) FROM media.transcode_jobs WHERE video_id=$1`, v.ID) != 0 {
		t.Fatal("row, renditions or jobs survived the delete")
	}
	if count(`SELECT count(*) FROM media.videos WHERE id=$1`, other.ID) != 1 {
		t.Fatal("another video was deleted")
	}

	var payload []byte
	if n := count(`SELECT count(*) FROM media.outbox`); n != 1 {
		t.Fatalf("%d outbox rows, want exactly 1", n)
	}
	if err := pg.Pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject='video.deleted'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var env struct {
		Type     string
		Version  int
		Producer string
		EventID  string `json:"event_id"`
		Data     domain.DeletedEvent
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		t.Fatal(err)
	}
	want := domain.DeletedEvent{
		VideoID: v.ID.String(), OwnerID: alice.ID.String(), RawBucket: "winkey-raw", RawKey: v.RawKey,
		MediaBucket: "winkey-media", MediaPrefix: "v/" + v.ID.String() + "/",
	}
	if env.Type != "video.deleted" || env.Version != 1 || env.Data != want {
		t.Fatalf("event: %s", payload)
	}
	if _, err := uuid.Parse(env.EventID); err != nil {
		t.Fatal(err)
	}

	// Deleting again (or something that never existed) deletes nothing and emits nothing.
	for _, id := range []uuid.UUID{v.ID, uuid.New()} {
		if deleted, err := st.DeleteVideo(ctx, id, "winkey-media"); err != nil || deleted {
			t.Fatalf("%v %v", deleted, err)
		}
	}
	if count(`SELECT count(*) FROM media.outbox`) != 1 {
		t.Fatal("a no-op delete wrote an event")
	}
}

// The row delete and the event are one transaction: if the event cannot be
// written, the video must still exist.
func TestDeleteVideoIsAtomic(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID})
	if _, err := pg.Pool.Exec(ctx, `ALTER TABLE media.outbox ADD CONSTRAINT outbox_reject_all CHECK (false) NOT VALID`); err != nil {
		t.Fatal(err)
	}
	if deleted, err := st.DeleteVideo(ctx, v.ID, "winkey-media"); err == nil || deleted {
		t.Fatalf("expected the delete to fail: %v %v", deleted, err)
	}
	if _, err := st.GetVideo(ctx, v.ID); err != nil {
		t.Fatalf("the video was deleted although its event could not be written: %v", err)
	}
}

func TestSetLikeCount(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID})
	other := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID})
	likeCount := func(id uuid.UUID) (n int64, updated time.Time) {
		if err := pg.Pool.QueryRow(ctx, `SELECT like_count, updated_at FROM media.videos WHERE id=$1`, id).Scan(&n, &updated); err != nil {
			t.Fatal(err)
		}
		return
	}

	// Absolute: sets, raises, and lowers (an un-like), never accumulates.
	for _, want := range []int64{5, 42, 41, 0, 9007199254740993} {
		changed, err := st.SetLikeCount(ctx, v.ID, want)
		if err != nil || !changed {
			t.Fatalf("set %d: changed=%v err=%v", want, changed, err)
		}
		if got, _ := likeCount(v.ID); got != want {
			t.Fatalf("like_count %d, want %d", got, want)
		}
	}
	// The same value again is a no-op that writes nothing (updated_at stays).
	_, before := likeCount(v.ID)
	time.Sleep(10 * time.Millisecond)
	if changed, err := st.SetLikeCount(ctx, v.ID, 9007199254740993); err != nil || changed {
		t.Fatalf("repeat: changed=%v err=%v", changed, err)
	}
	if _, after := likeCount(v.ID); !after.Equal(before) {
		t.Fatal("a redelivered event rewrote the row")
	}
	// Other videos are untouched; an unknown video is not an error.
	if n, _ := likeCount(other.ID); n != 0 {
		t.Fatalf("another video changed: %d", n)
	}
	if changed, err := st.SetLikeCount(ctx, uuid.New(), 3); err != nil || changed {
		t.Fatalf("unknown video: changed=%v err=%v", changed, err)
	}
	// The database refuses negative counts (the consumer rejects them before this point).
	if _, err := st.SetLikeCount(ctx, v.ID, -1); err == nil {
		t.Fatal("a negative like_count was accepted")
	}
	// The feed reads the stored value.
	rows, _ := st.ListFeed(ctx, domain.FeedQuery{Limit: 10})
	if len(rows) != 2 {
		t.Fatalf("feed: %d", len(rows))
	}
	got, _ := st.GetVideo(ctx, v.ID)
	if got.LikeCount != 9007199254740993 {
		t.Fatalf("GetVideo like_count %d", got.LikeCount)
	}
}
