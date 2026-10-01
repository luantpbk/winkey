package rollup

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func quiet() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func ts(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestPercentilesMapNaNToNullAndRound(t *testing.T) {
	nan := math.NaN()
	for name, c := range map[string]struct {
		p50, p95 float64
		want50   *int32
		want95   *int32
	}{
		"both nan (no start with a startup time)": {nan, nan, nil, nil},
		"rounded":                          {299.5, 900.4, ptr(300), ptr(900)},
		"round half away from zero":        {0.5, 1.49, ptr(1), ptr(1)},
		"zero":                             {0, 0, ptr(0), ptr(0)},
		"one nan":                          {nan, 12, nil, ptr(12)},
		"p50 above p95 is clamped (CHECK)": {500, 400, ptr(400), ptr(400)},
		"negative or infinite is null":     {-1, math.Inf(1), nil, nil},
		"huge is capped":                   {1e12, 1e13, ptr(math.MaxInt32), ptr(math.MaxInt32)},
	} {
		a, b := Percentiles(c.p50, c.p95)
		if !same(a, c.want50) || !same(b, c.want95) {
			t.Errorf("%s: %v %v", name, deref(a), deref(b))
		}
	}
}

func ptr(v int32) *int32 { return &v }
func same(a, b *int32) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
func deref(p *int32) any {
	if p == nil {
		return nil
	}
	return *p
}

func TestTodayAndWindowStartUseHoChiMinhDays(t *testing.T) {
	// 16:59:59Z is still the same day in UTC+7 (23:59:59); 17:00:00Z is the next day (00:00:00).
	for in, want := range map[string]string{
		"2026-10-01T16:59:59Z": "2026-10-01",
		"2026-10-01T17:00:00Z": "2026-10-02",
		"2026-12-31T23:00:00Z": "2027-01-01",
	} {
		if got := Today(ts(in)).Format("2006-01-02"); got != want {
			t.Errorf("Today(%s) = %s, want %s", in, got, want)
		}
	}
	// 3 days ending on 2026-10-01 start at 2026-09-29 00:00 in Ho Chi Minh = 2026-09-28 17:00 UTC.
	if got := WindowStart(ts("2026-10-01T16:59:59Z"), 3); !got.Equal(ts("2026-09-28T17:00:00Z")) {
		t.Errorf("window of 3 days: %s", got)
	}
	// One second later it is the next day: the window moves a whole day.
	if got := WindowStart(ts("2026-10-01T17:00:00Z"), 3); !got.Equal(ts("2026-09-29T17:00:00Z")) {
		t.Errorf("window of 3 days after the boundary: %s", got)
	}
	if got := WindowStart(ts("2026-10-01T05:00:00Z"), 1); !got.Equal(ts("2026-09-30T17:00:00Z")) {
		t.Errorf("window of 1 day: %s", got)
	}
}

type fakeSource struct {
	since []time.Time
	rows  []Day
	err   error
}

func (f *fakeSource) Days(_ context.Context, since time.Time) ([]Day, error) {
	f.since = append(f.since, since)
	return f.rows, f.err
}

type fakeSink struct {
	applied [][]Day
	swept   []time.Time
	changed int64
	err     error
	sweepEr error
}

func (f *fakeSink) Apply(_ context.Context, rows []Day) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	f.applied = append(f.applied, rows)
	return f.changed, nil
}
func (f *fakeSink) Sweep(_ context.Context, before time.Time) (int64, error) {
	if f.sweepEr != nil {
		return 0, f.sweepEr
	}
	f.swept = append(f.swept, before)
	return 2, nil
}

func newRunner(src *fakeSource, sink *fakeSink, now *time.Time) *Runner {
	return &Runner{Source: src, Sink: sink, Log: quiet(), Interval: time.Minute, WindowDays: 3, BackfillDays: 8,
		Now: func() time.Time { return *now }}
}

func TestFirstRunBackfillsThenTheWindowIsUsed(t *testing.T) {
	now := ts("2026-10-01T05:00:00Z")
	src, sink := &fakeSource{rows: []Day{{Starts: 1}}}, &fakeSink{changed: 1}
	r := newRunner(src, sink, &now)
	for i := 0; i < 3; i++ {
		if !r.RunOnce(context.Background()) {
			t.Fatal("run failed")
		}
	}
	if len(src.since) != 3 || !src.since[0].Equal(WindowStart(now, 8)) || !src.since[1].Equal(WindowStart(now, 3)) || !src.since[2].Equal(WindowStart(now, 3)) {
		t.Fatalf("windows %v", src.since)
	}
	if len(sink.applied) != 3 || len(sink.applied[0]) != 1 {
		t.Fatalf("%v", sink.applied)
	}
}

func TestAFailedRunIsCountedRetriedAndKeepsTheBackfill(t *testing.T) {
	now := ts("2026-10-01T05:00:00Z")
	src, sink := &fakeSource{err: errors.New("clickhouse down")}, &fakeSink{}
	r := newRunner(src, sink, &now)
	before := testutil.ToFloat64(runErrors)
	if r.RunOnce(context.Background()) || testutil.ToFloat64(runErrors) != before+1 || len(sink.applied) != 0 {
		t.Fatal("a failed read must be counted and write nothing")
	}
	src.err, sink.err = nil, errors.New("postgres down")
	if r.RunOnce(context.Background()) || testutil.ToFloat64(runErrors) != before+2 {
		t.Fatal("a failed write must be counted")
	}
	sink.err = nil
	if !r.RunOnce(context.Background()) {
		t.Fatal("the next tick must succeed")
	}
	// The backfill window is still the one of the first SUCCESSFUL run.
	if got := src.since[len(src.since)-1]; !got.Equal(WindowStart(now, 8)) {
		t.Fatalf("after failures the window was %s, want the backfill window", got)
	}
}

func TestSuccessSetsTheTimestampAndCountsChangedRows(t *testing.T) {
	now := ts("2026-10-01T05:00:00Z")
	r := newRunner(&fakeSource{}, &fakeSink{changed: 7}, &now)
	rows := testutil.ToFloat64(rowsUpserted)
	r.RunOnce(context.Background())
	if testutil.ToFloat64(rowsUpserted) != rows+7 {
		t.Fatal("rows_upserted_total")
	}
	if ago := time.Since(time.Unix(int64(testutil.ToFloat64(lastSuccess)), 0)); ago > time.Minute {
		t.Fatalf("last success %v ago", ago)
	}
}

func TestSweepRunsOncePerHoChiMinhDayAfterASuccessfulRun(t *testing.T) {
	now := ts("2026-10-01T16:59:59Z") // 2026-10-01 23:59:59 in Ho Chi Minh
	src, sink := &fakeSource{}, &fakeSink{}
	r := newRunner(src, sink, &now)
	r.RunOnce(context.Background())
	r.RunOnce(context.Background())
	if len(sink.swept) != 1 || !sink.swept[0].Equal(Today(now).AddDate(0, 0, -730)) {
		t.Fatalf("sweeps %v", sink.swept)
	}
	now = ts("2026-10-01T17:00:00Z") // after midnight in Ho Chi Minh: the first run of the new day sweeps again
	r.RunOnce(context.Background())
	r.RunOnce(context.Background())
	if len(sink.swept) != 2 || !sink.swept[1].Equal(ts("2024-10-02T00:00:00Z")) {
		t.Fatalf("sweeps %v", sink.swept)
	}
	// A failed sweep is retried at the next tick (and counted), a failed run does not sweep.
	now = ts("2026-10-02T17:00:00Z")
	sink.sweepEr = errors.New("boom")
	if r.RunOnce(context.Background()) {
		t.Fatal("a failed sweep must fail the run")
	}
	sink.sweepEr = nil
	r.RunOnce(context.Background())
	if len(sink.swept) != 3 {
		t.Fatalf("sweeps %v", sink.swept)
	}
	sink.err = errors.New("pg down")
	now = ts("2026-10-03T17:00:00Z")
	r.RunOnce(context.Background())
	if len(sink.swept) != 3 {
		t.Fatal("swept after a failed run")
	}
}

func TestRunStopsWithTheContextAndRunsOnTheTick(t *testing.T) {
	now := ts("2026-10-01T05:00:00Z")
	src := &fakeSource{}
	r := newRunner(src, &fakeSink{}, &now)
	r.Interval = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx); close(done) }()
	time.Sleep(150 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop")
	}
	if len(src.since) < 3 {
		t.Fatalf("%d runs in 150ms at a 20ms interval", len(src.since))
	}
}
