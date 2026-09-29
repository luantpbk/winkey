// Package testutil holds helpers shared by the ffmpeg-backed tests (unit,
// integration and GPU): tool discovery and generated test clips.
package testutil

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// ToolsFromEnv finds ffmpeg/ffprobe (FFMPEG_PATH / FFPROBE_PATH or PATH) and
// skips the test when they are missing.
func ToolsFromEnv(t testing.TB) job.Tools {
	t.Helper()
	find := func(env, name string) string {
		if p := os.Getenv(env); p != "" {
			return p
		}
		p, err := exec.LookPath(name)
		if err != nil {
			t.Skipf("%s not found (set %s): %v", name, env, err)
		}
		return p
	}
	return job.Tools{FFmpeg: find("FFMPEG_PATH", "ffmpeg"), FFprobe: find("FFPROBE_PATH", "ffprobe")}
}

type Clip struct {
	Name           string
	W, H           int
	Seconds        int
	Audio          bool
	PixFmt         string
	Rotate         int // display-matrix rotation metadata in degrees
	WantRenditions []string
}

var (
	ClipLandscape = Clip{Name: "landscape", W: 1920, H: 1080, Seconds: 30, Audio: true, PixFmt: "yuv420p",
		WantRenditions: []string{"1080p", "720p", "480p"}}
	ClipPortrait = Clip{Name: "portrait", W: 1080, H: 1920, Seconds: 12, Audio: true, PixFmt: "yuv420p",
		WantRenditions: []string{"1080p", "720p", "480p"}}
	ClipSilent = Clip{Name: "silent", W: 1920, H: 1080, Seconds: 12, Audio: false, PixFmt: "yuv420p",
		WantRenditions: []string{"1080p", "720p", "480p"}}
	ClipSmall = Clip{Name: "small360", W: 640, H: 360, Seconds: 8, Audio: true, PixFmt: "yuv420p",
		WantRenditions: []string{"360p"}}
	// ClipRotated is stored 1280x720 with a 90° display matrix: displayed portrait 720x1280.
	ClipRotated = Clip{Name: "rotated", W: 1280, H: 720, Seconds: 8, Audio: true, PixFmt: "yuv420p", Rotate: 90,
		WantRenditions: []string{"720p", "480p"}}
	ClipTenBit = Clip{Name: "tenbit", W: 1280, H: 720, Seconds: 8, Audio: true, PixFmt: "yuv420p10le",
		WantRenditions: []string{"720p", "480p"}}
)

// MakeClip generates a test clip with ffmpeg's lavfi sources (testsrc2 + sine).
func MakeClip(t testing.TB, tools job.Tools, dir string, c Clip) string {
	t.Helper()
	out := filepath.Join(dir, c.Name+".mp4")
	args := []string{"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=30", c.W, c.H)}
	if c.Audio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100")
	}
	args = append(args, "-t", fmt.Sprint(c.Seconds), "-pix_fmt", c.PixFmt)
	codec := "libx264"
	if strings.Contains(c.PixFmt, "10") {
		args = append(args, "-profile:v", "high10")
	}
	args = append(args, "-c:v", codec, "-preset", "ultrafast")
	if c.Audio {
		args = append(args, "-c:a", "aac", "-shortest")
	}
	target := out
	if c.Rotate != 0 {
		target = filepath.Join(dir, c.Name+"_unrotated.mp4")
	}
	args = append(args, target)
	if b, err := exec.Command(tools.FFmpeg, args...).CombinedOutput(); err != nil {
		t.Fatalf("generate clip %s: %v\n%s", c.Name, err, b)
	}
	if c.Rotate != 0 { // attach a display matrix without re-encoding
		b, err := exec.Command(tools.FFmpeg, "-hide_banner", "-loglevel", "error", "-y",
			"-display_rotation:v:0", fmt.Sprint(c.Rotate), "-i", target, "-c", "copy", out).CombinedOutput()
		if err != nil {
			t.Fatalf("rotate clip %s: %v\n%s", c.Name, err, b)
		}
	}
	return out
}
