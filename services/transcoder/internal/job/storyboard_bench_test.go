package job_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// TestStoryboardOverhead measures what the storyboard adds to a transcode (task V5a asks for at
// most about 10 %). It runs the whole pipeline twice on the same 1080p30 clip, CPU path (x264),
// once with the storyboard step replaced by an instant failure (the baseline) and once for real,
// and reports the difference. It is a measurement, not a gate: set BENCH_STORYBOARD=1
// (BENCH_SECONDS, default 120, is the clip length; BENCH_NOISE=1 adds camera-like noise, which
// makes decoding, and so the storyboard, heavier).
//
//	BENCH_STORYBOARD=1 go test -run StoryboardOverhead -v ./internal/job
func TestStoryboardOverhead(t *testing.T) {
	if os.Getenv("BENCH_STORYBOARD") == "" {
		t.Skip("set BENCH_STORYBOARD=1 to run the storyboard overhead measurement")
	}
	secs := 120
	if v, err := strconv.Atoi(os.Getenv("BENCH_SECONDS")); err == nil && v > 0 {
		secs = v
	}
	tools := testutil.ToolsFromEnv(t)
	dir := t.TempDir()
	clip := filepath.Join(dir, "bench.mp4")
	src := "testsrc2=size=1920x1080:rate=30"
	if os.Getenv("BENCH_NOISE") != "" {
		src += ",noise=alls=25:allf=t+u"
	}
	// A camera-like bitrate (about 8 Mb/s) so the decoder has real work to do.
	if b, err := exec.Command(tools.FFmpeg, "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", src, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
		"-t", fmt.Sprint(secs), "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "8M",
		"-c:a", "aac", "-shortest", clip).CombinedOutput(); err != nil {
		t.Fatalf("clip: %v\n%s", err, b)
	}

	run := func(withStoryboard bool) (job.Stats, time.Duration) {
		f := testutil.NewFlow(t, tools, media.EncoderX264, clip)
		if !withStoryboard {
			f.Pipeline.Storyboard = func(context.Context, job.StoryboardInput, string, float64) (job.StoryboardResult, error) {
				return job.StoryboardResult{}, fmt.Errorf("baseline: storyboard skipped")
			}
		}
		start := time.Now()
		res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
		wall := time.Since(start)
		if res.Action != job.ActionAck || res.Stats == nil || res.Stats.Storyboard != withStoryboard {
			t.Fatalf("run (storyboard=%v): %+v", withStoryboard, res)
		}
		return *res.Stats, wall
	}

	// Baseline first, then the real run, then the baseline again: the mean of the two baselines
	// absorbs a warm-up or thermal drift.
	_, base1 := run(false)
	withSB, full := run(true)
	_, base2 := run(false)
	base := (base1 + base2) / 2

	interval := media.StoryboardInterval(float64(secs))
	frames := media.StoryboardFrames(float64(secs), interval)
	t.Logf("host: %s/%s, %d CPUs; clip: %d s of 1080p30 (~8 Mb/s, noise=%v), x264 veryfast, 3 renditions",
		runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), secs, os.Getenv("BENCH_NOISE") != "")
	t.Logf("storyboard: interval %.3f s, %d frames, %d sheet(s)", interval, frames, media.StoryboardSheets(frames))
	t.Logf("job wall time without storyboard: %s and %s (mean %s)", base1.Round(10*time.Millisecond), base2.Round(10*time.Millisecond), base.Round(10*time.Millisecond))
	t.Logf("job wall time with    storyboard: %s", full.Round(10*time.Millisecond))
	t.Logf("storyboard step alone: %s = %.1f%% of the HLS encode (%s) and %+.1f%% on the whole job",
		withSB.StoryboardWall.Round(10*time.Millisecond), 100*withSB.StoryboardWall.Seconds()/withSB.EncodeWall.Seconds(),
		withSB.EncodeWall.Round(10*time.Millisecond), 100*(full.Seconds()-base.Seconds())/base.Seconds())
}
