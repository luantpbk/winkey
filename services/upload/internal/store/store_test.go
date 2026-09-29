package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
	"github.com/luantpbk/winkey/services/upload/internal/store"
)

func TestUploadStore(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}

	mk := func() domain.NewVideo {
		id, owner := ids.New(), ids.New()
		return domain.NewVideo{
			Video: domain.Video{ID: id, OwnerID: owner, Status: domain.StatusUploading, RawBucket: "winkey-raw",
				RawKey: owner.String() + "/" + id.String() + "/source", S3UploadID: "up-1", ContentType: "video/mp4", SizeBytes: 100},
			Title: "t", Description: "", Visibility: "PUBLIC",
		}
	}
	v := mk()
	if err := st.Insert(ctx, v); err != nil {
		t.Fatal(err)
	}
	got, err := st.Get(ctx, v.ID)
	if err != nil || got.S3UploadID != "up-1" || got.Status != "UPLOADING" || got.OwnerID != v.OwnerID || got.Error != "" {
		t.Fatalf("get: %+v %v", got, err)
	}
	if _, err := st.Get(ctx, ids.New()); err != domain.ErrNotFound {
		t.Fatalf("missing: %v", err)
	}
	if p, err := st.Progress(ctx, v.ID); err != nil || p != 0 {
		t.Fatalf("progress: %v %v", p, err)
	}

	changed, err := st.MarkUploaded(ctx, got)
	if err != nil || !changed {
		t.Fatalf("mark uploaded: %v %v", changed, err)
	}
	after, _ := st.Get(ctx, v.ID)
	if after.Status != "UPLOADED" || after.S3UploadID != "" {
		t.Fatalf("after: %+v", after)
	}
	var n int
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE subject='video.uploaded' AND payload->'data'->>'video_id'=$1 AND payload->>'type'='video.uploaded'`, v.ID.String()).Scan(&n)
	if n != 1 {
		t.Fatalf("outbox rows %d", n)
	}
	// Lost race: second call changes nothing and writes no second event.
	if changed, err := st.MarkUploaded(ctx, got); err != nil || changed {
		t.Fatalf("second mark: %v %v", changed, err)
	}
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE subject='video.uploaded'`).Scan(&n)
	if n != 1 {
		t.Fatalf("duplicate event: %d", n)
	}
	if deleted, _ := st.DeleteUploading(ctx, v.ID); deleted {
		t.Fatal("UPLOADED video must not be deletable")
	}

	// progress from the latest job
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET status='PROCESSING' WHERE id=$1`, v.ID); err != nil {
		t.Fatal(err)
	}
	for i, p := range []float32{100, 37.5} { // attempt 2 is the latest
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO media.transcode_jobs (id, video_id, attempt, status, progress) VALUES ($1,$2,$3,$4::media.job_status,$5)`,
			ids.New(), v.ID, i+1, map[bool]string{true: "FAILED", false: "RUNNING"}[i == 0], p); err != nil {
			t.Fatal(err)
		}
	}
	if p, _ := st.Progress(ctx, v.ID); p != 37.5 {
		t.Fatalf("latest job progress %v", p)
	}

	// MarkFailed, DeleteUploading, StaleUploads
	f := mk()
	_ = st.Insert(ctx, f)
	if ok, err := st.MarkFailed(ctx, f.ID, "size mismatch"); err != nil || !ok {
		t.Fatalf("mark failed: %v %v", ok, err)
	}
	ff, _ := st.Get(ctx, f.ID)
	if ff.Status != "FAILED" || ff.Error != "size mismatch" || ff.S3UploadID != "" {
		t.Fatalf("failed row: %+v", ff)
	}
	old, fresh := mk(), mk()
	_ = st.Insert(ctx, old)
	_ = st.Insert(ctx, fresh)
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET created_at = now() - interval '25 hours' WHERE id=$1`, old.ID); err != nil {
		t.Fatal(err)
	}
	stale, err := st.StaleUploads(ctx, 24*time.Hour, 100)
	if err != nil || len(stale) != 1 || stale[0].ID != old.ID || stale[0].S3UploadID != "up-1" {
		t.Fatalf("stale: %+v %v", stale, err)
	}
	if ok, _ := st.DeleteUploading(ctx, old.ID); !ok {
		t.Fatal("delete stale")
	}
	if _, err := st.Get(ctx, old.ID); err != domain.ErrNotFound {
		t.Fatal("row still there")
	}
}
