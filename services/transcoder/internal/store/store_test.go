package store_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

func seed(t *testing.T, pg *testkit.Postgres, status string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	vid, owner := ids.New(), ids.New()
	if _, err := pg.Pool.Exec(ctx, `INSERT INTO media.videos (id, owner_id, title, status, raw_bucket, raw_key, content_type, size_bytes)
		VALUES ($1,$2,'t','UPLOADING','winkey-raw','k','video/mp4',10)`, vid, owner); err != nil {
		t.Fatal(err)
	}
	if status != "UPLOADING" {
		if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET status=$2::media.video_status WHERE id=$1`, vid, status); err != nil {
			t.Fatal(err)
		}
	}
	return vid, owner
}

func TestStoreLifecycle(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	vid, owner := seed(t, pg, "UPLOADED")

	b, err := st.BeginJob(ctx, vid, "nvenc", "gpu-01")
	if err != nil || b.Skip || b.Attempt != 1 || b.Video.OwnerID != owner {
		t.Fatalf("begin: %+v %v", b, err)
	}
	var status string
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text FROM media.videos WHERE id=$1`, vid).Scan(&status)
	if status != "PROCESSING" {
		t.Fatalf("status %s", status)
	}
	if err := st.SetProgress(ctx, b.JobID, 42.5); err != nil {
		t.Fatal(err)
	}
	if err := st.SetJobEncoder(ctx, b.JobID, "x264"); err != nil {
		t.Fatal(err)
	}

	// A redelivery after a crash: the RUNNING job is retired and attempt 2 starts.
	b2, err := st.BeginJob(ctx, vid, "nvenc", "gpu-01")
	if err != nil || b2.Attempt != 2 {
		t.Fatalf("second begin: %+v %v", b2, err)
	}
	var st1, err1 string
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text, coalesce(error,'') FROM media.transcode_jobs WHERE id=$1`, b.JobID).Scan(&st1, &err1)
	if st1 != "FAILED" || err1 == "" {
		t.Fatalf("stale job: %s %q", st1, err1)
	}

	// Retryable failure: job FAILED, video stays PROCESSING, no event.
	f := job.Failure{Reason: job.ReasonStorage, Retryable: true, Message: "storage"}
	if err := st.FailJob(ctx, job.FailRecord{VideoID: vid, OwnerID: owner, JobID: b2.JobID, Attempt: 2, Failure: f}); err != nil {
		t.Fatal(err)
	}
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text FROM media.videos WHERE id=$1`, vid).Scan(&status)
	var events int
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE subject='video.failed'`).Scan(&events)
	if status != "PROCESSING" || events != 0 {
		t.Fatalf("non-terminal failure: status=%s events=%d", status, events)
	}

	// Attempt 3 succeeds.
	b3, err := st.BeginJob(ctx, vid, "x264", "gpu-01")
	if err != nil || b3.Attempt != 3 {
		t.Fatalf("third begin: %+v %v", b3, err)
	}
	rs := media.Select(1920, 1080)
	prefix := "v/" + vid.String() + "/a3/"
	res := job.ReadyResult{
		VideoID: vid, OwnerID: owner, JobID: b3.JobID, Attempt: 3, Encoder: "x264", DurationMs: 30000,
		Width: 1920, Height: 1080, MasterKey: prefix + "hls/master.m3u8", ThumbKey: prefix + "thumb/poster.jpg",
		Renditions: rs,
	}
	for _, r := range rs {
		res.PlaylistKeys = append(res.PlaylistKeys, prefix+"hls/"+r.Name+"/index.m3u8")
	}
	ok, err := st.Complete(ctx, res)
	if err != nil || !ok {
		t.Fatalf("complete: %v %v", ok, err)
	}
	var master string
	var pub *string
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text, hls_master_key, published_at::text FROM media.videos WHERE id=$1`, vid).Scan(&status, &master, &pub)
	if status != "READY" || master != res.MasterKey || pub == nil {
		t.Fatalf("ready row: %s %s %v", status, master, pub)
	}
	var nr int
	var jstatus, enc string
	var prog float32
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.video_renditions WHERE video_id=$1`, vid).Scan(&nr)
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text, encoder, progress FROM media.transcode_jobs WHERE id=$1`, b3.JobID).Scan(&jstatus, &enc, &prog)
	if nr != 3 || jstatus != "SUCCEEDED" || enc != "x264" || prog != 100 {
		t.Fatalf("renditions=%d job=%s/%s/%v", nr, jstatus, enc, prog)
	}
	var payload []byte
	if err := pg.Pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject='video.ready'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var env struct {
		Data struct {
			Renditions []map[string]any `json:"renditions"`
			Attempt    int              `json:"attempt"`
		} `json:"data"`
	}
	_ = json.Unmarshal(payload, &env)
	if len(env.Data.Renditions) != 3 || env.Data.Attempt != 3 {
		t.Fatalf("event: %s", payload)
	}

	// READY is skipped; Complete is idempotent-safe (video no longer PROCESSING).
	if b, err := st.BeginJob(ctx, vid, "x264", "w"); err != nil || !b.Skip {
		t.Fatalf("READY must skip: %+v %v", b, err)
	}
	if ok, err := st.Complete(ctx, res); err != nil || ok {
		t.Fatalf("second complete: %v %v", ok, err)
	}
	// Unknown video is skipped too.
	if b, err := st.BeginJob(ctx, ids.New(), "x264", "w"); err != nil || !b.Skip {
		t.Fatalf("missing video: %+v %v", b, err)
	}
}

func TestStoreTerminalFailure(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	vid, owner := seed(t, pg, "UPLOADED")
	b, _ := st.BeginJob(ctx, vid, "x264", "w")

	f := job.Classify(&media.InvalidInputError{Msg: "no video stream"})
	if err := st.FailJob(ctx, job.FailRecord{VideoID: vid, OwnerID: owner, JobID: b.JobID, Attempt: 1, Failure: f, Terminal: true}); err != nil {
		t.Fatal(err)
	}
	var status, msg string
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text, error FROM media.videos WHERE id=$1`, vid).Scan(&status, &msg)
	if status != "FAILED" || msg != f.Message {
		t.Fatalf("%s %q", status, msg)
	}
	var payload []byte
	if err := pg.Pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject='video.failed'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var env struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(payload, &env)
	if env.Data["reason"] != "INVALID_INPUT" || env.Data["retryable"] != false || env.Data["attempt"] != float64(1) {
		t.Fatalf("event: %s", payload)
	}

	// FAILED → PROCESSING on a manual retry (replay): allowed, attempt 2.
	b2, err := st.BeginJob(ctx, vid, "x264", "w")
	if err != nil || b2.Attempt != 2 {
		t.Fatalf("retry after FAILED: %+v %v", b2, err)
	}
	// UPLOADING is refused (retry later), not skipped.
	vid2, _ := seed(t, pg, "UPLOADING")
	if _, err := st.BeginJob(ctx, vid2, "x264", "w"); err == nil {
		t.Fatal("UPLOADING video must produce an error so the message is retried")
	}
}
