package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
	"github.com/luantpbk/winkey/services/upload/internal/store"
)

func newVideo(size int64) domain.NewVideo {
	id, owner := ids.New(), ids.New()
	return domain.NewVideo{
		Video: domain.Video{ID: id, OwnerID: owner, Status: domain.StatusUploading, RawBucket: "winkey-raw",
			RawKey: owner.String() + "/" + id.String() + "/source", ContentType: "video/mp4", SizeBytes: size},
		Title: "t", Visibility: "PUBLIC",
	}
}

// Create writes the ledger row with the video row (also without a quota check, as for admins), the
// usage comes from the ledger (a deleted video still counts) and concurrent from media.videos.
func TestCreateWritesTheLedgerAndUsageReadsIt(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	v := newVideo(1000)
	owner := v.OwnerID

	var seen domain.Usage
	check := func(u domain.Usage) error { seen = u; return nil }
	start := func(context.Context) (string, error) { return "up", nil }
	if err := st.Create(ctx, v, check, start); err != nil {
		t.Fatal(err)
	}
	if seen.Count != 0 || seen.Uploading != 0 || !seen.Oldest.IsZero() {
		t.Fatalf("usage before the first upload: %+v", seen)
	}
	var size int64
	if err := pg.Pool.QueryRow(ctx, `SELECT size_bytes FROM media.upload_ledger WHERE video_id = $1 AND owner_id = $2`, v.ID, owner).Scan(&size); err != nil || size != 1000 {
		t.Fatalf("ledger row: size %d, err %v", size, err)
	}

	// Hard-delete the video: the ledger keeps it, concurrent forgets it.
	if _, err := pg.Pool.Exec(ctx, `DELETE FROM media.videos WHERE id = $1`, v.ID); err != nil {
		t.Fatal(err)
	}
	v2 := v
	v2.ID = ids.New()
	v2.RawKey = "k2"
	v2.SizeBytes = 500
	if err := st.Create(ctx, v2, check, start); err != nil {
		t.Fatal(err)
	}
	if seen.Count != 1 || seen.Bytes != 1000 || seen.Uploading != 0 || seen.Oldest.IsZero() || seen.Now.Before(seen.Oldest) {
		t.Fatalf("usage after a deleted upload: %+v", seen)
	}

	// A refusal and a failed startUpload write neither the video row nor the ledger row.
	refuse := func(domain.Usage) error { return errors.New("refused") }
	if err := st.Create(ctx, newOwned(owner), refuse, start); err == nil {
		t.Fatal("refusal not returned")
	}
	failed := newOwned(owner)
	if err := st.Create(ctx, failed, nil, func(context.Context) (string, error) { return "", errors.New("s3") }); err == nil {
		t.Fatal("start failure not returned")
	}
	var n int
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.upload_ledger WHERE owner_id = $1`, owner).Scan(&n)
	if n != 2 {
		t.Fatalf("ledger rows = %d, want 2", n)
	}
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.videos WHERE id = $1`, failed.ID).Scan(&n)
	if n != 0 {
		t.Fatal("video row of a failed upload was committed")
	}
}

func newOwned(owner uuid.UUID) domain.NewVideo {
	v := newVideo(1)
	v.OwnerID = owner
	return v
}

func TestPurgeLedgerDeletesOldRowsInBatches(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	owner := ids.New()
	if _, err := pg.Pool.Exec(ctx, `
		INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes, created_at)
		SELECT gen_random_uuid(), $1, 1, now() - interval '49 hours' - make_interval(secs => g) FROM generate_series(1, 25) g`, owner); err != nil {
		t.Fatal(err)
	}
	for _, age := range []string{"26 hours", "1 hour"} {
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes, created_at) VALUES (gen_random_uuid(), $1, 1, now() - $2::interval)`, owner, age); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []int{10, 10, 5, 0} { // batches of at most 10
		n, err := st.PurgeLedger(ctx, 48*time.Hour, 10)
		if err != nil || n != want {
			t.Fatalf("PurgeLedger = %d, %v; want %d", n, err, want)
		}
	}
	var left int
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.upload_ledger WHERE owner_id = $1`, owner).Scan(&left)
	if left != 2 {
		t.Fatalf("rows left = %d, want the two younger than 48 h", left)
	}
	// Asking for younger rows hits the database guard: the janitor never does that.
	if _, err := st.PurgeLedger(ctx, time.Hour, 10); err == nil || !strings.Contains(err.Error(), "younger than 25 h") {
		t.Fatalf("purging rows younger than 25 h: %v", err)
	}
}
