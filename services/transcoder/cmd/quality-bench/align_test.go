package main

import (
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

func TestAlignGraphKeepsTheFileTimeline(t *testing.T) {
	g := alignGraph("", 853, 480)
	if strings.Contains(g, "STARTPTS") || !strings.Contains(g, "[0:v]fps=30,scale=852:480") || !strings.Contains(g, "[1:v]fps=30,scale=852:480") {
		t.Fatalf("graph %s", g)
	}
}

// Regression for the s11/s12 misalignment: a source whose video starts 0.5 s after its audio, encoded with the
// production arguments, must compare frame for frame (PSNR stands in for VMAF: the CI ffmpeg has no libvmaf).
func TestAlignmentWhenVideoStartsAfterAudio(t *testing.T) {
	if testing.Short() {
		t.Skip("encodes with ffmpeg")
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not found")
	}
	dir := t.TempDir()
	plain, late := filepath.Join(dir, "plain.mp4"), filepath.Join(dir, "late.mp4")
	ff := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("ffmpeg", append([]string{"-hide_banner", "-nostdin", "-y"}, args...)...).CombinedOutput() // #nosec G204 -- test fixtures.
		if err != nil {
			t.Fatalf("ffmpeg %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	ff("-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=sample_rate=48000",
		"-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "10", "-c:a", "aac", "-shortest", plain)
	ff("-loglevel", "error", "-i", plain, "-itsoffset", "0.5", "-i", plain, "-map", "1:v", "-map", "0:a", "-c", "copy", late)

	out := filepath.Join(dir, "hls")
	rs := media.Select(640, 360)
	plan := media.HLSPlan{Input: late, OutDir: out, Encoder: media.EncoderX264, X264Preset: "ultrafast",
		RateControl: media.RateControlCappedCRF, X264CRF: 16, Renditions: rs, FPS: "30", HasAudio: true}
	ff(media.BuildHLSArgs(plan)[3:]...) // without -hide_banner -nostdin -y, which ff adds

	log := ff("-i", filepath.Join(out, rs[0].Name, "index.m3u8"), "-i", late,
		"-lavfi", alignGraph("30", 640, 360)+";[d][r]psnr=shortest=1", "-f", "null", "-")
	m := regexp.MustCompile(`average:([0-9.]+|inf)`).FindStringSubmatch(log)
	if m == nil {
		t.Fatalf("no PSNR in:\n%s", log)
	}
	if m[1] != "inf" {
		if psnr, _ := strconv.ParseFloat(m[1], 64); psnr < 35 {
			t.Fatalf("PSNR %.2f dB: rendition and source are not frame-aligned", psnr)
		}
	}
}
