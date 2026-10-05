package job_test

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"strconv"
	"sync"
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
	mbps := 40.0
	if raw := os.Getenv("BENCH_UPLOAD_MBPS"); raw != "" {
		var err error
		mbps, err = strconv.ParseFloat(raw, 64)
		if err != nil || mbps <= 0 || math.IsNaN(mbps) || math.IsInf(mbps, 0) {
			t.Fatal("BENCH_UPLOAD_MBPS must be finite and positive")
		}
	}
	tools := testutil.ToolsFromEnv(t)
	version, err := exec.Command(tools.FFmpeg, "-version").Output()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("BENCH_UPLOAD_MBPS=%.3f (shared per-job decimal Mbit/s); %s", mbps, bytes.SplitN(version, []byte("\n"), 2)[0])
	clip := testutil.MakeClip(t, tools, t.TempDir(), testutil.Clip{
		Name: "stages", W: 1920, H: 1080, Seconds: secs, Audio: true, PixFmt: "yuv420p"})

	for i := 1; i <= runs; i++ {
		f := testutil.NewFlow(t, tools, media.EncoderX264, clip)
		f.Pipeline.Cfg.ArchiveDir = t.TempDir()
		f.Pipeline.Objects = &throttledObjects{Objects: f.Objs, bytesPerSecond: mbps * 1e6 / 8}
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
		// Before overlap these stages are serial, so their sum is the upload tail.
		// After overlap the summary's upload_tail_seconds is the authoritative value.
		var serialTail time.Duration
		for _, step := range res.Steps {
			if step.Step == job.StepPoster || step.Step == job.StepStoryboard || step.Step == job.StepUpload {
				serialTail += step.Dur
			}
		}
		t.Logf("serial poster+storyboard+upload span %.3f s (baseline tail; not an overlap tail)", serialTail.Seconds())
		for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
			if bytes.Contains(line, []byte(`"transcode succeeded"`)) {
				t.Logf("  summary: %s", line)
			}
		}
	}
}

// throttledObjects models ONE uplink shared by all UploadParallelism slots, rather than
// giving each concurrent upload its own Mbps budget. Only this measurement fixture is throttled.
// Reserving a completion time under the mutex permits concurrent callers without holding a
// lock across storage I/O; cancellation interrupts the timer and no object is written.
type throttledObjects struct {
	job.Objects
	mu             sync.Mutex
	next           time.Time
	bytesPerSecond float64
}

func (o *throttledObjects) UploadFile(ctx context.Context, bucket, key, src, contentType, cacheControl string) error {
	st, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("stat benchmark upload: %w", err)
	}
	o.mu.Lock()
	start := maxTime(o.next, time.Now())
	o.next = start.Add(time.Duration(float64(st.Size()) / o.bytesPerSecond * float64(time.Second)))
	delay := time.Until(o.next)
	o.mu.Unlock()
	timer := time.NewTimer(max(0, delay))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
	}
	return o.Objects.UploadFile(ctx, bucket, key, src, contentType, cacheControl)
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
