// Command quality-bench compares transcoder rate-control settings (ADR-039) on
// real source files: for every input it runs the exact production ffmpeg
// arguments (media.BuildHLSArgs) once per setting, then reports the segment
// bytes, the average bitrate and the VMAF score of every rendition.
//
// VMAF needs an ffmpeg built with libvmaf (-vmaf-ffmpeg); the encode ffmpeg
// can be another binary (e.g. the NVENC build on gpu-01).
//
//	quality-bench -encoder nvenc -settings abr,capped_crf:23,capped_crf:25 \
//	  -ffmpeg /usr/bin/ffmpeg -vmaf-ffmpeg ./ffmpeg-vmaf a.mp4 b.mov
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

type setting struct {
	label string
	mode  string
	level int // CRF or CQ; 0 = default
}

func parseSettings(s string) ([]setting, error) {
	var out []setting
	for _, f := range strings.Split(s, ",") {
		f = strings.TrimSpace(f)
		mode, lvl, _ := strings.Cut(f, ":")
		st := setting{label: f, mode: mode}
		switch mode {
		case media.RateControlABR:
		case media.RateControlCappedCRF:
			if lvl != "" {
				n, err := strconv.Atoi(lvl)
				if err != nil || n < 1 || n > 51 {
					return nil, fmt.Errorf("bad level in %q", f)
				}
				st.level = n
			}
		default:
			return nil, fmt.Errorf("unknown setting %q (want abr or capped_crf[:N])", f)
		}
		out = append(out, st)
	}
	return out, nil
}

type result struct {
	Input      string  `json:"input"`
	Setting    string  `json:"setting"`
	Rendition  string  `json:"rendition"`
	Bytes      int64   `json:"bytes"`
	Kbps       int     `json:"kbps"`
	VMAFMean   float64 `json:"vmaf_mean"`
	VMAFLow    float64 `json:"vmaf_p5"`
	EncodeSecs float64 `json:"encode_seconds"`
}

func main() {
	ffmpeg := flag.String("ffmpeg", "ffmpeg", "ffmpeg used for encoding")
	ffprobe := flag.String("ffprobe", "ffprobe", "ffprobe")
	vmafFF := flag.String("vmaf-ffmpeg", "", "ffmpeg built with libvmaf (default: -ffmpeg)")
	encoder := flag.String("encoder", media.EncoderX264, "x264 or nvenc")
	preset := flag.String("x264-preset", "veryfast", "x264 preset")
	settings := flag.String("settings", "abr,capped_crf", "comma list: abr, capped_crf[:CRF or CQ]")
	work := flag.String("work", "", "scratch directory (default: temp, removed afterwards)")
	jsonOut := flag.String("json", "", "also write results as JSON to this file")
	flag.Parse()
	if *vmafFF == "" {
		*vmafFF = *ffmpeg
	}
	sts, err := parseSettings(*settings)
	if err != nil || flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: quality-bench [flags] source...", err)
		os.Exit(2)
	}
	dir := *work
	if dir == "" {
		if dir, err = os.MkdirTemp("", "quality-bench-"); err != nil {
			fatal(err)
		}
		defer func() { _ = os.RemoveAll(dir) }()
	}

	ctx := context.Background()
	var all []result
	for i, src := range flag.Args() {
		info, err := probe(ctx, *ffprobe, src)
		if err != nil {
			fatal(fmt.Errorf("%s: %w", src, err))
		}
		rs := media.Select(info.DisplayW, info.DisplayH)
		for _, st := range sts {
			out := filepath.Join(dir, strconv.Itoa(i), strings.NewReplacer(":", "_").Replace(st.label))
			plan := media.HLSPlan{
				Input: src, OutDir: out, Encoder: *encoder, X264Preset: *preset,
				RateControl: st.mode, X264CRF: st.level, NVENCCQ: st.level,
				Renditions: rs, FPS: info.FPS, HasAudio: info.HasAudio, NoHWDecode: true,
			}
			if err := os.MkdirAll(out, 0o750); err != nil {
				fatal(err)
			}
			start := time.Now()
			if err := run(ctx, *ffmpeg, media.BuildHLSArgs(plan)...); err != nil {
				fatal(fmt.Errorf("encode %s %s: %w", src, st.label, err))
			}
			secs := time.Since(start).Seconds()
			for _, r := range rs {
				rdir := filepath.Join(out, r.Name)
				bytes, err := segmentBytes(rdir)
				if err != nil {
					fatal(err)
				}
				mean, low, err := vmaf(ctx, *vmafFF, filepath.Join(rdir, "index.m3u8"), src, info, filepath.Join(out, r.Name+".vmaf.json"))
				if err != nil {
					fatal(fmt.Errorf("vmaf %s %s %s: %w", src, st.label, r.Name, err))
				}
				res := result{
					Input: filepath.Base(src), Setting: st.label, Rendition: r.Name, Bytes: bytes,
					Kbps: int(float64(bytes) * 8 / 1000 / info.DurationSec), VMAFMean: mean, VMAFLow: low, EncodeSecs: secs,
				}
				all = append(all, res)
				fmt.Fprintf(os.Stderr, "%s %s %s: %d kbps, VMAF %.2f (p5 %.2f)\n", res.Input, res.Setting, res.Rendition, res.Kbps, mean, low)
			}
		}
	}
	printTable(all, sts)
	if *jsonOut != "" {
		b, _ := json.MarshalIndent(all, "", "  ")
		if err := os.WriteFile(*jsonOut, b, 0o600); err != nil {
			fatal(err)
		}
	}
}

// printTable prints one Markdown row per input/rendition/setting, with the
// size relative to the first setting (normally abr).
func printTable(all []result, sts []setting) {
	base := map[string]int64{}
	for _, r := range all {
		if r.Setting == sts[0].label {
			base[r.Input+"/"+r.Rendition] = r.Bytes
		}
	}
	fmt.Println("| Source | Rendition | Setting | kbps | Size vs " + sts[0].label + " | VMAF mean | VMAF p5 | Encode s |")
	fmt.Println("|---|---|---|---:|---:|---:|---:|---:|")
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Input != all[j].Input {
			return all[i].Input < all[j].Input
		}
		return all[i].Rendition > all[j].Rendition
	})
	for _, r := range all {
		rel := "-"
		if b := base[r.Input+"/"+r.Rendition]; b > 0 {
			rel = fmt.Sprintf("%+.0f%%", 100*(float64(r.Bytes)/float64(b)-1))
		}
		fmt.Printf("| %s | %s | %s | %d | %s | %.2f | %.2f | %.0f |\n",
			r.Input, r.Rendition, r.Setting, r.Kbps, rel, r.VMAFMean, r.VMAFLow, r.EncodeSecs)
	}
}

func probe(ctx context.Context, ffprobe, src string) (media.Info, error) {
	out, err := exec.CommandContext(ctx, ffprobe, media.BuildProbeArgs(src)...).Output() // #nosec G204 -- operator-supplied tool path and files.
	if err != nil {
		return media.Info{}, err
	}
	return media.ParseProbe(out)
}

func run(ctx context.Context, bin string, args ...string) error {
	cmd := exec.CommandContext(ctx, bin, args...) // #nosec G204 -- operator-supplied tool path; args built by media.
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func segmentBytes(dir string) (int64, error) {
	var n int64
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".m4s") {
			return err
		}
		fi, err := d.Info()
		if err == nil {
			n += fi.Size()
		}
		return err
	})
	return n, err
}

// vmaf scores a rendition against the source at the source display size
// (the distorted picture is upscaled, as a viewer's player would do).
func vmaf(ctx context.Context, ff, dist, src string, info media.Info, logPath string) (float64, float64, error) {
	w, h := info.DisplayW&^1, info.DisplayH&^1
	graph := fmt.Sprintf(
		"[0:v]scale=%d:%d:flags=bicubic,format=yuv420p,setpts=PTS-STARTPTS[d];"+
			"[1:v]scale=%d:%d,format=yuv420p,setpts=PTS-STARTPTS[r];"+
			"[d][r]libvmaf=n_threads=%d:log_fmt=json:log_path=%s",
		w, h, w, h, runtime.NumCPU(), strings.ReplaceAll(filepath.ToSlash(logPath), ":", `\:`))
	if err := run(ctx, ff, "-hide_banner", "-nostdin", "-loglevel", "error",
		"-i", dist, "-i", src, "-lavfi", graph, "-f", "null", "-"); err != nil {
		return 0, 0, err
	}
	raw, err := os.ReadFile(logPath) // #nosec G304 -- file written by this process.
	if err != nil {
		return 0, 0, err
	}
	var log struct {
		Frames []struct {
			Metrics struct {
				VMAF float64 `json:"vmaf"`
			} `json:"metrics"`
		} `json:"frames"`
		Pooled struct {
			VMAF struct {
				Mean float64 `json:"mean"`
			} `json:"vmaf"`
		} `json:"pooled_metrics"`
	}
	if err := json.Unmarshal(raw, &log); err != nil {
		return 0, 0, err
	}
	if len(log.Frames) == 0 {
		return 0, 0, errors.New("libvmaf wrote no frames")
	}
	scores := make([]float64, len(log.Frames))
	for i, f := range log.Frames {
		scores[i] = f.Metrics.VMAF
	}
	sort.Float64s(scores)
	return log.Pooled.VMAF.Mean, scores[len(scores)*5/100], nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "quality-bench:", err)
	os.Exit(1)
}
