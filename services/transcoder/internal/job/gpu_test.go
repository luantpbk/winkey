//go:build gpu

// GPU tests run on gpu-01 (needs a working h264_nvenc):
//
//	FFMPEG_PATH=/opt/ffmpeg-7.1/bin/ffmpeg FFPROBE_PATH=/opt/ffmpeg-7.1/bin/ffprobe \
//	  go test -tags gpu -run GPU -v -timeout 30m ./internal/job/...
//
// They run the same pipeline as the x264 tests with ENCODER=nvenc, fail if the
// job silently fell back to x264, and report wall time and x-realtime speed.
// The benchmark also reports peak CPU, GPU, NVENC, NVDEC and VRAM, the GPU load
// measured BEFORE the runs (gpu-01's GPU is shared with other workloads such as
// a miner, so results are only meaningful next to that baseline), and compares
// -hwaccel cuda decoding with CPU decoding.
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

// gpuSample is one nvidia-smi reading.
type gpuSample struct {
	gpu, enc, dec float64 // utilisation %
	vramMiB       float64
	ok            bool
}

func readGPU() gpuSample {
	out, err := exec.Command("nvidia-smi",
		"--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,memory.used",
		"--format=csv,noheader,nounits").Output()
	if err != nil {
		return gpuSample{}
	}
	f := strings.Split(strings.TrimSpace(strings.Split(string(out), "\n")[0]), ",")
	if len(f) != 4 {
		return gpuSample{}
	}
	num := func(s string) float64 { v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); return v }
	return gpuSample{gpu: num(f[0]), enc: num(f[1]), dec: num(f[2]), vramMiB: num(f[3]), ok: true}
}

// peaks samples CPU utilisation (all cores) and, when nvidia-smi is available,
// GPU/NVENC/NVDEC utilisation and VRAM once per second until stopped.
type peaks struct {
	mu   sync.Mutex
	cpu  float64
	gpu  gpuSample
	stop chan struct{}
	wg   sync.WaitGroup
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
			if v, err := cpu.Percent(time.Second, false); err == nil && len(v) > 0 {
				p.mu.Lock()
				p.cpu = max(p.cpu, v[0])
				p.mu.Unlock()
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
			s := readGPU()
			if !s.ok {
				return // no nvidia-smi: GPU peaks stay 0
			}
			p.mu.Lock()
			p.gpu.gpu, p.gpu.enc = max(p.gpu.gpu, s.gpu), max(p.gpu.enc, s.enc)
			p.gpu.dec, p.gpu.vramMiB = max(p.gpu.dec, s.dec), max(p.gpu.vramMiB, s.vramMiB)
			p.mu.Unlock()
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

// TestGPUBenchmark reports x-realtime and peak utilisation for a 1080p30 clip:
// nvenc with NVDEC decode, nvenc with CPU decode, x264 (veryfast), and two
// concurrent NVENC jobs (the default WORKER_CONCURRENCY). Duration:
// BENCH_SECONDS (default 120). The run order puts nvenc first so a hwaccel
// problem is visible immediately.
func TestGPUBenchmark(t *testing.T) {
	tools := requireNVENC(t)
	secs := 120
	if v, err := strconv.Atoi(os.Getenv("BENCH_SECONDS")); err == nil && v > 0 {
		secs = v
	}
	clip := testutil.Clip{Name: "bench1080", W: 1920, H: 1080, Seconds: secs, Audio: true, PixFmt: "yuv420p"}
	path := testutil.MakeClip(t, tools, t.TempDir(), clip)

	base := readGPU()
	if base.ok {
		t.Logf("GPU load BEFORE the benchmark (other tenants, e.g. a miner): gpu %.0f%%, nvenc %.0f%%, nvdec %.0f%%, VRAM %.0f MiB",
			base.gpu, base.enc, base.dec, base.vramMiB)
	} else {
		t.Log("nvidia-smi not available: GPU/VRAM peaks and baseline are not reported")
	}

	type row struct {
		label string
		wall  time.Duration
		xrt   float64
		p     *peaks
		note  string
	}
	var rows []row
	one := func(label, encoder string, noHW bool) {
		f := testutil.NewFlow(t, tools, encoder, path)
		f.Pipeline.Cfg.NoHWDecode = noHW
		p := startPeaks()
		res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
		p.finish()
		if res.Stats == nil {
			t.Fatalf("%s: %+v", label, res)
		}
		note := ""
		if encoder == media.EncoderNVENC && res.Stats.Encoder != media.EncoderNVENC {
			note = "FELL BACK to x264"
		}
		rows = append(rows, row{label, res.Stats.EncodeWall, res.Stats.XRealtime(), p, note})
	}
	one("nvenc x1, NVDEC decode (-hwaccel cuda)", media.EncoderNVENC, false)
	one("nvenc x1, CPU decode", media.EncoderNVENC, true)
	one("x264 veryfast x1", media.EncoderX264, false)

	// Two concurrent NVENC jobs (the default WORKER_CONCURRENCY), with NVDEC and with CPU decode.
	concurrent := func(label string, noHW bool) {
		flows := []*testutil.Flow{testutil.NewFlow(t, tools, media.EncoderNVENC, path), testutil.NewFlow(t, tools, media.EncoderNVENC, path)}
		p := startPeaks()
		start := time.Now()
		var wg sync.WaitGroup
		xrts := make([]float64, len(flows))
		for i, f := range flows {
			f.Pipeline.Cfg.NoHWDecode = noHW
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
		rows = append(rows, row{label, time.Since(start), (xrts[0] + xrts[1]) / 2, p,
			fmt.Sprintf("jobs: x%.1f + x%.1f = x%.1f total", xrts[0], xrts[1], xrts[0]+xrts[1])})
	}
	concurrent("nvenc x2 concurrent, NVDEC (per job)", false)
	concurrent("nvenc x2 concurrent, CPU decode (per job)", true)

	t.Logf("benchmark: %ds of 1080p30 testsrc2 + sine, 3 renditions (1080p/720p/480p)", secs)
	t.Logf("%-40s %9s %11s %6s %6s %7s %7s %9s  %s", "run", "wall", "x realtime", "cpu%", "gpu%", "nvenc%", "nvdec%", "VRAM MiB", "note")
	for _, r := range rows {
		r.p.mu.Lock()
		t.Logf("%-40s %9s %11.1f %6.0f %6.0f %7.0f %7.0f %9.0f  %s", r.label, r.wall.Round(time.Second), r.xrt,
			r.p.cpu, r.p.gpu.gpu, r.p.gpu.enc, r.p.gpu.dec, r.p.gpu.vramMiB, r.note)
		r.p.mu.Unlock()
	}
}
