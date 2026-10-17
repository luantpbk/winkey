package job_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// TestHLSOutputWithRealFFmpeg locks the ffmpeg HLS layout: master.m3u8 lists
// every rendition with CODECS/BANDWIDTH/RESOLUTION, each variant directory has
// its own init segment, and ffprobe can read every variant. This is the
// "golden" check on real ffmpeg output that complements the argument goldens.
func TestHLSOutputWithRealFFmpeg(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	for _, c := range []testutil.Clip{testutil.ClipLandscape, testutil.ClipPortrait, testutil.ClipSilent, testutil.ClipSmall, testutil.ClipTenBit, testutil.ClipRotated} {
		c := c
		if testing.Short() && c.Seconds > 10 {
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			src := testutil.MakeClip(t, tools, dir, c)

			info, err := tools.Probe(ctx, src)
			if err != nil {
				t.Fatal(err)
			}
			dw, dh := c.W, c.H
			if c.Rotate%180 != 0 {
				dw, dh = dh, dw
			}
			if info.HasAudio != c.Audio || info.DisplayW != dw || info.DisplayH != dh {
				t.Fatalf("probe: %+v", info)
			}
			if c.PixFmt == "yuv420p10le" && info.BitDepth != 10 {
				t.Fatalf("bit depth %d", info.BitDepth)
			}
			rs := media.Select(info.DisplayW, info.DisplayH)
			var got []string
			for _, r := range rs {
				got = append(got, r.Name)
			}
			if strings.Join(got, ",") != strings.Join(c.WantRenditions, ",") {
				t.Fatalf("ladder %v, want %v", got, c.WantRenditions)
			}

			out := filepath.Join(dir, "out", "hls")
			var last float64
			err = tools.RunHLS(ctx, media.HLSPlan{
				Input: src, OutDir: out, Encoder: media.EncoderX264, X264Preset: "ultrafast",
				Renditions: rs, FPS: info.FPS, HasAudio: info.HasAudio,
			}, info.DurationSec, func(p float64) { last = p })
			if err != nil {
				t.Fatal(err)
			}
			if last != 100 {
				t.Errorf("final progress %v, want 100", last)
			}
			if err := media.VerifyOutput(out, rs); err != nil {
				t.Fatal(err)
			}

			// ffprobe reads every variant playlist (video only) and the audio rendition (ADR-042 addendum).
			if ai, err := tools.ProbeAudio(ctx, filepath.Join(out, media.AudioRendition, "index.m3u8")); err != nil ||
				ai.Codec != "aac" || ai.Channels != 2 || ai.SampleRate != 48000 {
				t.Errorf("audio rendition (also for silent sources): %+v %v", ai, err)
			}
			for _, r := range rs {
				vi, err := tools.Probe(ctx, filepath.Join(out, r.Name, "index.m3u8"))
				if err != nil {
					t.Fatalf("ffprobe %s: %v", r.Name, err)
				}
				if vi.DisplayW != r.Width || vi.DisplayH != r.Height || vi.HasAudio {
					t.Errorf("%s: %+v, want %dx%d without audio", r.Name, vi, r.Width, r.Height)
				}
				if vi.PixFmt != "yuv420p" {
					t.Errorf("%s: pix_fmt %s", r.Name, vi.PixFmt)
				}
				if d := vi.DurationSec - info.DurationSec; d < -1 || d > 1 {
					t.Errorf("%s: duration %.2f vs source %.2f", r.Name, vi.DurationSec, info.DurationSec)
				}
			}

			poster := filepath.Join(dir, "out", "thumb", "poster.jpg")
			if err := tools.Thumbnail(ctx, src, poster, info.DurationSec*0.1); err != nil {
				t.Fatal(err)
			}
			ti, err := tools.Probe(ctx, poster)
			if err != nil {
				t.Fatal(err)
			}
			if want := min(1280, dw); ti.DisplayW != want {
				t.Errorf("poster width %d, want %d", ti.DisplayW, want)
			}
		})
	}
}

// TestCappedCRFWithRealFFmpeg checks ADR-039 on real ffmpeg output: the
// capped constant-quality mode still produces a valid master (BANDWIDTH comes
// from the -maxrate ceiling, so hls.js ABR keeps working), and it never costs
// noticeably more than the fixed-bitrate ladder (ceiling = old ABR average).
func TestCappedCRFWithRealFFmpeg(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	ctx := context.Background()
	dir := t.TempDir()
	src := testutil.MakeClip(t, tools, dir, testutil.ClipLandscape)
	info, err := tools.Probe(ctx, src)
	if err != nil {
		t.Fatal(err)
	}
	rs := media.Select(info.DisplayW, info.DisplayH)

	encode := func(mode string) int64 {
		out := filepath.Join(dir, mode, "hls")
		err := tools.RunHLS(ctx, media.HLSPlan{
			Input: src, OutDir: out, Encoder: media.EncoderX264, X264Preset: "ultrafast",
			RateControl: mode, Renditions: rs, FPS: info.FPS, HasAudio: info.HasAudio,
		}, info.DurationSec, func(float64) {})
		if err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		if err := media.VerifyOutput(out, rs); err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		raw, err := os.ReadFile(filepath.Join(out, media.MasterPlaylist))
		if err != nil {
			t.Fatal(err)
		}
		for i, v := range media.ParseMaster(string(raw)) {
			// ffmpeg writes BANDWIDTH as peak video rate x 1.1 plus audio.
			if ceiling := (rs[i].MaxrateK*11/10 + 128) * 1000; v.Bandwidth > ceiling+1000 {
				t.Errorf("%s %s: BANDWIDTH %d above the -maxrate ceiling %d", mode, rs[i].Name, v.Bandwidth, ceiling)
			}
		}
		var total int64
		err = filepath.Walk(out, func(_ string, fi os.FileInfo, err error) error {
			if err == nil && !fi.IsDir() && strings.HasSuffix(fi.Name(), ".m4s") {
				total += fi.Size()
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return total
	}

	abr, capped := encode(media.RateControlABR), encode(media.RateControlCappedCRF)
	t.Logf("segment bytes: abr=%d capped_crf=%d (%.0f%%)", abr, capped, 100*float64(capped)/float64(abr))
	if capped > abr*105/100 {
		t.Fatalf("capped_crf used %d bytes, abr %d: it must not cost more than ABR", capped, abr)
	}
}

func TestProbeRejectsGarbage(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	p := filepath.Join(t.TempDir(), "junk")
	if err := os.WriteFile(p, []byte("this is not a video"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := tools.Probe(context.Background(), p)
	if f := job.Classify(err); f.Reason != job.ReasonInvalidInput || f.Retryable {
		t.Fatalf("err=%v failure=%+v", err, f)
	}
}
