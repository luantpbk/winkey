package store_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/backfill"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

// seedReady makes a READY video through the legal status path with two renditions.
func seedReady(t *testing.T, pg *testkit.Postgres, createdAt time.Time, storyboard *string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	vid, _ := seed(t, pg, "UPLOADED")
	prefix := "v/" + vid.String() + "/a1/"
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET status = 'PROCESSING' WHERE id = $1`, vid); err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Pool.Exec(ctx, `
		UPDATE media.videos SET status = 'READY', duration_ms = 9000, width = 1280, height = 720,
			hls_master_key = $2, thumbnail_key = $3, storyboard_key = $4, published_at = now(), created_at = $5
		WHERE id = $1`, vid, prefix+"hls/master.m3u8", prefix+"thumb/poster.jpg", storyboard, createdAt); err != nil {
		t.Fatal(err)
	}
	for _, r := range []struct {
		name string
		w, h int
	}{{"720p", 1280, 720}, {"480p", 854, 480}} {
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO media.video_renditions (video_id, name, width, height, bitrate_kbps, playlist_key)
			VALUES ($1, $2, $3, $4, 1000, $5)`, vid, r.name, r.w, r.h, prefix+"hls/"+r.name+"/index.m3u8"); err != nil {
			t.Fatal(err)
		}
	}
	return vid
}

// The selection is READY and storyboard_key IS NULL only, newest first with id as tie-break, and
// keyset-paged: following the cursor visits every row once.
func TestSelectBackfillOrderAndPaging(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	base := time.Now().Truncate(time.Microsecond).Add(-24 * time.Hour)

	var want []uuid.UUID
	for i := range 7 {
		// i/2: pairs share created_at; the id decides inside a pair
		want = append(want, seedReady(t, pg, base.Add(time.Duration(i/2)*time.Minute), nil))
	}
	k := "v/x/a1/storyboard/storyboard.vtt"
	seedReady(t, pg, base.Add(time.Hour), &k) // has a storyboard: never selected
	for _, status := range []string{"UPLOADED", "PROCESSING"} {
		id, _ := seed(t, pg, "UPLOADED")
		if status == "PROCESSING" {
			if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET status = 'PROCESSING', created_at = $2 WHERE id = $1`, id, base.Add(2*time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
	}

	var got []backfill.Candidate
	var cur backfill.Cursor
	for {
		page, err := st.SelectBackfill(ctx, cur, 3)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, page...)
		if len(page) < 3 {
			break
		}
		last := page[len(page)-1]
		cur = backfill.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	if len(got) != len(want) {
		t.Fatalf("selected %d videos, want %d", len(got), len(want))
	}
	seen := map[uuid.UUID]bool{}
	for i, c := range got {
		if seen[c.ID] {
			t.Fatalf("video %s selected twice", c.ID)
		}
		seen[c.ID] = true
		if i > 0 {
			p := got[i-1]
			if c.CreatedAt.After(p.CreatedAt) || (c.CreatedAt.Equal(p.CreatedAt) && c.ID.String() > p.ID.String()) {
				t.Fatalf("row %d is not older than row %d (created_at DESC, id DESC)", i, i-1)
			}
		}
		if len(c.Renditions) != 2 || c.Renditions[0].Name != "720p" || c.PlaylistKeys["480p"] == "" || c.DurationMs != 9000 ||
			c.MasterKey != fmt.Sprintf("v/%s/a1/hls/master.m3u8", c.ID) {
			t.Fatalf("candidate %+v", c)
		}
	}
	for _, id := range want {
		if !seen[id] {
			t.Errorf("video %s missing", id)
		}
	}
}

func TestSetStoryboardKeyIsConditional(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	vid := seedReady(t, pg, time.Now(), nil)

	if ok, err := st.SetStoryboardKey(ctx, vid, "v/a/storyboard/storyboard.vtt"); err != nil || !ok {
		t.Fatalf("first set: %v %v", ok, err)
	}
	if ok, err := st.SetStoryboardKey(ctx, vid, "v/b/storyboard/storyboard.vtt"); err != nil || ok {
		t.Fatalf("a video that has a storyboard must not be overwritten: %v %v", ok, err)
	}
	var key string
	_ = pg.Pool.QueryRow(ctx, `SELECT storyboard_key FROM media.videos WHERE id = $1`, vid).Scan(&key)
	if key != "v/a/storyboard/storyboard.vtt" {
		t.Errorf("key = %s", key)
	}

	processing := seedReady(t, pg, time.Now(), nil)
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET status = 'PROCESSING' WHERE id = $1`, processing); err != nil { // re-encode
		t.Fatal(err)
	}
	if ok, err := st.SetStoryboardKey(ctx, processing, "k"); err != nil || ok {
		t.Fatalf("a video that is not READY must not be touched: %v %v", ok, err)
	}
	if ok, err := st.SetStoryboardKey(ctx, uuid.New(), "k"); err != nil || ok {
		t.Fatalf("a missing video: %v %v", ok, err)
	}
}
