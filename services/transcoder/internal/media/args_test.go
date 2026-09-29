package media

import (
	"flag"
	"os"
	"path/filepath"
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
				"v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p",
			} {
				if !strings.Contains(joined, must) {
					t.Errorf("%s audio=%v: missing %q", enc, audio, must)
				}
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
