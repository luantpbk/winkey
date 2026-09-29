package store_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

const stale = 10 * time.Minute

// runningJob seeds a PROCESSING video with a RUNNING job of the given attempt
// number (earlier attempts are inserted as FAILED) and returns the ids.
func runningJob(t *testing.T, pg *testkit.Postgres, st *store.Postgres, attempt int) (vid, jobID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	vid, _ = seed(t, pg, "UPLOADED")
	for i := 1; i <= attempt; i++ {
		b, err := st.BeginJob(ctx, vid, "x264", "w") // retires the previous job as FAILED
		if err != nil || b.Attempt != i {
			t.Fatalf("attempt %d: %+v %v", i, b, err)
		}
		jobID = b.JobID
	}
	return vid, jobID
}

func ageJob(t *testing.T, pg *testkit.Postgres, jobID uuid.UUID, heartbeatAge, startedAge string) {
	t.Helper()
	q := `UPDATE media.transcode_jobs SET heartbeat_at = now() - $2::interval, started_at = now() - $3::interval WHERE id = $1`
	if heartbeatAge == "" {
		q = `UPDATE media.transcode_jobs SET heartbeat_at = NULL, started_at = now() - $3::interval WHERE id = $1 AND $2 = ''`
	}
	if _, err := pg.Pool.Exec(context.Background(), q, jobID, heartbeatAge, startedAge); err != nil {
		t.Fatal(err)
	}
}

func count(t *testing.T, pg *testkit.Postgres, q string, args ...any) int {
	t.Helper()
	var n int
	if err := pg.Pool.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestReconcileFreshHeartbeatIsLeftAlone(t *testing.T) {
	pg := testkit.StartPostgres(t)
	st := &store.Postgres{Pool: pg.Pool}
	ctx := context.Background()
	vid, jobID := runningJob(t, pg, st, 1)

	// Started long ago but the worker keeps heartbeating: alive.
	ageJob(t, pg, jobID, "30 seconds", "2 hours")
	if got, err := st.ReconcileStale(ctx, stale, 3, 20); err != nil || len(got) != 0 {
		t.Fatalf("fresh heartbeat reconciled: %+v %v", got, err)
	}
	// Heartbeat() brings a stale job back to life.
	ageJob(t, pg, jobID, "20 minutes", "2 hours")
	if err := st.Heartbeat(ctx, jobID); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.ReconcileStale(ctx, stale, 3, 20); len(got) != 0 {
		t.Fatalf("job with a new heartbeat reconciled: %+v", got)
	}
	var status string
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text FROM media.transcode_jobs WHERE id=$1`, jobID).Scan(&status)
	if status != "RUNNING" || count(t, pg, `SELECT count(*) FROM media.outbox WHERE subject='video.uploaded'`) != 0 {
		t.Fatalf("job=%s", status)
	}
	_ = vid
}

func TestReconcileStaleWithRetriesLeftEnqueuesNewEvent(t *testing.T) {
	pg := testkit.StartPostgres(t)
	st := &store.Postgres{Pool: pg.Pool}
	ctx := context.Background()
	vid, jobID := runningJob(t, pg, st, 1)
	ageJob(t, pg, jobID, "11 minutes", "1 hour")

	got, err := st.ReconcileStale(ctx, stale, 3, 20)
	if err != nil || len(got) != 1 || !got[0].Retried || got[0].Failed || got[0].JobID != jobID || got[0].Attempt != 1 {
		t.Fatalf("%+v %v", got, err)
	}
	var jstatus, jerr, vstatus string
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text, error FROM media.transcode_jobs WHERE id=$1`, jobID).Scan(&jstatus, &jerr)
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text FROM media.videos WHERE id=$1`, vid).Scan(&vstatus)
	if jstatus != "FAILED" || jerr != store.LostJobError || vstatus != "PROCESSING" {
		t.Fatalf("job=%s/%q video=%s", jstatus, jerr, vstatus)
	}

	// One new video.uploaded with a fresh event_id and the same data.
	var payload []byte
	if err := pg.Pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject='video.uploaded'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var env struct {
		EventID string `json:"event_id"`
		Type    string `json:"type"`
		Data    job.UploadedEvent
	}
	_ = json.Unmarshal(payload, &env)
	var rawKey string
	var size int64
	_ = pg.Pool.QueryRow(ctx, `SELECT raw_key, size_bytes FROM media.videos WHERE id=$1`, vid).Scan(&rawKey, &size)
	if env.Type != "video.uploaded" || env.Data.VideoID != vid.String() || env.Data.RawKey != rawKey ||
		env.Data.SizeBytes != size || env.Data.ContentType != "video/mp4" || env.Data.RawBucket != "winkey-raw" {
		t.Fatalf("event: %s", payload)
	}
	if _, err := uuid.Parse(env.EventID); err != nil {
		t.Fatalf("event_id: %v", err)
	}
	if count(t, pg, `SELECT count(*) FROM media.outbox WHERE subject='video.failed'`) != 0 {
		t.Fatal("no video.failed while retries are left")
	}

	// The retry proceeds normally: BeginJob accepts the PROCESSING video as attempt 2.
	b, err := st.BeginJob(ctx, vid, "x264", "w2")
	if err != nil || b.Skip || b.Attempt != 2 {
		t.Fatalf("retry: %+v %v", b, err)
	}
	// A second sweep finds nothing (the job was already handled; the new one is fresh).
	if got, _ := st.ReconcileStale(ctx, stale, 3, 20); len(got) != 0 {
		t.Fatalf("second sweep: %+v", got)
	}
}

func TestReconcileStaleExhaustedFailsVideo(t *testing.T) {
	pg := testkit.StartPostgres(t)
	st := &store.Postgres{Pool: pg.Pool}
	ctx := context.Background()
	vid, jobID := runningJob(t, pg, st, 3)
	ageJob(t, pg, jobID, "15 minutes", "1 hour")

	got, err := st.ReconcileStale(ctx, stale, 3, 20)
	if err != nil || len(got) != 1 || got[0].Retried || !got[0].Failed || got[0].Attempt != 3 {
		t.Fatalf("%+v %v", got, err)
	}
	var vstatus, verr, jstatus string
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text, error FROM media.videos WHERE id=$1`, vid).Scan(&vstatus, &verr)
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text FROM media.transcode_jobs WHERE id=$1`, jobID).Scan(&jstatus)
	if vstatus != "FAILED" || verr != job.GaveUpFailure.Message || jstatus != "FAILED" {
		t.Fatalf("video=%s %q job=%s", vstatus, verr, jstatus)
	}
	if count(t, pg, `SELECT count(*) FROM media.outbox WHERE subject='video.uploaded'`) != 0 {
		t.Fatal("must not retry after max attempts")
	}
	var payload []byte
	if err := pg.Pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject='video.failed'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var env struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(payload, &env)
	if env.Data["reason"] != "INTERNAL" || env.Data["job_id"] != jobID.String() || env.Data["attempt"] != float64(3) || env.Data["video_id"] != vid.String() {
		t.Fatalf("video.failed: %s", payload)
	}
	// Exactly one failed job row for the last attempt (no duplicate job was recorded).
	if n := count(t, pg, `SELECT count(*) FROM media.transcode_jobs WHERE video_id=$1`, vid); n != 3 {
		t.Fatalf("%d job rows, want 3", n)
	}
}

func TestReconcileUsesStartedAtWhenNeverHeartbeated(t *testing.T) {
	pg := testkit.StartPostgres(t)
	st := &store.Postgres{Pool: pg.Pool}
	ctx := context.Background()
	_, jobID := runningJob(t, pg, st, 1)

	// A job created before heartbeats existed has heartbeat_at NULL.
	ageJob(t, pg, jobID, "", "5 minutes")
	if got, _ := st.ReconcileStale(ctx, stale, 3, 20); len(got) != 0 {
		t.Fatalf("started 5 minutes ago must not be stale: %+v", got)
	}
	ageJob(t, pg, jobID, "", "25 minutes")
	if got, _ := st.ReconcileStale(ctx, stale, 3, 20); len(got) != 1 || !got[0].Retried {
		t.Fatalf("started 25 minutes ago with no heartbeat must be reconciled: %+v", got)
	}
}

func TestReconcileClosesJobOfVideoThatAlreadyLeftProcessing(t *testing.T) {
	pg := testkit.StartPostgres(t)
	st := &store.Postgres{Pool: pg.Pool}
	ctx := context.Background()
	vid, jobID := runningJob(t, pg, st, 1)
	// The video failed through another path (e.g. the max-deliveries watcher) while its job row stayed RUNNING.
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET status='FAILED', error='x' WHERE id=$1`, vid); err != nil {
		t.Fatal(err)
	}
	ageJob(t, pg, jobID, "20 minutes", "1 hour")

	got, err := st.ReconcileStale(ctx, stale, 3, 20)
	if err != nil || len(got) != 1 || got[0].Retried || got[0].Failed {
		t.Fatalf("%+v %v", got, err)
	}
	if n := count(t, pg, `SELECT count(*) FROM media.outbox WHERE subject IN ('video.uploaded','video.failed')`); n != 0 {
		t.Fatalf("%d events for a video that is already FAILED", n)
	}
	var jstatus string
	_ = pg.Pool.QueryRow(ctx, `SELECT status::text FROM media.transcode_jobs WHERE id=$1`, jobID).Scan(&jstatus)
	if jstatus != "FAILED" {
		t.Fatalf("job=%s", jstatus)
	}
}

func TestReconcileRespectsBatchLimit(t *testing.T) {
	pg := testkit.StartPostgres(t)
	st := &store.Postgres{Pool: pg.Pool}
	for i := 0; i < 3; i++ {
		_, jobID := runningJob(t, pg, st, 1)
		ageJob(t, pg, jobID, "20 minutes", "1 hour")
	}
	got, err := st.ReconcileStale(context.Background(), stale, 3, 2)
	if err != nil || len(got) != 2 {
		t.Fatalf("limit 2: %+v %v", got, err)
	}
	if got, _ = st.ReconcileStale(context.Background(), stale, 3, 2); len(got) != 1 {
		t.Fatalf("remaining: %+v", got)
	}
}

// Several workers run a reconciler at the same time: every lost job must be
// handled exactly once (one retry event or one video.failed, never two).
func TestReconcileTwoReconcilersRace(t *testing.T) {
	pg := testkit.StartPostgres(t)
	st := &store.Postgres{Pool: pg.Pool}
	const jobs = 12
	retry := map[uuid.UUID]bool{}
	exhausted := map[uuid.UUID]bool{}
	for i := 0; i < jobs; i++ {
		attempt := 1
		if i%3 == 0 {
			attempt = 3 // a third of them are out of attempts
		}
		vid, jobID := runningJob(t, pg, st, attempt)
		ageJob(t, pg, jobID, "20 minutes", "1 hour")
		if attempt == 3 {
			exhausted[vid] = true
		} else {
			retry[vid] = true
		}
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	handled := map[uuid.UUID]int{}
	start := make(chan struct{})
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for round := 0; round < 3; round++ {
				got, err := st.ReconcileStale(context.Background(), stale, 3, 20)
				if err != nil {
					t.Errorf("reconcile: %v", err)
					return
				}
				mu.Lock()
				for _, r := range got {
					handled[r.JobID]++
				}
				mu.Unlock()
			}
		}()
	}
	close(start)
	wg.Wait()

	for id, n := range handled {
		if n != 1 {
			t.Errorf("job %s handled %d times", id, n)
		}
	}
	if len(handled) != jobs {
		t.Errorf("handled %d jobs, want %d", len(handled), jobs)
	}
	if n := count(t, pg, `SELECT count(*) FROM media.outbox WHERE subject='video.uploaded'`); n != len(retry) {
		t.Errorf("%d video.uploaded events, want %d (one per retried video)", n, len(retry))
	}
	if n := count(t, pg, `SELECT count(*) FROM media.outbox WHERE subject='video.failed'`); n != len(exhausted) {
		t.Errorf("%d video.failed events, want %d (one per exhausted video)", n, len(exhausted))
	}
	if n := count(t, pg, `SELECT count(*) FROM media.transcode_jobs WHERE status='RUNNING'`); n != 0 {
		t.Errorf("%d jobs still RUNNING", n)
	}
	if n := count(t, pg, `SELECT count(*) FROM media.videos WHERE status='FAILED'`); n != len(exhausted) {
		t.Errorf("%d FAILED videos, want %d", n, len(exhausted))
	}
}

// The reconciler and a worker starting a retry for the same video must not
// deadlock (both take the video lock first).
func TestReconcileVersusBeginJobNoDeadlock(t *testing.T) {
	pg := testkit.StartPostgres(t)
	st := &store.Postgres{Pool: pg.Pool}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for i := 0; i < 5; i++ {
		vid, jobID := runningJob(t, pg, st, 1)
		ageJob(t, pg, jobID, "20 minutes", "1 hour")
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _, _ = st.ReconcileStale(ctx, stale, 3, 20) }()
		go func() { defer wg.Done(); _, _ = st.BeginJob(ctx, vid, "x264", "w2") }()
		wg.Wait()
		if ctx.Err() != nil {
			t.Fatal("timed out: possible deadlock")
		}
		if n := count(t, pg, `SELECT count(*) FROM media.transcode_jobs WHERE video_id=$1 AND status='RUNNING'`, vid); n > 1 {
			t.Fatalf("%d active jobs for one video", n)
		}
	}
}
