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

// EncoderAV1NVENC encodes the separate AV1 set (hls-av1/, ENC2, ADR-041). It
// always uses capped constant quality and needs an FFmpeg whose av1_nvenc
// matches the driver (AV1_FFMPEG_PATH); it never runs for transcode_jobs.
const EncoderAV1NVENC = "av1_nvenc"

// Rate-control modes (ADR-039).
const (
	// RateControlABR is the original ADR-006 mode: every rendition targets the
	// rung bitrate (-b:v) whatever the content. It is the zero value.
	RateControlABR = "abr"
	// RateControlCappedCRF encodes at constant quality (x264 -crf, NVENC -cq)
	// with the rung's ABR average bitrate as the -maxrate ceiling: simple
	// content uses far fewer bits, complex content costs about what ABR did.
	RateControlCappedCRF = "capped_crf"
)

// Default constant-quality levels for RateControlCappedCRF (ADR-039).
const (
	DefaultX264CRF = 21
	DefaultNVENCCQ = 23
)

// AV1 defaults (ADR-041), calibrated on gpu-01 (#352 run 3, 2026-10-14): CQ 35 at
// an 85 % ceiling saves 27.5 % vs capped_crf:27 with a 0.31 mean / 0.90 worst
// top-rendition VMAF drop.
const (
	DefaultAV1CQ = 35
	// DefaultAV1MaxratePct is the AV1 -maxrate/-bufsize ceiling as a percentage
	// of the H.264 rung (TargetK / BufsizeK).
	DefaultAV1MaxratePct = 85
)

// HLSPlan describes one HLS CMAF encode.
type HLSPlan struct {
	Input      string // local file; the only protocol allowed is file
	OutDir     string // playlists and segments are written here: master.m3u8, <name>/index.m3u8, ...
	Encoder    string // EncoderNVENC, EncoderX264 or EncoderAV1NVENC
	X264Preset string // default "veryfast"
	// RateControl is RateControlABR (zero value) or RateControlCappedCRF.
	RateControl string
	X264CRF     int // capped_crf with x264; 0 means DefaultX264CRF
	NVENCCQ     int // capped_crf with NVENC; 0 means DefaultNVENCCQ
	// AV1CQ and AV1MaxratePct apply to EncoderAV1NVENC only (0 = defaults).
	AV1CQ         int
	AV1MaxratePct int
	Renditions    []Rendition
	FPS           string // constant frame rate as an ffmpeg rational, e.g. "30000/1001"
	HasAudio      bool
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
	if (p.Encoder == EncoderNVENC || p.Encoder == EncoderAV1NVENC) && !p.NoHWDecode {
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
			_, _ = fmt.Fprintf(&fg, "[s%d]", i)
		}
		for i, r := range p.Renditions {
			_, _ = fmt.Fprintf(&fg, ";[s%d]%s[v%d]", i, chain(r, fps), i)
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

	capped := p.RateControl == RateControlCappedCRF
	switch p.Encoder {
	case EncoderNVENC:
		a = append(a, "-c:v", "h264_nvenc", "-profile:v", "high", "-preset", "p5", "-tune", "hq",
			"-rc", "vbr", "-spatial-aq", "1", "-bf", "3", "-no-scenecut", "1", "-forced-idr", "1")
		if capped {
			// Lookahead and temporal AQ let constant quality spend bits where
			// they are visible; both run on the NVENC block, not the CPU.
			a = append(a, "-rc-lookahead", "20", "-temporal-aq", "1")
		}
	case EncoderAV1NVENC:
		// Same GOP rules as H.264 NVENC; AV1 has no -profile:v high (main is
		// the default) and the 8-bit output matches av01.0.xxM.08 players.
		a = append(a, "-c:v", "av1_nvenc", "-preset", "p5", "-tune", "hq",
			"-rc", "vbr", "-spatial-aq", "1", "-no-scenecut", "1", "-forced-idr", "1",
			"-rc-lookahead", "20", "-temporal-aq", "1")
	default:
		a = append(a, "-c:v", "libx264", "-profile:v", "high", "-preset", preset, "-sc_threshold", "0")
	}
	for i, r := range p.Renditions {
		s := ":v:" + strconv.Itoa(i)
		if p.Encoder == EncoderAV1NVENC {
			pct := orDefault(p.AV1MaxratePct, DefaultAV1MaxratePct)
			a = append(a, "-cq"+s, strconv.Itoa(orDefault(p.AV1CQ, DefaultAV1CQ)), "-b"+s, "0",
				"-maxrate"+s, fmt.Sprintf("%dk", r.TargetK*pct/100),
				"-bufsize"+s, fmt.Sprintf("%dk", r.BufsizeK*pct/100))
			continue
		}
		switch {
		case capped && p.Encoder == EncoderNVENC:
			// -b:v 0 lets -cq drive the rate; -maxrate/-bufsize stay the ceiling.
			a = append(a, "-cq"+s, strconv.Itoa(orDefault(p.NVENCCQ, DefaultNVENCCQ)), "-b"+s, "0")
		case capped:
			a = append(a, "-crf"+s, strconv.Itoa(orDefault(p.X264CRF, DefaultX264CRF)))
		default:
			a = append(a, "-b"+s, fmt.Sprintf("%dk", r.TargetK))
		}
		// The capped ceiling is the old ABR average (TargetK), so complex
		// content costs about what it did before and simple content far less.
		maxrate := r.MaxrateK
		if capped {
			maxrate = r.TargetK
		}
		a = append(a,
			"-maxrate"+s, fmt.Sprintf("%dk", maxrate),
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
		"-hls_segment_type", "fmp4", "-hls_flags", "independent_segments+temp_file",
		"-hls_fmp4_init_filename", "init.mp4",
		"-hls_segment_filename", out+"/%v/seg_%05d.m4s",
		"-master_pl_name", MasterPlaylist,
		"-var_stream_map", strings.Join(vsm, " "),
		out+"/%v/index.m3u8")
	return a
}

func orDefault(v, def int) int {
	if v > 0 {
		return v
	}
	return def
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
