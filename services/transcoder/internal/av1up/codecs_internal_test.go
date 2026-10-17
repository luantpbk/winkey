package av1up

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// A real AV1 fMP4 HLS ladder in the ADR-042 layout (video-only variants, one audio rendition), as FFmpeg's
// muxer writes it (no CODECS on the AV1 variants), gets its codecs from
// probing the streams, and then passes VerifyOutput. libsvtav1 stands in for av1_nvenc (no GPU in CI); the
// muxer path is the same. Skipped when the local ffmpeg has no libsvtav1.
func TestSetCodecsOnRealAV1(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	if out, _ := exec.Command(tools.FFmpeg, "-hide_banner", "-encoders").Output(); !strings.Contains(string(out), "libsvtav1") {
		t.Skip("ffmpeg has no libsvtav1")
	}
	dir := t.TempDir()
	cmd := exec.Command(tools.FFmpeg, "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
		"-t", "3", "-map", "0:v", "-map", "1:a", "-c:v", "libsvtav1", "-preset", "12", "-c:a", "aac",
		"-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4", "-hls_playlist_type", "vod",
		"-hls_fmp4_init_filename", "init.mp4", "-master_pl_name", media.MasterPlaylist,
		"-var_stream_map", "v:0,agroup:aud,name:720p a:0,agroup:aud,name:audio", "-hls_segment_filename", filepath.Join(dir, "%v", "seg_%03d.m4s"),
		filepath.Join(dir, "%v", "index.m3u8")) // #nosec G204 -- test
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("encode: %v\n%s", err, b)
	}
	rs := []media.Rendition{{Name: "720p", Width: 1280, Height: 720}}
	if err := job.NormalizeMaster(filepath.Join(dir, media.MasterPlaylist)); err != nil {
		t.Fatal(err)
	}
	if err := media.VerifyOutput(dir, rs); err == nil || !strings.Contains(err.Error(), "CODECS") {
		t.Fatalf("the muxer output was expected to lack CODECS (the bug this covers), got %v", err)
	}

	r := &Runner{Media: tools, Log: slog.New(slog.NewJSONHandler(io.Discard, nil))}
	if err := r.setCodecs(context.Background(), dir, rs); err != nil {
		t.Fatal(err)
	}
	if err := media.VerifyOutput(dir, rs); err != nil {
		t.Fatalf("verify after setCodecs: %v", err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, media.MasterPlaylist))                          // #nosec G304 -- test
	if vars := media.ParseMaster(string(data)); vars[0].Codecs != "av01.0.05M.08,mp4a.40.2" { // 720p30: level 3.1
		t.Fatalf("codecs %q\n%s", vars[0].Codecs, data)
	}
}
