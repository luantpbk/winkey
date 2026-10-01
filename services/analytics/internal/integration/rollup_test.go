package integration

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/analytics/internal/rollup"
)

// Task R1-b on real NATS + ClickHouse + PostgreSQL: events are published, the worker writes them to ClickHouse, the
// rollup copies the hourly aggregates into analytics.video_daily, and every row is compared with hand-computed values.
// Days are Asia/Ho_Chi_Minh (UTC+7): 2026-09-30 is [2026-09-29T17:00Z, 2026-09-30T17:00Z), so a sample at
// 16:59:59Z is on the 30th and one at 17:00:00Z is on 1 October.

var (
	ownerA = uuid.MustParse("0192f5e0-0000-7000-8000-00000000000a")
	ownerB = uuid.MustParse("0192f5e0-0000-7000-8000-00000000000b")
	vidA1  = uuid.MustParse("0192f5e1-0000-7000-8000-0000000000a1")
	vidA2  = uuid.MustParse("0192f5e1-0000-7000-8000-0000000000a2")
	vidB1  = uuid.MustParse("0192f5e1-0000-7000-8000-0000000000b1")
)

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

var seqCounter int

func mk(video, owner uuid.UUID, playback int, viewer int, kind string, seq int, when string, watched, rebuffer int, startup *int, errCode *string) sample {
	seqCounter++
	sm := sample{
		id: uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("rollup-%d", seqCounter))), video: video, owner: owner,
		playback: uuid.NewSHA1(uuid.NameSpaceURL, []byte(fmt.Sprintf("rollup-pb-%d", playback))), viewer: viewerKey(viewer),
		kind: kind, seq: seq, received: at(when), watched: watched, rebuffer: rebuffer, errCode: errCode,
	}
	if startup != nil {
		sm.hasStartup, sm.startup = true, *startup
	}
	return sm
}

func ip(v int) *int       { return &v }
func sp(v string) *string { return &v }

// rollupSamples is the data set; the expected rows are in wantRows (computed by hand from it).
func rollupSamples() []sample {
	return []sample{
		// A1: three days, with the day boundary in the middle.
		mk(vidA1, ownerA, 1, 1, "start", 0, "2026-09-28T17:30:00Z", 1000, 0, ip(400), nil),     // 09-29
		mk(vidA1, ownerA, 1, 1, "heartbeat", 1, "2026-09-30T16:59:59Z", 10000, 500, nil, nil),  // 09-30 (last second)
		mk(vidA1, ownerA, 1, 1, "heartbeat", 2, "2026-09-30T17:00:00Z", 20000, 1500, nil, nil), // 10-01 (first second)
		mk(vidA1, ownerA, 2, 2, "start", 0, "2026-09-30T17:00:00Z", 2000, 0, ip(800), nil),     // 10-01
		mk(vidA1, ownerA, 2, 2, "end", 1, "2026-09-30T20:00:00Z", 3000, 0, nil, sp("manifestLoadError")),
		// A2: two starts on the same day (equal startup, so the quantiles do not depend on the estimator).
		mk(vidA2, ownerA, 3, 3, "start", 0, "2026-09-29T10:00:00Z", 500, 0, ip(300), nil), // 09-29
		mk(vidA2, ownerA, 4, 1, "start", 0, "2026-09-29T11:00:00Z", 700, 0, ip(300), nil), // 09-29
		// B1 (another owner).
		mk(vidB1, ownerB, 5, 2, "start", 0, "2026-09-30T05:00:00Z", 4000, 1000, ip(250), nil), // 09-30
		// Outside the 3-day window ending 2026-10-01: 09-27. It reaches ClickHouse, never analytics.video_daily.
		mk(vidA1, ownerA, 6, 1, "start", 0, "2026-09-27T05:00:00Z", 9999, 9999, ip(1), nil),
	}
}

type wantRow struct {
	video                                      uuid.UUID
	owner                                      uuid.UUID
	day                                        string
	starts, watched, rebuffer, errors, viewers int64
	p50, p95                                   *int32
}

func i32(v int32) *int32 { return &v }

var wantRows = []wantRow{
	// A1 2026-09-29: the start at 17:30Z on 09-28 (00:30 on the 29th in Ho Chi Minh).
	{vidA1, ownerA, "2026-09-29", 1, 1000, 0, 0, 1, i32(400), i32(400)},
	// A1 2026-09-30: only the heartbeat at 16:59:59Z; no start, so the percentiles are NULL (ClickHouse says nan).
	{vidA1, ownerA, "2026-09-30", 0, 10000, 500, 0, 1, nil, nil},
	// A1 2026-10-01: the heartbeat at 17:00:00Z, one start, the end with an error; viewers v1 and v2.
	{vidA1, ownerA, "2026-10-01", 1, 25000, 1500, 1, 2, i32(800), i32(800)},
	// A2 2026-09-29: two starts, viewers v3 and v1.
	{vidA2, ownerA, "2026-09-29", 2, 1200, 0, 0, 2, i32(300), i32(300)},
	// B1 2026-09-30.
	{vidB1, ownerB, "2026-09-30", 1, 4000, 1000, 0, 1, i32(250), i32(250)},
}

type dbRow struct {
	wantRow
	refreshed time.Time
}

func readDaily(t *testing.T, pg *testkit.Postgres) []dbRow {
	t.Helper()
	rows, err := pg.Pool.Query(context.Background(), `
		SELECT video_id, owner_id, day::text, starts, watched_ms, rebuffer_ms, errors, viewers, startup_p50_ms, startup_p95_ms, refreshed_at
		FROM analytics.video_daily ORDER BY video_id, day`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []dbRow
	for rows.Next() {
		var r dbRow
		if err := rows.Scan(&r.video, &r.owner, &r.day, &r.starts, &r.watched, &r.rebuffer, &r.errors, &r.viewers, &r.p50, &r.p95, &r.refreshed); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func same32(a, b *int32) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

func assertDaily(t *testing.T, got []dbRow, want []wantRow) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%d rows, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		g := got[i]
		if g.video != w.video || g.owner != w.owner || g.day != w.day || g.starts != w.starts || g.watched != w.watched ||
			g.rebuffer != w.rebuffer || g.errors != w.errors || g.viewers != w.viewers || !same32(g.p50, w.p50) || !same32(g.p95, w.p95) {
			t.Errorf("row %d (%s %s):\n got %+v p50=%v p95=%v\nwant %+v p50=%v p95=%v", i, w.video, w.day, g.wantRow, g.p50, g.p95, w, w.p50, w.p95)
		}
	}
}

func TestRollupGivesTheHandComputedDaysAndASecondRunChangesNothing(t *testing.T) {
	s := startStack(t)
	s.migrate()
	pg := testkit.StartPostgres(t)
	samples := rollupSamples()
	s.publish(samples)
	s.startWorker()
	waitFor(t, 90*time.Second, "every sample in ClickHouse", func() bool { return s.count() == uint64(len(samples)) })
	waitFor(t, 30*time.Second, "all acknowledged", func() bool { i := s.info(); return i.NumPending == 0 && i.NumAckPending == 0 })

	now := at("2026-10-01T10:00:00Z") // 17:00 on 2026-10-01 in Ho Chi Minh
	src, sink := &rollup.ClickHouse{Conn: s.conn}, &rollup.Postgres{Pool: pg.Pool}
	run := &rollup.Runner{Source: src, Sink: sink, Log: quiet(), Interval: time.Minute, WindowDays: 3, BackfillDays: 3,
		Now: func() time.Time { return now }}
	if !run.RunOnce(context.Background()) {
		t.Fatal("the rollup failed")
	}
	first := readDaily(t, pg)
	assertDaily(t, first, wantRows)

	// Second run: the same ClickHouse data gives 0 changed rows and refreshed_at does not move.
	rows, err := src.Days(context.Background(), rollup.WindowStart(now, 3))
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := sink.Apply(context.Background(), rows); err != nil || changed != 0 {
		t.Fatalf("second Apply changed %d rows (%v), want 0", changed, err)
	}
	if !run.RunOnce(context.Background()) {
		t.Fatal("second run failed")
	}
	second := readDaily(t, pg)
	assertDaily(t, second, wantRows)
	for i := range first {
		if !first[i].refreshed.Equal(second[i].refreshed) {
			t.Errorf("row %d: refreshed_at moved from %s to %s although nothing changed", i, first[i].refreshed, second[i].refreshed)
		}
	}

	// A late sample changes exactly the rows it belongs to: only their refreshed_at moves.
	s.publish([]sample{mk(vidB1, ownerB, 7, 3, "heartbeat", 1, "2026-09-30T06:00:00Z", 1000, 0, nil, nil)})
	waitFor(t, 60*time.Second, "the late sample", func() bool { return s.count() == uint64(len(samples)+1) })
	waitFor(t, 30*time.Second, "acknowledged", func() bool { i := s.info(); return i.NumPending == 0 && i.NumAckPending == 0 })
	if !run.RunOnce(context.Background()) {
		t.Fatal("third run failed")
	}
	third := readDaily(t, pg)
	want := append([]wantRow(nil), wantRows...)
	want[4].watched, want[4].viewers = 5000, 2 // B1 09-30: +1000 ms, viewer v3 is new
	assertDaily(t, third, want)
	for i := range third {
		moved := !third[i].refreshed.Equal(second[i].refreshed)
		if moved != (i == 4) {
			t.Errorf("row %d: refreshed_at moved=%v", i, moved)
		}
	}
}

// The rollup keeps working over a window that is empty, and a video of the window with nothing in ClickHouse yet
// does not create a row.
func TestRollupOfAnEmptyClickHouseWritesNothing(t *testing.T) {
	s := startStack(t)
	s.migrate()
	pg := testkit.StartPostgres(t)
	run := &rollup.Runner{Source: &rollup.ClickHouse{Conn: s.conn}, Sink: &rollup.Postgres{Pool: pg.Pool}, Log: quiet(),
		Interval: time.Minute, WindowDays: 3, BackfillDays: 8, Now: func() time.Time { return at("2026-10-01T10:00:00Z") }}
	if !run.RunOnce(context.Background()) {
		t.Fatal("run failed")
	}
	if got := readDaily(t, pg); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
}

// ClickHouse down: the run fails (counted), nothing is written, and the next run after it is back succeeds.
func TestRollupSurvivesClickHouseBeingDown(t *testing.T) {
	s := startStack(t)
	s.migrate()
	pg := testkit.StartPostgres(t)
	samples := rollupSamples()
	s.publish(samples)
	s.startWorker()
	waitFor(t, 90*time.Second, "every sample in ClickHouse", func() bool { return s.count() == uint64(len(samples)) })
	run := &rollup.Runner{Source: &rollup.ClickHouse{Conn: s.conn}, Sink: &rollup.Postgres{Pool: pg.Pool}, Log: quiet(),
		Interval: time.Minute, WindowDays: 3, BackfillDays: 3, Now: func() time.Time { return at("2026-10-01T10:00:00Z") }}
	s.proxy.Down()
	if run.RunOnce(context.Background()) {
		t.Fatal("a run with ClickHouse down must fail")
	}
	if got := readDaily(t, pg); len(got) != 0 {
		t.Fatalf("rows written from a failed run: %+v", got)
	}
	s.proxy.Up(t)
	waitFor(t, 60*time.Second, "a successful run after ClickHouse is back", func() bool { return run.RunOnce(context.Background()) })
	assertDaily(t, readDaily(t, pg), wantRows)
}
