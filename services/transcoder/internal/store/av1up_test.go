package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/av1up"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

// starts records playback starts of a video daysAgo Asia/Ho_Chi_Minh days before today.
func starts(t *testing.T, pg *testkit.Postgres, vid, owner uuid.UUID, daysAgo int, n int64) {
	t.Helper()
	if _, err := pg.Pool.Exec(context.Background(), `
		INSERT INTO analytics.video_daily (video_id, owner_id, day, starts, watched_ms, rebuffer_ms, errors, viewers, refreshed_at)
		VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - $3::int, $4, 0, 0, 0, 0, now())`,
		vid, owner, daysAgo, n); err != nil {
		t.Fatal(err)
	}
}

func av1Commit(vid uuid.UUID, run string) av1up.Commit {
	prefix := "v/" + vid.String() + "/av1/" + run + "/"
	c := av1up.Commit{VideoID: vid, MasterKey: prefix + "master.m3u8"}
	for _, r := range media.Select(1280, 720) {
		r.TargetK = r.TargetK * 85 / 100
		c.Renditions = append(c.Renditions, r)
		c.PlaylistKeys = append(c.PlaylistKeys, prefix+r.Name+"/index.m3u8")
	}
	return c
}

func TestSelectAV1(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}

	hot, owner := seed(t, pg, "UPLOADED")
	encode(t, st, hot, owner, nil)
	starts(t, pg, hot, owner, 0, 40)
	starts(t, pg, hot, owner, 6, 40) // still inside the 7-day window
	starts(t, pg, hot, owner, 7, 1000)

	warm, o2 := seed(t, pg, "UPLOADED")
	encode(t, st, warm, o2, nil)
	starts(t, pg, warm, o2, 1, 60)

	cold, o3 := seed(t, pg, "UPLOADED") // only old starts
	encode(t, st, cold, o3, nil)
	starts(t, pg, cold, o3, 8, 5000)

	processing, o4 := seed(t, pg, "UPLOADED") // not READY
	starts(t, pg, processing, o4, 0, 5000)

	done, o5 := seed(t, pg, "UPLOADED") // already has an AV1 set
	encode(t, st, done, o5, nil)
	starts(t, pg, done, o5, 0, 5000)
	if _, ok, err := st.CommitAV1(ctx, av1Commit(done, "r1"), nil); err != nil || !ok {
		t.Fatalf("commit: %v %v", ok, err)
	}

	cands, err := st.SelectAV1(ctx, 50, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 2 || cands[0].ID != hot || cands[0].Starts7d != 80 || cands[1].ID != warm || cands[1].Starts7d != 60 {
		t.Fatalf("candidates %+v", cands)
	}
	c := cands[0]
	if c.RawBucket == "" || c.RawKey == "" || len(c.H264Names) != 2 || c.H264Names[0] != "720p" || c.H264Names[1] != "480p" {
		t.Fatalf("candidate %+v", c)
	}
	if cands, _ := st.SelectAV1(ctx, 50, 1); len(cands) != 1 || cands[0].ID != hot {
		t.Fatalf("limit: %+v", cands)
	}
	if cands, _ := st.SelectAV1(ctx, 81, 10); len(cands) != 0 {
		t.Fatalf("threshold: %+v", cands)
	}
	// 0: every READY video without an AV1 set, watched or not (no analytics row, or only old ones), most
	// watched first; still never a video that is not READY or already has a set.
	never, o6 := seed(t, pg, "UPLOADED")
	encode(t, st, never, o6, nil)
	all, err := st.SelectAV1(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	got := map[uuid.UUID]int64{}
	for _, c := range all {
		got[c.ID] = c.Starts7d
	}
	if len(all) != 4 || all[0].ID != hot || all[1].ID != warm || got[cold] != 0 || got[never] != 0 || len(all[3].H264Names) != 2 {
		t.Fatalf("every video: %+v", all)
	}
}

func TestCommitAV1(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	vid, owner := seed(t, pg, "UPLOADED")
	encode(t, st, vid, owner, nil)

	av1Key := func() *string {
		var k *string
		if err := pg.Pool.QueryRow(ctx, `SELECT hls_av1_master_key FROM media.videos WHERE id = $1`, vid).Scan(&k); err != nil {
			t.Fatal(err)
		}
		return k
	}
	count := func(codec string) int {
		var n int
		_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.video_renditions WHERE video_id = $1 AND codec = $2`, vid, codec).Scan(&n)
		return n
	}

	// No audio tracks: the plain master is stored, the rewrite is not called.
	rw := &keyRewriter{}
	first := av1Commit(vid, "r1")
	prev, ok, err := st.CommitAV1(ctx, first, rw.fn)
	if err != nil || !ok || prev != "" || len(rw.calls) != 0 {
		t.Fatalf("first: %q %v %v calls %d", prev, ok, err, len(rw.calls))
	}
	if k := av1Key(); k == nil || *k != first.MasterKey || count("av1") != 2 || count("h264") != 2 {
		t.Fatalf("stored %v, av1 %d, h264 %d", k, count("av1"), count("h264"))
	}
	var bitrate int
	var playlist string
	_ = pg.Pool.QueryRow(ctx, `SELECT bitrate_kbps, playlist_key FROM media.video_renditions WHERE video_id = $1 AND codec = 'av1' AND name = '720p'`, vid).
		Scan(&bitrate, &playlist)
	if bitrate != first.Renditions[0].TargetK || playlist != first.PlaylistKeys[0] {
		t.Fatalf("720p row %d %s", bitrate, playlist)
	}

	// A READY audio track: the master gets the group under a new key; the previous key is returned.
	tid := seedAudio(t, pg, vid, "vi", "PROCESSING")
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.video_audio_tracks SET status = 'READY', playlist_key = $2 WHERE id = $1`,
		tid, "v/"+vid.String()+"/audio/"+tid.String()+"/index.m3u8"); err != nil {
		t.Fatal(err)
	}
	second := av1Commit(vid, "r2")
	prev, ok, err = st.CommitAV1(ctx, second, rw.fn)
	if err != nil || !ok || prev != first.MasterKey || len(rw.calls) != 1 || len(rw.calls[0]) != 1 {
		t.Fatalf("second: %q %v %v calls %+v", prev, ok, err, rw.calls)
	}
	k := av1Key()
	if k == nil || !strings.HasPrefix(*k, "v/"+vid.String()+"/av1/r2/master-") {
		t.Fatalf("rewritten key %v", k)
	}
	if count("av1") != 2 {
		t.Fatalf("av1 rows %d", count("av1"))
	}

	// A failing rewrite writes nothing.
	failing := &keyRewriter{err: errors.New("garage down")}
	if _, _, err := st.CommitAV1(ctx, av1Commit(vid, "r3"), failing.fn); err == nil {
		t.Fatal("commit succeeded although the rewrite failed")
	}
	if k2 := av1Key(); *k2 != *k {
		t.Fatalf("key changed to %s", *k2)
	}

	// Not READY (re-encoding) or gone: nothing is written.
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET status = 'PROCESSING' WHERE id = $1`, vid); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.CommitAV1(ctx, av1Commit(vid, "r4"), rw.fn); err != nil || ok {
		t.Fatalf("processing: %v %v", ok, err)
	}
	if k2 := av1Key(); *k2 != *k {
		t.Fatalf("key changed to %s", *k2)
	}
	if _, ok, err := st.CommitAV1(ctx, av1Commit(uuid.New(), "r5"), rw.fn); err != nil || ok {
		t.Fatalf("unknown video: %v %v", ok, err)
	}

	// The H.264 re-encode keeps the AV1 set: its renditions and key survive Complete.
	encode(t, st, vid, owner, (&keyRewriter{}).fn)
	if k2 := av1Key(); k2 == nil || *k2 != *k || count("av1") != 2 {
		t.Fatalf("after re-encode: %v, av1 rows %d", k2, count("av1"))
	}
}

// A new audio track rewrites both masters (MUX1 + ENC2).
func TestCompleteAudioRewritesAV1Master(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	vid, owner := seed(t, pg, "UPLOADED")
	encode(t, st, vid, owner, nil)
	c := av1Commit(vid, "r1")
	if _, ok, err := st.CommitAV1(ctx, c, nil); err != nil || !ok {
		t.Fatalf("commit: %v %v", ok, err)
	}
	tid := seedAudio(t, pg, vid, "vi", "PROCESSING")
	rw := &keyRewriter{}
	if ok, err := st.CompleteAudio(ctx, tid, "v/"+vid.String()+"/audio/"+tid.String()+"/index.m3u8", 8000, rw.fn); err != nil || !ok {
		t.Fatalf("complete: %v %v", ok, err)
	}
	var av1 string
	_ = pg.Pool.QueryRow(ctx, `SELECT hls_av1_master_key FROM media.videos WHERE id = $1`, vid).Scan(&av1)
	if len(rw.calls) != 2 || !strings.HasPrefix(av1, "v/"+vid.String()+"/av1/r1/master-") {
		t.Fatalf("calls %d, av1 key %s", len(rw.calls), av1)
	}

	// A failing AV1 rewrite rolls the whole completion back.
	t2 := seedAudio(t, pg, vid, "en", "PROCESSING")
	n := 0
	half := func(ctx context.Context, key string, ready []hlsmaster.Track) (string, error) {
		n++
		if n == 2 {
			return "", errors.New("garage down")
		}
		return rw.fn(ctx, key, ready)
	}
	if _, err := st.CompleteAudio(ctx, t2, "v/"+vid.String()+"/audio/"+t2.String()+"/index.m3u8", 8000, half); err == nil {
		t.Fatal("complete succeeded although the AV1 rewrite failed")
	}
	if s, _, _ := trackRow(t, pg, t2); s != "PROCESSING" {
		t.Fatalf("not rolled back: %s", s)
	}
}
