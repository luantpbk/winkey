package store_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/image"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

// SOC-1b: the image job's store on real PostgreSQL (migration 000029).
func TestImageStore(t *testing.T) {
	pg := testkit.StartPostgres(t)
	st := &store.Postgres{Pool: pg.Pool}
	ctx := context.Background()
	insert := func(status string) (id, owner string) {
		id, owner = ids.NewString(), ids.NewString()
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO media.images (id, owner_id, purpose, status, content_type, size_bytes, raw_bucket, raw_key)
			VALUES ($1, $2, 'AVATAR', $3, 'image/jpeg', 100, 'winkey-raw', $4)`, id, owner, status, owner+"/images/"+id); err != nil {
			t.Fatal(err)
		}
		return id, owner
	}

	idUp, _ := insert("UPLOADING")
	if _, ok, err := st.BeginImage(ctx, uuid.MustParse(idUp)); err != nil || ok {
		t.Fatalf("UPLOADING must not begin: %v %v", ok, err)
	}

	id, owner := insert("PROCESSING")
	img, ok, err := st.BeginImage(ctx, uuid.MustParse(id))
	if err != nil || !ok || img.Purpose != "AVATAR" || img.RawKey != owner+"/images/"+id || img.OwnerID.String() != owner {
		t.Fatalf("begin: %+v %v %v", img, ok, err)
	}
	out := image.Output{ImageKey: "i/" + owner + "/" + id + "/image.webp", ThumbKey: "i/" + owner + "/" + id + "/thumb.webp",
		Width: 400, Height: 400, Bytes: 12345}
	if ok, err := st.CompleteImage(ctx, uuid.MustParse(id), out); err != nil || !ok {
		t.Fatalf("complete: %v %v", ok, err)
	}
	var key string
	if err := pg.Pool.QueryRow(ctx, `SELECT image_key FROM media.ready_images WHERE id = $1`, id).Scan(&key); err != nil || key != out.ImageKey {
		t.Fatalf("ready view: %q %v", key, err)
	}
	if ok, _ := st.CompleteImage(ctx, uuid.MustParse(id), out); ok {
		t.Fatal("completing twice must report not PROCESSING")
	}
	if ok, _ := st.FailImage(ctx, uuid.MustParse(id), image.ReasonInvalidInput); ok {
		t.Fatal("a READY image must not fail")
	}

	id2, _ := insert("PROCESSING")
	if ok, err := st.FailImage(ctx, uuid.MustParse(id2), image.ReasonInvalidInput); err != nil || !ok {
		t.Fatalf("fail: %v %v", ok, err)
	}
	var status, reason string
	_ = pg.Pool.QueryRow(ctx, `SELECT status, error FROM media.images WHERE id = $1`, id2).Scan(&status, &reason)
	if status != "FAILED" || reason != "INVALID_INPUT" {
		t.Fatalf("failed row: %s %s", status, reason)
	}
}
