package storagegc

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/testkit"
)

// Real PostgreSQL: which images are in use (profiles, posts) and which rows DeleteUnreferencedImages removes,
// with and without read access to social.post_media (the media_svc grant of SOC-2a).
func TestUnreferencedImagesRealPostgres(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	user := uuid.MustParse("0192f5e0-0000-7000-8000-0000000000c1")
	img := func(n int) uuid.UUID {
		return uuid.MustParse("019a2f10-0000-7000-8000-0000000000c" + string(rune('0'+n)))
	}
	key := func(id uuid.UUID) string { return "i/" + user.String() + "/" + id.String() + "/image.webp" }
	avatarUsed, avatarOld, postUsed, postUnused := img(1), img(2), img(3), img(4)

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pg.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(`INSERT INTO auth.users (id, email, handle, display_name) VALUES ($1, 'gc@example.com', 'gc_user', 'GC')`, user)
	for id, purpose := range map[uuid.UUID]string{avatarUsed: "AVATAR", avatarOld: "AVATAR", postUsed: "POST", postUnused: "POST"} {
		exec(`INSERT INTO media.images (id, owner_id, purpose, status, content_type, size_bytes, raw_bucket, raw_key,
			image_key, thumb_key, width, height, output_bytes)
			VALUES ($1, $2, $3, 'READY', 'image/jpeg', 100, 'raw', 'k', $4, $4 || '.thumb', 10, 10, 50)`,
			id, user, purpose, key(id))
	}
	exec(`UPDATE auth.users SET avatar_key = $1 WHERE id = $2`, key(avatarUsed), user)
	post := uuid.MustParse("019a2f10-0000-7000-8000-0000000000d1")
	exec(`INSERT INTO social.posts (id, author_id, media_count) VALUES ($1, $2, 1)`, post, user)
	exec(`INSERT INTO social.post_media (post_id, position, image_id, image_key, thumb_key, width, height)
		VALUES ($1, 0, $2, $3, $3 || '.thumb', 10, 10)`, post, postUsed, key(postUsed))
	all := []uuid.UUID{avatarUsed, avatarOld, postUsed, postUnused}

	t.Run("post refs readable", func(t *testing.T) {
		_, inUse, known, err := loadImages(ctx, pg.Pool)
		if err != nil || !known {
			t.Fatalf("loadImages: known=%v err=%v", known, err)
		}
		if !inUse[key(avatarUsed)] || !inUse[key(postUsed)] || inUse[key(avatarOld)] || inUse[key(postUnused)] {
			t.Fatalf("in use = %v", inUse)
		}
	})

	t.Run("post refs not granted", func(t *testing.T) {
		// A role like media_svc before the SOC-2a grant: it reads media and auth.public_profiles, not social.
		exec(`CREATE ROLE gc_test NOLOGIN`)
		exec(`GRANT USAGE ON SCHEMA media, auth TO gc_test`)
		exec(`GRANT SELECT, DELETE ON media.images TO gc_test`)
		exec(`GRANT SELECT ON auth.public_profiles TO gc_test`)
		limited := rolePool(t, pg.URL, "gc_test")
		_, inUse, known, err := loadImages(ctx, limited)
		if err != nil || known {
			t.Fatalf("loadImages without the grant must fall back: known=%v err=%v", known, err)
		}
		if !inUse[key(avatarUsed)] {
			t.Fatal("profile keys must still load")
		}
		// Without post refs only the replaced avatar may go; both POST images stay.
		deleted, err := DeleteUnreferencedImages(ctx, limited, all, false)
		if err != nil || len(deleted) != 1 || deleted[0] != avatarOld {
			t.Fatalf("deleted %v, err %v; want only the replaced avatar", deleted, err)
		}
	})

	t.Run("delete with post refs", func(t *testing.T) {
		deleted, err := DeleteUnreferencedImages(ctx, pg.Pool, all, true)
		if err != nil || len(deleted) != 1 || deleted[0] != postUnused {
			t.Fatalf("deleted %v, err %v; want only the unused post image", deleted, err)
		}
		var left int
		if err := pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.images WHERE id = ANY($1)`, all).Scan(&left); err != nil || left != 2 {
			t.Fatalf("%d image rows left (%v), want the used avatar and the used post image", left, err)
		}
	})
}

// rolePool opens a pool whose connections run as role (the test user is a superuser and may SET ROLE).
func rolePool(t *testing.T, url, role string) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, err := c.Exec(ctx, "SET ROLE "+pgx.Identifier{role}.Sanitize())
		return err
	}
	p, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}
