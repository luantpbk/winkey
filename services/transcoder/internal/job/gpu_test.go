//go:build gpu

// GPU tests run on gpu-01 (needs a working h264_nvenc):
//
//	go test -tags gpu -run GPU -v -timeout 30m ./internal/job/...
//
// Set FFMPEG_PATH / FFPROBE_PATH when ffmpeg is not on PATH. They run the same
// pipeline as the x264 tests with ENCODER=nvenc, fail if the job silently fell
// back to x264, and report wall time and x-realtime speed, with peak CPU and
// GPU utilisation for the benchmark.
package job_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

func requireNVENC(t *testing.T) job.Tools {
	t.Helper()
	tools := testutil.ToolsFromEnv(t)
	if enc, _ := tools.ResolveEncoder(context.Background(), "auto"); enc != media.EncoderNVENC {
		t.Fatal("h264_nvenc test encode failed: this machine has no working NVENC (driver >= 570, ffmpeg with nvenc)")
	}
	return tools
}

// peaks samples CPU utilisation (all cores) and, when nvidia-smi is available,
// GPU and NVENC utilisation once per second until stopped.
type peaks struct {
	cpu, gpu, enc float64
	stop          chan struct{}
	wg            sync.WaitGroup
}

func startPeaks() *peaks {
	p := &peaks{stop: make(chan struct{})}
	p.wg.Add(2)
	go func() {
		defer p.wg.Done()
		for {
			select {
			case <-p.stop:
				return
			default:
			}
			if v, err := cpu.Percent(time.Second, false); err == nil && len(v) > 0 && v[0] > p.cpu {
				p.cpu = v[0]
			}
		}
	}()
	go func() {
		defer p.wg.Done()
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-p.stop:
				return
			case <-t.C:
			}
			out, err := exec.Command("nvidia-smi", "--query-gpu=utilization.gpu,utilization.encoder",
				"--format=csv,noheader,nounits").Output()
			if err != nil {
				return // no nvidia-smi: GPU peaks stay 0
			}
			f := strings.Split(strings.TrimSpace(strings.Split(string(out), "\n")[0]), ",")
			if len(f) == 2 {
				g, _ := strconv.ParseFloat(strings.TrimSpace(f[0]), 64)
				e, _ := strconv.ParseFloat(strings.TrimSpace(f[1]), 64)
				p.gpu, p.enc = max(p.gpu, g), max(p.enc, e)
			}
		}
	}()
	return p
}

func (p *peaks) finish() { close(p.stop); p.wg.Wait() }

func runFlow(t *testing.T, tools job.Tools, encoder string, c testutil.Clip) (*testutil.Flow, job.Result) {
	t.Helper()
	clip := testutil.MakeClip(t, tools, t.TempDir(), c)
	f := testutil.NewFlow(t, tools, encoder, clip)
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionAck || res.Stats == nil || len(f.Store.Ready) != 1 {
		t.Fatalf("%s/%s: %+v (fails: %+v)", encoder, c.Name, res, f.Store.Fails)
	}
	return f, res
}

func TestGPUEndToEnd(t *testing.T) {
	tools := requireNVENC(t)
	for _, c := range []testutil.Clip{testutil.ClipLandscape, testutil.ClipPortrait, testutil.ClipSilent, testutil.ClipTenBit, testutil.ClipRotated, testutil.ClipSmall} {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			f, res := runFlow(t, tools, media.EncoderNVENC, c)
			r := f.Store.Ready[0]
			if r.Encoder != media.EncoderNVENC || len(f.Store.Encoders) != 0 {
				t.Fatalf("fell back to x264 (encoder=%s, switches=%v)", r.Encoder, f.Store.Encoders)
			}
			var names []string
			for _, rd := range r.Renditions {
				names = append(names, rd.Name)
			}
			if strings.Join(names, ",") != strings.Join(c.WantRenditions, ",") {
				t.Fatalf("ladder %v, want %v", names, c.WantRenditions)
			}
			prefix := fmt.Sprintf("v/%s/a1/", f.Video.ID)
			pub := testutil.MaterializeHLS(t, f.Objs, testutil.MediaBucket, prefix)
			if err := media.VerifyOutput(pub, r.Renditions); err != nil {
				t.Fatal(err)
			}
			for _, rd := range r.Renditions {
				vi, err := tools.Probe(context.Background(), filepath.Join(pub, rd.Name, "index.m3u8"))
				if err != nil || vi.DisplayW != rd.Width || vi.DisplayH != rd.Height || !vi.HasAudio || vi.PixFmt != "yuv420p" {
					t.Errorf("%s: %+v %v", rd.Name, vi, err)
				}
			}
			t.Logf("nvenc %-10s media=%3.0fs encode=%6.1fs total=%6.1fs  x%.1f realtime",
				c.Name, res.Stats.MediaSec, res.Stats.EncodeWall.Seconds(), res.Stats.TotalWall.Seconds(), res.Stats.XRealtime())
		})
	}
}

// TestGPUBenchmark reports x-realtime and peak utilisation for a 1080p30
// clip with nvenc and with x264 (veryfast), and for two concurrent NVENC jobs
// (the default WORKER_CONCURRENCY). Duration: BENCH_SECONDS (default 120).
func TestGPUBenchmark(t *testing.T) {
	tools := requireNVENC(t)
	secs := 120
	if v, err := strconv.Atoi(os.Getenv("BENCH_SECONDS")); err == nil && v > 0 {
		secs = v
	}
	clip := testutil.Clip{Name: "bench1080", W: 1920, H: 1080, Seconds: secs, Audio: true, PixFmt: "yuv420p"}
	path := testutil.MakeClip(t, tools, t.TempDir(), clip)

	type row struct {
		label string
		wall  time.Duration
		xrt   float64
		p     *peaks
	}
	var rows []row
	one := func(label, encoder string) {
		f := testutil.NewFlow(t, tools, encoder, path)
		p := startPeaks()
		res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
		p.finish()
		if res.Stats == nil {
			t.Fatalf("%s: %+v", label, res)
		}
		rows = append(rows, row{label, res.Stats.EncodeWall, res.Stats.XRealtime(), p})
	}
	one("nvenc x1", media.EncoderNVENC)
	one("x264 veryfast x1", media.EncoderX264)

	// Two concurrent NVENC jobs.
	flows := []*testutil.Flow{testutil.NewFlow(t, tools, media.EncoderNVENC, path), testutil.NewFlow(t, tools, media.EncoderNVENC, path)}
	p := startPeaks()
	start := time.Now()
	var wg sync.WaitGroup
	xrts := make([]float64, len(flows))
	for i, f := range flows {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3}); res.Stats != nil {
				xrts[i] = res.Stats.XRealtime()
			}
		}()
	}
	wg.Wait()
	p.finish()
	rows = append(rows, row{"nvenc x2 (concurrent, per job)", time.Since(start), (xrts[0] + xrts[1]) / 2, p})

	t.Logf("benchmark: %ds of 1080p30 testsrc2, 3 renditions", secs)
	t.Logf("%-32s %10s %12s %8s %8s %8s", "run", "wall", "x realtime", "cpu%", "gpu%", "nvenc%")
	for _, r := range rows {
		t.Logf("%-32s %10s %12.1f %8.0f %8.0f %8.0f", r.label, r.wall.Round(time.Second), r.xrt, r.p.cpu, r.p.gpu, r.p.enc)
	}
}
