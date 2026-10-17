package media

import (
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite golden files")

func golden(t *testing.T, name string, args []string) {
	t.Helper()
	got := strings.Join(args, "\n") + "\n"
	path := filepath.Join("testdata", name+".golden")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", path, err)
	}
	if got != strings.ReplaceAll(string(want), "\r\n", "\n") {
		t.Errorf("ffmpeg arguments changed for %s.\n--- got ---\n%s\n--- want ---\n%s", name, got, want)
	}
}

func plan(enc string, w, h int, audio bool) HLSPlan {
	return HLSPlan{
		Input: "/scratch/v1/source", OutDir: "/scratch/v1/out/hls", Encoder: enc,
		Renditions: Select(w, h), FPS: "30000/1001", HasAudio: audio,
	}
}

func TestGoldenNVENC(t *testing.T) {
	golden(t, "nvenc_landscape", BuildHLSArgs(plan(EncoderNVENC, 1920, 1080, true)))
}
func TestGoldenX264(t *testing.T) {
	golden(t, "x264_landscape", BuildHLSArgs(plan(EncoderX264, 1920, 1080, true)))
}
func TestGoldenX264Portrait(t *testing.T) {
	golden(t, "x264_portrait", BuildHLSArgs(plan(EncoderX264, 1080, 1920, true)))
}
func TestGoldenX264Silent(t *testing.T) {
	golden(t, "x264_silent", BuildHLSArgs(plan(EncoderX264, 1920, 1080, false)))
}
func TestGoldenNVENCSingle(t *testing.T) {
	golden(t, "nvenc_single_360p", BuildHLSArgs(plan(EncoderNVENC, 640, 360, true)))
}

func cappedPlan(enc string) HLSPlan {
	p := plan(enc, 1920, 1080, true)
	p.RateControl = RateControlCappedCRF
	return p
}

func TestGoldenNVENCCappedCRF(t *testing.T) {
	golden(t, "nvenc_landscape_capped_crf", BuildHLSArgs(cappedPlan(EncoderNVENC)))
}
func TestGoldenX264CappedCRF(t *testing.T) {
	golden(t, "x264_landscape_capped_crf", BuildHLSArgs(cappedPlan(EncoderX264)))
}

// ADR-039: capped_crf replaces the per-rendition target by a quality level
// and uses the old ABR average as the -maxrate ceiling.
func TestCappedCRFKeepsCeilingAndDropsTarget(t *testing.T) {
	for _, enc := range []string{EncoderNVENC, EncoderX264} {
		abr := BuildHLSArgs(plan(enc, 1920, 1080, true))
		capped := BuildHLSArgs(cappedPlan(enc))
		cs := strings.Join(capped, " ")
		for i, r := range Select(1920, 1080) {
			v := ":v:" + string(rune('0'+i))
			for _, want := range []string{"-maxrate" + v + " " + itoa(r.TargetK) + "k", "-bufsize" + v + " " + itoa(r.BufsizeK) + "k"} {
				if !strings.Contains(cs, want) {
					t.Errorf("%s: missing ceiling %q", enc, want)
				}
			}
			if strings.Contains(cs, "-b"+v+" "+itoa(r.TargetK)+"k") {
				t.Errorf("%s: capped_crf must not set the ABR target for %s", enc, r.Name)
			}
		}
		if enc == EncoderX264 && !strings.Contains(cs, "-crf:v:0 21") {
			t.Errorf("x264 default CRF missing: %s", cs)
		}
		if enc == EncoderNVENC && (!strings.Contains(cs, "-cq:v:0 23") || !strings.Contains(cs, "-b:v:0 0")) {
			t.Errorf("nvenc default CQ missing: %s", cs)
		}
		if strings.Join(abr[:8], " ") != strings.Join(capped[:8], " ") {
			t.Errorf("%s: capped_crf must not change the input arguments", enc)
		}
	}
	p := cappedPlan(EncoderX264)
	p.X264CRF = 19
	if !strings.Contains(strings.Join(BuildHLSArgs(p), " "), "-crf:v:2 19") {
		t.Error("X264CRF override ignored")
	}
	p = cappedPlan(EncoderNVENC)
	p.NVENCCQ = 26
	if !strings.Contains(strings.Join(BuildHLSArgs(p), " "), "-cq:v:1 26") {
		t.Error("NVENCCQ override ignored")
	}
}

func itoa(v int) string { return strconv.Itoa(v) }

func TestNoHWDecodeDropsHwaccelOnly(t *testing.T) {
	p := plan(EncoderNVENC, 1920, 1080, true)
	with := strings.Join(BuildHLSArgs(p), " ")
	p.NoHWDecode = true
	without := strings.Join(BuildHLSArgs(p), " ")
	if !strings.Contains(with, "-hwaccel cuda") || strings.Contains(without, "-hwaccel") {
		t.Fatalf("hwaccel handling wrong:\n%s\n%s", with, without)
	}
	if strings.ReplaceAll(with, "-hwaccel cuda ", "") != without {
		t.Fatal("NoHWDecode must change nothing else (still h264_nvenc with the same options)")
	}
}

func TestX264PresetOverride(t *testing.T) {
	p := plan(EncoderX264, 1920, 1080, true)
	p.X264Preset = "medium"
	if !strings.Contains(strings.Join(BuildHLSArgs(p), " "), "-preset medium") {
		t.Fatal("X264Preset ignored")
	}
}

// Security and contract properties that must hold for every plan.
func TestArgInvariants(t *testing.T) {
	for _, enc := range []string{EncoderNVENC, EncoderX264} {
		for _, audio := range []bool{true, false} {
			args := BuildHLSArgs(plan(enc, 1920, 1080, audio))
			joined := strings.Join(args, " ")
			for _, must := range []string{
				"-protocol_whitelist file,pipe", "-progress pipe:1", "-nostats", "-nostdin",
				"-hls_time 4", "-hls_playlist_type vod", "-hls_segment_type fmp4",
				"-hls_flags independent_segments", "-hls_fmp4_init_filename init.mp4",
				"-master_pl_name master.m3u8", "expr:gte(t,n_forced*2)",
				"-c:a aac -b:a 128k -ar 48000 -ac 2", "-map_metadata -1",
				"v:0,agroup:aud,name:1080p v:1,agroup:aud,name:720p v:2,agroup:aud,name:480p a:0,agroup:aud,name:audio",
			} {
				if !strings.Contains(joined, must) {
					t.Errorf("%s audio=%v: missing %q", enc, audio, must)
				}
			}
			// ADR-042 addendum 2026-10-17: video-only variants and exactly one audio output stream.
			if c := strings.Count(joined, ":a:0"); c != 1 {
				t.Errorf("%s audio=%v: %d audio maps, want 1", enc, audio, c)
			}
			if strings.Contains(joined, "hwaccel_output_format") {
				t.Errorf("%s: -hwaccel_output_format would break CPU filters", enc)
			}
			if got := strings.Contains(joined, "-hwaccel cuda"); got != (enc == EncoderNVENC) {
				t.Errorf("%s: hwaccel=%v", enc, got)
			}
			if got := strings.Contains(joined, "-shortest"); got == audio {
				t.Errorf("%s audio=%v: -shortest=%v", enc, audio, got)
			}
			if got := strings.Contains(joined, "anullsrc"); got == audio {
				t.Errorf("%s audio=%v: anullsrc=%v", enc, audio, got)
			}
			// Exactly one -i besides the optional silent input; the source is a local path.
			if audio && strings.Count(joined, " -i ") != 1 || !audio && strings.Count(joined, " -i ") != 2 {
				t.Errorf("%s audio=%v: unexpected inputs: %s", enc, audio, joined)
			}
		}
	}
}

func TestThumbnailAndProbeArgs(t *testing.T) {
	th := strings.Join(BuildThumbnailArgs("/s/source", "/s/out/thumb/poster.jpg", 3.0), " ")
	for _, must := range []string{"-ss 3.000", "-i /s/source", "scale='min(1280,iw)':-2", "-frames:v 1", "-protocol_whitelist file"} {
		if !strings.Contains(th, must) {
			t.Errorf("thumbnail args missing %q: %s", must, th)
		}
	}
	pr := strings.Join(BuildProbeArgs("/s/source"), " ")
	if !strings.Contains(pr, "-protocol_whitelist file") || !strings.HasSuffix(pr, "/s/source") {
		t.Errorf("probe args: %s", pr)
	}
}

func av1Plan() HLSPlan {
	p := plan(EncoderAV1NVENC, 1920, 1080, true)
	return p
}

func TestGoldenAV1NVENC(t *testing.T) {
	golden(t, "av1_nvenc_landscape", BuildHLSArgs(av1Plan()))
}

// ADR-041: the AV1 set is always constant quality, capped at a share of the
// H.264 rung, with the same ladder, GOP and HLS layout as H.264.
func TestAV1UsesCQAndScaledCeiling(t *testing.T) {
	cs := strings.Join(BuildHLSArgs(av1Plan()), " ")
	for i, r := range Select(1920, 1080) {
		v := ":v:" + itoa(i)
		for _, want := range []string{
			"-cq" + v + " 35 -b" + v + " 0",
			"-maxrate" + v + " " + itoa(r.TargetK*85/100) + "k",
			"-bufsize" + v + " " + itoa(r.BufsizeK*85/100) + "k",
		} {
			if !strings.Contains(cs, want) {
				t.Errorf("missing %q in %s", want, cs)
			}
		}
	}
	for _, want := range []string{"-c:v av1_nvenc", "-hwaccel cuda", "-forced-idr 1", "-no-scenecut 1",
		"expr:gte(t,n_forced*2)", "-hls_segment_type fmp4", "v:0,agroup:aud,name:1080p v:1,agroup:aud,name:720p v:2,agroup:aud,name:480p a:0,agroup:aud,name:audio"} {
		if !strings.Contains(cs, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(cs, "h264_nvenc") || strings.Contains(cs, "-profile:v high") {
		t.Errorf("H.264 options leaked into AV1: %s", cs)
	}

	p := av1Plan()
	p.AV1CQ, p.AV1MaxratePct, p.NoHWDecode = 28, 50, true
	cs = strings.Join(BuildHLSArgs(p), " ")
	r := Select(1920, 1080)[0]
	if !strings.Contains(cs, "-cq:v:0 28") || !strings.Contains(cs, "-maxrate:v:0 "+itoa(r.TargetK/2)+"k") ||
		strings.Contains(cs, "-hwaccel") {
		t.Errorf("AV1 overrides ignored: %s", cs)
	}
	// RateControl does not apply to AV1 (always CQ).
	p = av1Plan()
	p.RateControl = RateControlCappedCRF
	if strings.Join(BuildHLSArgs(p), " ") != strings.Join(BuildHLSArgs(av1Plan()), " ") {
		t.Error("RateControl must not change AV1 args")
	}
}
