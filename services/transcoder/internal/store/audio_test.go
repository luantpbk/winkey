package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/audio"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

// encode drives one video job to READY (attempt n) and returns its master key.
func encode(t *testing.T, st *store.Postgres, vid, owner uuid.UUID, rewrite func(context.Context, string, []hlsmaster.Track) (string, error)) job.ReadyResult {
	t.Helper()
	ctx := context.Background()
	b, err := st.BeginJob(ctx, vid, "x264", "gpu-01")
	if err != nil || b.Skip {
		t.Fatalf("begin: %+v %v", b, err)
	}
	rs := media.Select(1280, 720)
	prefix := "v/" + vid.String() + "/a" + string(rune('0'+b.Attempt)) + "/"
	res := job.ReadyResult{
		VideoID: vid, OwnerID: owner, JobID: b.JobID, Attempt: b.Attempt, Encoder: "x264", DurationMs: 8000,
		Width: 1280, Height: 720, MasterKey: prefix + "hls/master.m3u8", ThumbKey: prefix + "thumb/poster.jpg",
		Renditions: rs, RewriteMaster: rewrite,
	}
	for _, r := range rs {
		res.PlaylistKeys = append(res.PlaylistKeys, prefix+"hls/"+r.Name+"/index.m3u8")
	}
	if ok, err := st.Complete(ctx, res); err != nil || !ok {
		t.Fatalf("complete: %v %v", ok, err)
	}
	return res
}

func seedAudio(t *testing.T, pg *testkit.Postgres, vid uuid.UUID, lang, status string) uuid.UUID {
	t.Helper()
	id := ids.New()
	if _, err := pg.Pool.Exec(context.Background(), `
		INSERT INTO media.video_audio_tracks (id, video_id, lang, label, kind, status, raw_bucket, raw_key, content_type, size_bytes)
		VALUES ($1, $2, $3, 'Thuyết minh', 'voiceover', $4, 'winkey-raw', 'k', 'audio/flac', 100)`, id, vid, lang, status); err != nil {
		t.Fatal(err)
	}
	return id
}

func trackRow(t *testing.T, pg *testkit.Postgres, id uuid.UUID) (status, errCode string, playlist *string) {
	t.Helper()
	if err := pg.Pool.QueryRow(context.Background(), `
		SELECT status, coalesce(error, ''), playlist_key FROM media.video_audio_tracks WHERE id = $1`, id).Scan(&status, &errCode, &playlist); err != nil {
		t.Fatal(err)
	}
	return
}

// keyRewriter records what it was asked and returns a new key.
type keyRewriter struct {
	calls [][]hlsmaster.Track
	err   error
}

func (k *keyRewriter) fn(_ context.Context, masterKey string, ready []hlsmaster.Track) (string, error) {
	if k.err != nil {
		return "", k.err
	}
	k.calls = append(k.calls, ready)
	return hlsmaster.NewKey(masterKey, ids.NewString()), nil
}

func TestAudioTrackLifecycle(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	vid, owner := seed(t, pg, "UPLOADED")
	tid := seedAudio(t, pg, vid, "vi", "UPLOADED")

	// The video is not READY yet: wait.
	if out, _, err := st.BeginAudio(ctx, tid); err != nil || out != audio.Wait {
		t.Fatalf("begin before READY: %v %v", out, err)
	}
	first := encode(t, st, vid, owner, nil)

	out, tr, err := st.BeginAudio(ctx, tid)
	if err != nil || out != audio.Run || tr.VideoDurationMs != 8000 || tr.OwnerID != owner || tr.Lang != "vi" || tr.RawKey != "k" {
		t.Fatalf("begin: %v %+v %v", out, tr, err)
	}
	if s, _, _ := trackRow(t, pg, tid); s != "PROCESSING" {
		t.Fatalf("status %s", s)
	}

	// A failing master rewrite rolls READY back.
	rw := &keyRewriter{err: errors.New("garage down")}
	playlist := "v/" + vid.String() + "/audio/" + tid.String() + "/index.m3u8"
	if _, err := st.CompleteAudio(ctx, tid, playlist, 8010, rw.fn); err == nil {
		t.Fatal("complete succeeded although the rewrite failed")
	}
	if s, _, _ := trackRow(t, pg, tid); s != "PROCESSING" {
		t.Fatalf("not rolled back: %s", s)
	}

	rw.err = nil
	ok, err := st.CompleteAudio(ctx, tid, playlist, 8010, rw.fn)
	if err != nil || !ok {
		t.Fatalf("complete: %v %v", ok, err)
	}
	s, _, pl := trackRow(t, pg, tid)
	if s != "READY" || pl == nil || *pl != playlist || len(rw.calls) != 1 || len(rw.calls[0]) != 1 || rw.calls[0][0].PlaylistKey != playlist {
		t.Fatalf("ready: %s %v calls %+v", s, pl, rw.calls)
	}
	var master string
	_ = pg.Pool.QueryRow(ctx, `SELECT hls_master_key FROM media.videos WHERE id = $1`, vid).Scan(&master)
	if master == first.MasterKey {
		t.Fatal("hls_master_key not rewritten")
	}
	var payload []byte
	if err := pg.Pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject = 'video.audio_ready'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var env struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(payload, &env)
	if env.Data["track_id"] != tid.String() || env.Data["hls_master_key"] != master || env.Data["duration_ms"] != float64(8010) ||
		env.Data["owner_id"] != owner.String() || env.Data["kind"] != "voiceover" {
		t.Fatalf("event %s", payload)
	}
	// Done: a redelivery skips.
	if out, _, _ := st.BeginAudio(ctx, tid); out != audio.Skip {
		t.Fatalf("redelivery: %v", out)
	}

	// A re-encode of the video (READY -> PROCESSING, as a backfill does) re-applies the group to its new master.
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET status = 'PROCESSING' WHERE id = $1`, vid); err != nil {
		t.Fatal(err)
	}
	again := &keyRewriter{}
	second := encode(t, st, vid, owner, again.fn)
	_ = pg.Pool.QueryRow(ctx, `SELECT hls_master_key FROM media.videos WHERE id = $1`, vid).Scan(&master)
	if len(again.calls) != 1 || len(again.calls[0]) != 1 || master == second.MasterKey {
		t.Fatalf("re-encode: calls %+v, master %s", again.calls, master)
	}
}

func TestAudioTrackFailures(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}

	vid, owner := seed(t, pg, "UPLOADED")
	encode(t, st, vid, owner, nil)
	tid := seedAudio(t, pg, vid, "vi", "UPLOADED")
	f := audio.Failure{Reason: audio.ReasonDurationMismatch, Message: "The audio is 9.00 s long but the video is 8.00 s.", Retryable: false}
	if ok, err := st.FailAudio(ctx, tid, f); err != nil || !ok {
		t.Fatalf("fail: %v %v", ok, err)
	}
	if s, code, _ := trackRow(t, pg, tid); s != "FAILED" || code != audio.ReasonDurationMismatch {
		t.Fatalf("row %s %s", s, code)
	}
	if ok, _ := st.FailAudio(ctx, tid, f); ok {
		t.Fatal("failing twice reported a change")
	}
	var payload []byte
	_ = pg.Pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject = 'video.audio_failed'`).Scan(&payload)
	var env struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(payload, &env)
	if env.Data["reason"] != audio.ReasonDurationMismatch || env.Data["retryable"] != false || env.Data["owner_id"] != owner.String() {
		t.Fatalf("event %s", payload)
	}

	// The video failed: the track can never be processed.
	bad, _ := seed(t, pg, "UPLOADED")
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET status = 'FAILED' WHERE id = $1`, bad); err != nil {
		t.Fatal(err)
	}
	bt := seedAudio(t, pg, bad, "vi", "UPLOADED")
	if out, _, err := st.BeginAudio(ctx, bt); err != nil || out != audio.VideoFailed {
		t.Fatalf("failed video: %v %v", out, err)
	}

	// Gone or still uploading: skip.
	if out, _, _ := st.BeginAudio(ctx, ids.New()); out != audio.Skip {
		t.Fatalf("unknown track: %v", out)
	}
	up := seedAudio(t, pg, vid, "en", "UPLOADING")
	if out, _, _ := st.BeginAudio(ctx, up); out != audio.Skip {
		t.Fatalf("uploading track: %v", out)
	}

	// Deleted while encoding: CompleteAudio reports false and writes nothing.
	gone := seedAudio(t, pg, vid, "fr", "UPLOADED")
	if out, _, _ := st.BeginAudio(ctx, gone); out != audio.Run {
		t.Fatal("begin")
	}
	if _, err := pg.Pool.Exec(ctx, `DELETE FROM media.video_audio_tracks WHERE id = $1`, gone); err != nil {
		t.Fatal(err)
	}
	rw := &keyRewriter{}
	if ok, err := st.CompleteAudio(ctx, gone, "v/x/audio/y/index.m3u8", 8000, rw.fn); err != nil || ok || len(rw.calls) != 0 {
		t.Fatalf("complete deleted: %v %v %d", ok, err, len(rw.calls))
	}
}
