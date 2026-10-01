package rollup

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/testkit"
)

func d(video, owner uuid.UUID, day string, starts, watched int64, p50, p95 *int32) Day {
	t, _ := time.Parse("2006-01-02", day)
	return Day{VideoID: video, OwnerID: owner, Day: t, Starts: starts, WatchedMs: watched, RebufferMs: 10, Errors: 1, Viewers: starts, StartupP50Ms: p50, StartupP95Ms: p95}
}

func refreshedAt(t *testing.T, pg *testkit.Postgres, video uuid.UUID, day string) time.Time {
	t.Helper()
	var at time.Time
	if err := pg.Pool.QueryRow(context.Background(), `SELECT refreshed_at FROM analytics.video_daily WHERE video_id = $1 AND day = $2::date`, video, day).Scan(&at); err != nil {
		t.Fatal(err)
	}
	return at
}

// Real PostgreSQL 17 with the real migration 000015.
func TestApplyUpsertsKeepsRefreshedAtWhenNothingChangedAndSweeps(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	sink := &Postgres{Pool: pg.Pool}
	owner, v1, v2 := uuid.New(), uuid.New(), uuid.New()
	one := int32(400)

	rows := []Day{d(v1, owner, "2026-09-29", 3, 1000, &one, &one), d(v1, owner, "2026-09-30", 2, 500, nil, nil), d(v2, owner, "2026-09-30", 1, 9, nil, nil)}
	if n, err := sink.Apply(ctx, rows); err != nil || n != 3 {
		t.Fatalf("first apply: %d %v", n, err)
	}
	t1 := refreshedAt(t, pg, v1, "2026-09-29")

	time.Sleep(20 * time.Millisecond)
	if n, err := sink.Apply(ctx, rows); err != nil || n != 0 {
		t.Fatalf("identical apply changed %d rows (%v)", n, err)
	}
	if got := refreshedAt(t, pg, v1, "2026-09-29"); !got.Equal(t1) {
		t.Fatalf("refreshed_at moved without a change: %s -> %s", t1, got)
	}

	// One value of one row changes: only that row is updated and its refreshed_at moves.
	rows[1] = d(v1, owner, "2026-09-30", 2, 501, nil, nil)
	if n, err := sink.Apply(ctx, rows); err != nil || n != 1 {
		t.Fatalf("one changed row: %d %v", n, err)
	}
	if got := refreshedAt(t, pg, v1, "2026-09-29"); !got.Equal(t1) {
		t.Fatal("an unchanged row got a new refreshed_at")
	}
	if got := refreshedAt(t, pg, v1, "2026-09-30"); !got.After(t1) {
		t.Fatal("a changed row kept its refreshed_at")
	}
	// A percentile that appears (NULL -> value) and one that disappears are changes too (IS DISTINCT FROM, not <>).
	rows[1] = d(v1, owner, "2026-09-30", 2, 501, &one, &one)
	rows[0] = d(v1, owner, "2026-09-29", 3, 1000, nil, nil)
	if n, err := sink.Apply(ctx, rows); err != nil || n != 2 {
		t.Fatalf("NULL transitions: %d %v", n, err)
	}
	if n, err := sink.Apply(ctx, nil); err != nil || n != 0 {
		t.Fatalf("no rows: %d %v", n, err)
	}

	// More than one batch in one run: 2500 rows = 3 statements, one transaction.
	var many []Day
	for i := 0; i < 2500; i++ {
		many = append(many, d(uuid.New(), owner, "2026-09-28", 1, int64(i), nil, nil))
	}
	if n, err := sink.Apply(ctx, many); err != nil || n != 2500 {
		t.Fatalf("2500 rows: %d %v", n, err)
	}
	var total int
	if err := pg.Pool.QueryRow(ctx, `SELECT count(*) FROM analytics.video_daily`).Scan(&total); err != nil || total != 2503 {
		t.Fatalf("%d rows %v", total, err)
	}

	// A failing row rolls the whole run back (a CHECK: p50 > p95).
	bad := []Day{d(uuid.New(), owner, "2026-09-27", 1, 1, nil, nil), d(uuid.New(), owner, "2026-09-27", 1, 1, ptr(500), ptr(400))}
	if _, err := sink.Apply(ctx, bad); err == nil {
		t.Fatal("a constraint violation was accepted")
	}
	if err := pg.Pool.QueryRow(ctx, `SELECT count(*) FROM analytics.video_daily WHERE day = '2026-09-27'`).Scan(&total); err != nil || total != 0 {
		t.Fatalf("a failed run left %d rows (one transaction per run)", total)
	}

	// Retention: rows before the cut-off go, the cut-off day stays.
	cut, _ := time.Parse("2006-01-02", "2026-09-30")
	if n, err := sink.Sweep(ctx, cut); err != nil || n != 2501 { // 2500 on 09-28, v1 on 09-29
		t.Fatalf("sweep: %d %v", n, err)
	}
	if err := pg.Pool.QueryRow(ctx, `SELECT count(*) FROM analytics.video_daily`).Scan(&total); err != nil || total != 2 {
		t.Fatalf("%d rows left", total)
	}
}
