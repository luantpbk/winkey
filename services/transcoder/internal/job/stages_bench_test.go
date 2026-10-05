package job_test

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// TestStageReport runs whole jobs on a generated 1080p30 clip (x264, in-memory store and objects, a
// raw archive) and prints where the time of each goes: the job's summary log line and one row per
// step. It is a measurement, not a gate (task V4-a/V4-b): set BENCH_STAGES=1; BENCH_SECONDS is the
// clip length (default 60) and BENCH_RUNS the number of jobs (default 1).
//
//	BENCH_STAGES=1 go test -run StageReport -v -timeout 60m ./internal/job
func TestStageReport(t *testing.T) {
	if os.Getenv("BENCH_STAGES") == "" {
		t.Skip("set BENCH_STAGES=1 to print the per-stage durations of whole jobs")
	}
	secs, runs := 60, 1
	if v, err := strconv.Atoi(os.Getenv("BENCH_SECONDS")); err == nil && v > 0 {
		secs = v
	}
	if v, err := strconv.Atoi(os.Getenv("BENCH_RUNS")); err == nil && v > 0 {
		runs = v
	}
	tools := testutil.ToolsFromEnv(t)
	clip := testutil.MakeClip(t, tools, t.TempDir(), testutil.Clip{
		Name: "stages", W: 1920, H: 1080, Seconds: secs, Audio: true, PixFmt: "yuv420p"})

	for i := 1; i <= runs; i++ {
		f := testutil.NewFlow(t, tools, media.EncoderX264, clip)
		f.Pipeline.Cfg.ArchiveDir = t.TempDir()
		var logs bytes.Buffer
		f.Pipeline.Log = slog.New(slog.NewJSONHandler(&logs, nil))
		start := time.Now()
		res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
		if res.Action != job.ActionAck || res.Stats == nil {
			t.Fatalf("run %d: %+v", i, res)
		}
		t.Logf("run %d: %d s of 1080p30 -> READY in %s (job_seconds %.3f)", i, secs, time.Since(start).Round(time.Millisecond), res.Stats.JobWall.Seconds())
		for _, s := range res.Steps {
			t.Logf("  %-10s %9.3f s", s.Step, s.Dur.Seconds())
		}
		for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
			if bytes.Contains(line, []byte(`"transcode succeeded"`)) {
				t.Logf("  summary: %s", line)
			}
		}
	}
}
