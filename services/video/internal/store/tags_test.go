package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

func setTags(t *testing.T, pool *pgxpool.Pool, id uuid.UUID, tags ...string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE media.videos SET tags = $2 WHERE id = $1`, id, tags); err != nil {
		t.Fatal(err)
	}
}

// Task SEO2: the slugs come from the generated column (migration 000021); the store only filters and aggregates.
func TestTagsFeedListAndGet(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	bob := testutil.SeedUser(t, pg.Pool, "bobby", nil, "")
	ghost := testutil.SeedUser(t, pg.Pool, "ghost", nil, "SUSPENDED")
	base := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)

	v1 := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Published: base.Add(1 * time.Minute)})
	v2 := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: bob.ID, Published: base.Add(2 * time.Minute)})
	v3 := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Published: base.Add(3 * time.Minute)})
	priv := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Visibility: "PRIVATE", Published: base.Add(4 * time.Minute)})
	gone := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: ghost.ID, Published: base.Add(5 * time.Minute)})
	setTags(t, pg.Pool, v1.ID, "Phim ngắn", "Dân gian")
	setTags(t, pg.Pool, v2.ID, "phim  NGẮN", "!!!")
	setTags(t, pg.Pool, v3.ID, "phim ngắn", "Du lịch")
	setTags(t, pg.Pool, priv.ID, "Ẩm thực", "Phim ngắn")
	setTags(t, pg.Pool, gone.ID, "Phim ngắn")

	// GetVideo returns the slugs aligned with the tags ('' for the punctuation-only tag).
	v, err := st.GetVideo(ctx, v2.ID)
	if err != nil || len(v.TagSlugs) != 2 || v.TagSlugs[0] != "phim-ngan" || v.TagSlugs[1] != "" {
		t.Fatalf("GetVideo slugs: %q %v", v.TagSlugs, err)
	}
	u, err := st.UpdateVideo(ctx, v3.ID, alice.ID, domain.Update{Tags: &[]string{"Hà Nội"}})
	if err != nil || len(u.TagSlugs) != 1 || u.TagSlugs[0] != "ha-noi" {
		t.Fatalf("UpdateVideo slugs: %q %v", u.TagSlugs, err)
	}
	setTags(t, pg.Pool, v3.ID, "phim ngắn", "Du lịch")

	// The feed filtered by slug or text: public, owner active, newest first.
	for _, tag := range []string{"phim-ngan", "Phim Ngắn"} {
		got, err := st.ListFeed(ctx, domain.FeedQuery{Tag: tag, Limit: 50})
		if err != nil || len(got) != 3 || got[0].ID != v3.ID || got[1].ID != v2.ID || got[2].ID != v1.ID {
			t.Fatalf("%q: %+v %v", tag, got, err)
		}
	}
	if got, _ := st.ListFeed(ctx, domain.FeedQuery{Tag: "phim-ngan", OwnerID: &bob.ID, Limit: 50}); len(got) != 1 || got[0].ID != v2.ID {
		t.Fatalf("tag+owner: %+v", got)
	}
	if got, _ := st.ListFeed(ctx, domain.FeedQuery{Tag: "!!!", Limit: 50}); len(got) != 0 {
		t.Fatalf("empty slug matched: %+v", got)
	}
	after := &domain.Position{T: base.Add(3 * time.Minute), ID: v3.ID}
	if got, _ := st.ListFeed(ctx, domain.FeedQuery{Tag: "phim-ngan", After: after, Limit: 1}); len(got) != 1 || got[0].ID != v2.ID {
		t.Fatalf("keyset: %+v", got)
	}

	// ListTags: count of public videos, most used spelling (tie → alphabetical), no private/suspended/empty slugs.
	tags, err := st.ListTags(ctx, 100, 1)
	if err != nil || len(tags) != 3 {
		t.Fatalf("ListTags: %+v %v", tags, err)
	}
	if tags[0].Slug != "phim-ngan" || tags[0].VideoCount != 3 || tags[0].Name != "Phim ngắn" ||
		!tags[0].LatestPublishedAt.Equal(base.Add(3*time.Minute)) {
		t.Fatalf("top tag: %+v", tags[0])
	}
	if tags[1].Slug != "dan-gian" || tags[2].Slug != "du-lich" || tags[1].Name != "Dân gian" {
		t.Fatalf("order: %+v", tags)
	}
	if got, _ := st.ListTags(ctx, 100, 2); len(got) != 1 {
		t.Fatalf("min_videos: %+v", got)
	}
	if got, _ := st.ListTags(ctx, 1, 1); len(got) != 1 {
		t.Fatalf("limit: %+v", got)
	}

	// GetTag resolves text to the canonical slug; unknown, private-only and empty slugs are ErrNotFound.
	got, err := st.GetTag(ctx, "PHIM NGẮN")
	if err != nil || got.Slug != "phim-ngan" || got.VideoCount != 3 {
		t.Fatalf("GetTag: %+v %v", got, err)
	}
	for _, in := range []string{"am-thuc", "khong-co", "!!!"} {
		if _, err := st.GetTag(ctx, in); !errors.Is(err, domain.ErrNotFound) {
			t.Errorf("%q: %v", in, err)
		}
	}
}
