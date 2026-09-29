package media

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// Encoder names as stored in media.transcode_jobs.encoder.
const (
	EncoderNVENC = "nvenc"
	EncoderX264  = "x264"
)

// HLSPlan describes one HLS CMAF encode.
type HLSPlan struct {
	Input      string // local file; the only protocol allowed is file
	OutDir     string // playlists and segments are written here: master.m3u8, <name>/index.m3u8, ...
	Encoder    string // EncoderNVENC or EncoderX264
	X264Preset string // default "veryfast"
	Renditions []Rendition
	FPS        string // constant frame rate as an ffmpeg rational, e.g. "30000/1001"
	HasAudio   bool
	// NoHWDecode makes NVENC runs decode on the CPU (no -hwaccel cuda). It is
	// the hook for a possible HWACCEL_DECODE=false when NVDEC is unavailable or
	// slow on a shared GPU; it is not wired to configuration yet.
	NoHWDecode bool
}

// MasterPlaylist is the master playlist file name inside OutDir.
const MasterPlaylist = "master.m3u8"

// BuildHLSArgs returns the ffmpeg arguments (without the binary name) for one
// process that produces every rendition (ADR-006): filter_complex split →
// per-rendition scale/fps/format, HLS fMP4 with 4 s segments and a keyframe
// every 2 s. Paths use forward slashes so the result is identical on Linux
// and Windows.
func BuildHLSArgs(p HLSPlan) []string {
	n := len(p.Renditions)
	preset := p.X264Preset
	if preset == "" {
		preset = "veryfast"
	}
	fps := p.FPS
	if fps == "" {
		fps = "30"
	}

	a := []string{
		"-hide_banner", "-nostdin", "-y", "-loglevel", "error",
		"-progress", "pipe:1", "-nostats",
		"-protocol_whitelist", "file,pipe",
	}
	if p.Encoder == EncoderNVENC && !p.NoHWDecode {
		// No -hwaccel_output_format: frames come back to system memory so the
		// CPU filters (rotate, 10-bit→8-bit, scale) always work.
		a = append(a, "-hwaccel", "cuda")
	}
	a = append(a, "-i", filepath.ToSlash(p.Input))
	audioInput := 0
	if !p.HasAudio {
		a = append(a, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000")
		audioInput = 1
	}

	// Video filter graph.
	var fg strings.Builder
	if n == 1 {
		fg.WriteString("[0:v:0]")
		fg.WriteString(chain(p.Renditions[0], fps))
		fg.WriteString("[v0]")
	} else {
		fg.WriteString("[0:v:0]split=" + strconv.Itoa(n))
		for i := 0; i < n; i++ {
			fg.WriteString(fmt.Sprintf("[s%d]", i))
		}
		for i, r := range p.Renditions {
			fg.WriteString(fmt.Sprintf(";[s%d]%s[v%d]", i, chain(r, fps), i))
		}
	}
	a = append(a, "-filter_complex", fg.String())

	for i := 0; i < n; i++ {
		a = append(a, "-map", fmt.Sprintf("[v%d]", i))
	}
	for i := 0; i < n; i++ { // one audio output stream per variant
		if audioInput == 0 {
			a = append(a, "-map", "0:a:0")
		} else {
			a = append(a, "-map", "1:a:0")
		}
	}
	a = append(a, "-map_metadata", "-1", "-map_chapters", "-1")

	switch p.Encoder {
	case EncoderNVENC:
		a = append(a, "-c:v", "h264_nvenc", "-profile:v", "high", "-preset", "p5", "-tune", "hq",
			"-rc", "vbr", "-spatial-aq", "1", "-bf", "3", "-no-scenecut", "1", "-forced-idr", "1")
	default:
		a = append(a, "-c:v", "libx264", "-profile:v", "high", "-preset", preset, "-sc_threshold", "0")
	}
	for i, r := range p.Renditions {
		s := ":v:" + strconv.Itoa(i)
		a = append(a,
			"-b"+s, fmt.Sprintf("%dk", r.TargetK),
			"-maxrate"+s, fmt.Sprintf("%dk", r.MaxrateK),
			"-bufsize"+s, fmt.Sprintf("%dk", r.BufsizeK))
	}
	a = append(a, "-force_key_frames", "expr:gte(t,n_forced*2)")
	a = append(a, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2")
	if !p.HasAudio {
		a = append(a, "-shortest") // anullsrc is infinite
	}

	vsm := make([]string, n)
	for i, r := range p.Renditions {
		vsm[i] = fmt.Sprintf("v:%d,a:%d,name:%s", i, i, r.Name)
	}
	out := filepath.ToSlash(p.OutDir)
	a = append(a,
		"-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4", "-hls_flags", "independent_segments",
		"-hls_fmp4_init_filename", "init.mp4",
		"-hls_segment_filename", out+"/%v/seg_%05d.m4s",
		"-master_pl_name", MasterPlaylist,
		"-var_stream_map", strings.Join(vsm, " "),
		out+"/%v/index.m3u8")
	return a
}

func chain(r Rendition, fps string) string {
	return fmt.Sprintf("scale=%d:%d,fps=%s,format=yuv420p,setsar=1", r.Width, r.Height, fps)
}

// BuildProbeArgs returns the ffprobe arguments for input.
func BuildProbeArgs(input string) []string {
	return []string{"-v", "error", "-protocol_whitelist", "file", "-print_format", "json",
		"-show_format", "-show_streams", filepath.ToSlash(input)}
}

// BuildThumbnailArgs extracts one frame at atSec, at most 1280 px wide (never
// upscaled), as a JPEG.
func BuildThumbnailArgs(input, output string, atSec float64) []string {
	return []string{
		"-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-protocol_whitelist", "file",
		"-ss", strconv.FormatFloat(atSec, 'f', 3, 64),
		"-i", filepath.ToSlash(input),
		"-frames:v", "1",
		"-vf", "scale='min(1280,iw)':-2",
		"-q:v", "3",
		filepath.ToSlash(output),
	}
}

// BuildEncoderProbeArgs returns a tiny one-frame test encode used to decide
// whether NVENC works on this machine (ENCODER=auto).
func BuildEncoderProbeArgs() []string {
	return []string{"-hide_banner", "-nostdin", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=black:s=640x360:d=0.2:r=25",
		"-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"}
}
