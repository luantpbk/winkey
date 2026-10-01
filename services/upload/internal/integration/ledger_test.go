package integration

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/upload/internal/contract"
	"github.com/luantpbk/winkey/services/upload/internal/janitor"
	"github.com/luantpbk/winkey/services/upload/internal/quota"
)

func (q *quotaStack) ledger(t *testing.T, owner string) int {
	t.Helper()
	var n int
	if err := q.pg.Pool.QueryRow(context.Background(), `SELECT count(*) FROM media.upload_ledger WHERE owner_id = $1`, owner).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// deleteVideos hard-deletes the owner's video rows, as video-svc does when a video is deleted.
func (q *quotaStack) deleteVideos(t *testing.T, owner string) {
	t.Helper()
	if _, err := q.pg.Pool.Exec(context.Background(), `DELETE FROM media.videos WHERE owner_id = $1`, owner); err != nil {
		t.Fatal(err)
	}
}

// ledgerRow inserts a ledger row of the owner created `age` ago, without a video row.
func (q *quotaStack) ledgerRow(t *testing.T, owner string, age time.Duration, size int64) {
	t.Helper()
	if _, err := q.pg.Pool.Exec(context.Background(), `
		INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes, created_at)
		VALUES ($1, $2, $3, now() - make_interval(secs => $4))`, ids.New(), owner, size, age.Seconds()); err != nil {
		t.Fatal(err)
	}
}

// TestUploadLedger covers task UQ1-b: the daily quotas are read from media.upload_ledger, so deleting
// the video row does not give the quota back; `concurrent` still reads media.videos.
func TestUploadLedger(t *testing.T) {
	q := &quotaStack{
		stack: startQuota(t, quota.Limits{MaxConcurrent: 3, DailyCount: 20, DailyBytes: 50 * gib}),
		spec:  contract.Load(t),
	}
	const creator = "creator"

	t.Run("upload, delete, repeat: the 21st in 24 h is 429 daily_count with no video rows left", func(t *testing.T) {
		owner := ids.NewString()
		for i := range 20 {
			c := q.create(t, owner, creator, mib)
			if c.code != 201 {
				t.Fatalf("upload %d: got %d %+v", i+1, c.code, c.problem)
			}
			q.deleteVideos(t, owner)
		}
		if n := q.rows(t, owner); n != 0 {
			t.Fatalf("media.videos has %d rows for the owner, want 0", n)
		}
		wantQuota429(t, q.create(t, owner, creator, mib), "daily_count")
		if n := q.ledger(t, owner); n != 20 {
			t.Fatalf("ledger rows = %d, want 20 (the refusal wrote none)", n)
		}
	})

	t.Run("bytes: 3 x 20 GiB with deletes in between, the third is 429 daily_bytes", func(t *testing.T) {
		owner := ids.NewString()
		for i := range 2 {
			if c := q.create(t, owner, creator, maxBytes); c.code != 201 {
				t.Fatalf("upload %d: got %d %+v", i+1, c.code, c.problem)
			}
			q.deleteVideos(t, owner)
		}
		c := q.create(t, owner, creator, maxBytes)
		wantQuota429(t, c, "daily_bytes")
		if c.retryAfter < 24*3600-60 || c.retryAfter > 24*3600 {
			t.Errorf("Retry-After = %d, want about %d (the oldest ledger row is seconds old)", c.retryAfter, 24*3600)
		}
		if q.rows(t, owner) != 0 || q.ledger(t, owner) != 2 {
			t.Fatalf("videos %d, ledger %d; want 0 and 2", q.rows(t, owner), q.ledger(t, owner))
		}
	})

	t.Run("concurrent frees up when an upload is aborted, the ledger keeps counting", func(t *testing.T) {
		owner := ids.NewString()
		var ids3 []string
		for range 3 {
			c := q.create(t, owner, creator, mib)
			if c.code != 201 {
				t.Fatalf("create: %d", c.code)
			}
			ids3 = append(ids3, c.videoID)
		}
		wantQuota429(t, q.create(t, owner, creator, mib), "concurrent")
		code, _, _ := q.api(t, owner, creator, "DELETE", "/v1/uploads/{video_id}", "/v1/uploads/"+ids3[0], nil)
		if code != 204 {
			t.Fatalf("abort: %d", code)
		}
		if c := q.create(t, owner, creator, mib); c.code != 201 {
			t.Fatalf("after an abort the next create got %d %+v", c.code, c.problem)
		}
		if n := q.ledger(t, owner); n != 4 {
			t.Fatalf("ledger rows = %d, want 4 (the aborted upload stays counted)", n)
		}
		if n := q.rows(t, owner); n != 3 {
			t.Fatalf("video rows = %d, want 3", n)
		}
	})

	t.Run("a refusal writes no ledger row", func(t *testing.T) {
		owner := ids.NewString()
		for range 3 {
			if c := q.create(t, owner, creator, mib); c.code != 201 {
				t.Fatalf("create: %d", c.code)
			}
		}
		wantQuota429(t, q.create(t, owner, creator, mib), "concurrent")
		if n := q.ledger(t, owner); n != 3 {
			t.Fatalf("ledger rows = %d, want 3", n)
		}
	})

	t.Run("an S3 failure on CreateMultipartUpload leaves no ledger row and no video row", func(t *testing.T) {
		owner := ids.NewString()
		q.flaky.fail.Store(true)
		// createRaw, not create: an S3 outage is a deliberate infrastructure error answered with 500, a
		// status upload.v1.yaml does not document for createUpload, so Spec.Check would (rightly) flag it.
		// This is the only request in these tests sent without the contract check.
		code := q.createRaw(t, owner, creator, mib)
		q.flaky.fail.Store(false)
		if code != 500 {
			t.Fatalf("got %d, want 500", code)
		}
		if q.ledger(t, owner) != 0 || q.rows(t, owner) != 0 || q.multiparts(t, owner) != 0 {
			t.Fatalf("state left behind: ledger %d, videos %d, multiparts %d", q.ledger(t, owner), q.rows(t, owner), q.multiparts(t, owner))
		}
		if c := q.create(t, owner, creator, mib); c.code != 201 {
			t.Fatalf("after the outage: %d", c.code)
		}
		if n := q.ledger(t, owner); n != 1 {
			t.Fatalf("ledger rows = %d, want 1", n)
		}
	})

	t.Run("admin uploads are written to the ledger although the quota is skipped", func(t *testing.T) {
		owner := ids.NewString()
		for range 25 { // over every limit
			if c := q.create(t, owner, "creator,admin", mib); c.code != 201 {
				t.Fatalf("admin create: %d", c.code)
			}
		}
		if n := q.ledger(t, owner); n != 25 {
			t.Fatalf("ledger rows = %d, want 25", n)
		}
		wantQuota429(t, q.create(t, owner, creator, mib), "concurrent") // 25 UPLOADING rows
	})

	t.Run("Retry-After comes from the oldest ledger row in the window", func(t *testing.T) {
		owner := ids.NewString()
		q.ledgerRow(t, owner, 23*time.Hour, mib) // leaves the window in 1 h
		for range 19 {
			q.ledgerRow(t, owner, time.Hour, mib)
		}
		c := q.create(t, owner, creator, mib)
		wantQuota429(t, c, "daily_count")
		if c.retryAfter < 3600-30 || c.retryAfter > 3600+30 {
			t.Errorf("Retry-After = %d, want about 3600", c.retryAfter)
		}
		// The same ledger without the old row has room again once that row left the window.
		other := ids.NewString()
		q.ledgerRow(t, other, 24*time.Hour+time.Minute, mib) // outside the window: not counted
		for range 19 {
			q.ledgerRow(t, other, time.Hour, mib)
		}
		if c := q.create(t, other, creator, mib); c.code != 201 {
			t.Fatalf("a ledger row older than 24 h was counted: %d", c.code)
		}
	})

	t.Run("janitor: rows at -49 h are deleted, rows at -26 h and -1 h stay", func(t *testing.T) {
		owner := ids.NewString()
		q.ledgerRow(t, owner, 49*time.Hour, mib)
		q.ledgerRow(t, owner, 26*time.Hour, mib)
		q.ledgerRow(t, owner, time.Hour, mib)
		j := &janitor.Janitor{Store: q.store, Storage: q.stor, Log: slog.New(slog.NewJSONHandler(io.Discard, nil))}
		if _, err := j.Sweep(context.Background()); err != nil {
			t.Fatal(err)
		}
		var ages []int
		rows, err := q.pg.Pool.Query(context.Background(),
			`SELECT round(extract(epoch FROM now() - created_at) / 3600)::int FROM media.upload_ledger WHERE owner_id = $1 ORDER BY created_at`, owner)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var h int
			if err := rows.Scan(&h); err != nil {
				t.Fatal(err)
			}
			ages = append(ages, h)
		}
		if len(ages) != 2 || ages[0] != 26 || ages[1] != 1 {
			t.Fatalf("remaining ledger row ages (hours) = %v, want [26 1]", ages)
		}
	})

	t.Run("janitor: more than 1000 old rows are all purged in one sweep, in batches", func(t *testing.T) {
		owner := ids.NewString()
		if _, err := q.pg.Pool.Exec(context.Background(), `
			INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes, created_at)
			SELECT gen_random_uuid(), $1, 1048576, now() - interval '50 hours' - make_interval(secs => g)
			FROM generate_series(1, 2500) g`, owner); err != nil {
			t.Fatal(err)
		}
		q.ledgerRow(t, owner, time.Hour, mib)
		j := &janitor.Janitor{Store: q.store, Storage: q.stor, Log: slog.New(slog.NewJSONHandler(io.Discard, nil))}
		if _, err := j.Sweep(context.Background()); err != nil {
			t.Fatal(err)
		}
		if n := q.ledger(t, owner); n != 1 {
			t.Fatalf("ledger rows left = %d, want 1 (the 2500 old rows go, the recent one stays)", n)
		}
	})

	t.Run("the database refuses what the janitor never does", func(t *testing.T) {
		owner := ids.NewString()
		q.ledgerRow(t, owner, time.Hour, mib)
		_, err := q.pg.Pool.Exec(context.Background(), `DELETE FROM media.upload_ledger WHERE owner_id = $1`, owner)
		if err == nil || !strings.Contains(err.Error(), "younger than 25 h") {
			t.Fatalf("deleting a young ledger row: %v", err)
		}
		_, err = q.pg.Pool.Exec(context.Background(), `UPDATE media.upload_ledger SET size_bytes = 1 WHERE owner_id = $1`, owner)
		if err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Fatalf("updating a ledger row: %v", err)
		}
	})
}
