package store

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// SOC-2b: purpose is read, social videos stay out of Studio and the admin list, the post events attach/release
// only the author's own SOCIAL video, and the janitor deletes only expired unattached ones.
func TestSocialVideos(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	bob := testutil.SeedUser(t, pg.Pool, "bob", nil, "")
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pg.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pg.Pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// social seeds a SOCIAL video of owner created and (when READY) published age ago.
	social := func(owner uuid.UUID, status string, age time.Duration) uuid.UUID {
		t.Helper()
		v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner, Status: status, Visibility: "UNLISTED"})
		at := time.Now().Add(-age)
		exec(`UPDATE media.videos SET purpose = 'SOCIAL', created_at = $2::timestamptz,
			published_at = CASE WHEN status = 'READY' THEN $2::timestamptz END WHERE id = $1`, v.ID, at)
		return v.ID
	}
	film := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID}).ID
	fresh := social(alice.ID, "READY", time.Hour)

	t.Run("purpose and listings", func(t *testing.T) {
		v, err := st.GetVideo(ctx, fresh)
		if err != nil || v.Purpose != domain.PurposeSocial || !v.Social() {
			t.Fatalf("social: %+v %v", v.Purpose, err)
		}
		if v, err := st.GetVideo(ctx, film); err != nil || v.Purpose != domain.PurposeFilm {
			t.Fatalf("film: %q %v", v.Purpose, err)
		}
		if vs, err := st.VideosByID(ctx, []uuid.UUID{fresh}); err != nil || len(vs) != 1 || vs[0].Purpose != domain.PurposeSocial {
			t.Fatalf("by id: %+v %v", vs, err)
		}
		studio, err := st.ListStudio(ctx, domain.StudioQuery{UserID: alice.ID, Limit: 50})
		if err != nil || len(studio) != 1 || studio[0].ID != film {
			t.Fatalf("studio %+v %v; want only the film", studio, err)
		}
		admin, err := st.ListAdminVideos(ctx, domain.AdminVideoQuery{Limit: 50})
		if err != nil || len(admin) != 1 || admin[0].ID != film {
			t.Fatalf("admin %+v %v; want only the film", admin, err)
		}
	})

	t.Run("attach", func(t *testing.T) {
		for _, c := range []struct {
			name          string
			video, author uuid.UUID
			want          bool
		}{
			{"someone else's", fresh, bob.ID, false},
			{"a film", film, alice.ID, false},
			{"unknown", uuid.New(), alice.ID, false},
			{"own social", fresh, alice.ID, true},
			{"again (idempotent)", fresh, alice.ID, true},
		} {
			if found, err := st.AttachSocialVideo(ctx, c.video, c.author); err != nil || found != c.want {
				t.Fatalf("%s: found=%v err=%v", c.name, found, err)
			}
		}
		var first time.Time
		if err := pg.Pool.QueryRow(ctx, `SELECT attached_at FROM media.videos WHERE id = $1`, fresh).Scan(&first); err != nil {
			t.Fatal(err)
		}
		if _, err := st.AttachSocialVideo(ctx, fresh, alice.ID); err != nil {
			t.Fatal(err)
		}
		if count(`SELECT count(*) FROM media.videos WHERE id = $1 AND attached_at = $2`, fresh, first) != 1 {
			t.Fatal("a second attach moved attached_at")
		}
		if count(`SELECT count(*) FROM media.videos WHERE id = $1 AND attached_at IS NOT NULL`, film) != 0 {
			t.Fatal("a film got attached_at")
		}
	})

	t.Run("janitor", func(t *testing.T) {
		exec(`DELETE FROM media.outbox`)
		oldReady := social(alice.ID, "READY", 49*time.Hour)
		oldFailed := social(alice.ID, "FAILED", 49*time.Hour)
		youngReady := social(alice.ID, "READY", 47*time.Hour)
		processing := social(alice.ID, "PROCESSING", 72*time.Hour) // still encoding: never touched
		oldAttached := social(bob.ID, "READY", 72*time.Hour)
		exec(`UPDATE media.videos SET attached_at = now() WHERE id = $1`, oldAttached)
		// Uploaded long ago but READY only recently: the 48 hours count from READY.
		lateReady := social(bob.ID, "READY", 72*time.Hour)
		exec(`UPDATE media.videos SET published_at = now() - interval '1 hour' WHERE id = $1`, lateReady)
		exec(`UPDATE media.videos SET created_at = now() - interval '100 hours' WHERE id = $1`, film)

		var deleted []uuid.UUID
		for {
			ids, err := st.DeleteUnattachedSocialVideos(ctx, 48*time.Hour, 1, "winkey-media")
			if err != nil {
				t.Fatal(err)
			}
			if len(ids) == 0 {
				break
			}
			deleted = append(deleted, ids...)
		}
		slices.SortFunc(deleted, func(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) })
		want := []uuid.UUID{oldReady, oldFailed}
		slices.SortFunc(want, func(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) })
		if !slices.Equal(deleted, want) {
			t.Fatalf("deleted %v, want %v", deleted, want)
		}
		for _, id := range []uuid.UUID{youngReady, processing, oldAttached, lateReady, film, fresh} {
			if count(`SELECT count(*) FROM media.videos WHERE id = $1`, id) != 1 {
				t.Fatalf("%s was deleted", id)
			}
		}
		if n := count(`SELECT count(*) FROM media.outbox WHERE subject = 'video.deleted'`); n != 2 {
			t.Fatalf("%d video.deleted events, want 2", n)
		}
	})

	t.Run("release", func(t *testing.T) {
		exec(`DELETE FROM media.outbox`)
		for _, c := range []struct {
			name          string
			video, author uuid.UUID
			want          bool
		}{
			{"someone else's", fresh, bob.ID, false},
			{"a film", film, alice.ID, false},
			{"own social", fresh, alice.ID, true},
			{"again (idempotent)", fresh, alice.ID, false},
		} {
			if deleted, err := st.ReleaseSocialVideo(ctx, c.video, c.author, "winkey-media"); err != nil || deleted != c.want {
				t.Fatalf("%s: deleted=%v err=%v", c.name, deleted, err)
			}
		}
		if count(`SELECT count(*) FROM media.videos WHERE id = $1`, fresh) != 0 || count(`SELECT count(*) FROM media.videos WHERE id = $1`, film) != 1 {
			t.Fatal("release deleted the wrong rows")
		}
		if n := count(`SELECT count(*) FROM media.outbox WHERE subject = 'video.deleted' AND payload->'data'->>'video_id' = $1`, fresh.String()); n != 1 {
			t.Fatalf("%d video.deleted events for the released video, want 1", n)
		}
		if n := count(`SELECT count(*) FROM media.outbox`); n != 1 {
			t.Fatalf("%d outbox rows, want 1", n)
		}
	})
}
