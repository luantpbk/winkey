package store_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

func TestBeginReencode(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}

	vid, owner := seed(t, pg, "UPLOADED")
	encode(t, st, vid, owner, nil)
	if _, ok, err := st.CommitAV1(ctx, av1Commit(vid, "r1"), nil); err != nil || !ok {
		t.Fatalf("av1: %v %v", ok, err)
	}
	other, o2 := seed(t, pg, "UPLOADED") // stays UPLOADED: never selected
	_ = o2

	cands, err := st.SelectReencode(ctx, nil)
	if err != nil || len(cands) != 1 || cands[0].ID != vid || cands[0].MasterKey == "" {
		t.Fatalf("select: %+v %v", cands, err)
	}
	if c, _ := st.SelectReencode(ctx, []uuid.UUID{other}); len(c) != 0 {
		t.Fatalf("select by id of a non-READY video: %+v", c)
	}

	ev, av1Prefix, ok, err := st.BeginReencode(ctx, vid)
	if err != nil || !ok || ev.VideoID != vid.String() || ev.OwnerID != owner.String() || ev.RawKey == "" || ev.SizeBytes <= 0 ||
		ev.ContentType == "" || av1Prefix != "v/"+vid.String()+"/av1/" {
		t.Fatalf("begin: %+v %q %v %v", ev, av1Prefix, ok, err)
	}
	var status string
	var av1 *string
	var av1Rows int
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text, hls_av1_master_key FROM media.videos WHERE id = $1`, vid).Scan(&status, &av1)
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.video_renditions WHERE video_id = $1 AND codec = 'av1'`, vid).Scan(&av1Rows)
	if status != "PROCESSING" || av1 != nil || av1Rows != 0 {
		t.Fatalf("after begin: %s %v av1 rows %d", status, av1, av1Rows)
	}
	// Not READY any more: a second call does nothing, and the normal pipeline can take the video.
	if _, _, ok, err := st.BeginReencode(ctx, vid); err != nil || ok {
		t.Fatalf("second begin: %v %v", ok, err)
	}
	second := encode(t, st, vid, owner, nil)
	if second.Attempt != 2 {
		t.Fatalf("re-encode attempt %d", second.Attempt)
	}
}
