package media

import (
	"encoding/json"
	"math"
	"path/filepath"
	"strconv"
)

// Extra audio tracks (task MUX1, ADR-042): each one is encoded on its own, never with the video, into an
// HLS alternate audio rendition with the same codec as the variants' muxed audio (AAC-LC 128 kb/s,
// 48 kHz, stereo), so a player can switch without a codec change.

// AudioDurationTolerance is how far a track may differ from the video's duration
// (docs/specs/media-package-v1.md section 3).
const AudioDurationTolerance = 0.1 // seconds

// AudioInfo is what the audio job needs to know about an uploaded track.
type AudioInfo struct {
	DurationSec float64
	Channels    int
	SampleRate  int
	Codec       string
}

// ParseAudioProbe interprets ffprobe JSON output for an audio track: the first audio stream counts, video
// streams (cover art) are ignored. Errors are *InvalidInputError.
func ParseAudioProbe(data []byte) (AudioInfo, error) {
	var p probeOutput
	if err := json.Unmarshal(data, &p); err != nil {
		return AudioInfo{}, invalid("unreadable probe output")
	}
	var info AudioInfo
	found := false
	for _, s := range p.Streams {
		if s.CodecType != "audio" {
			continue
		}
		found = true
		info.Codec = s.CodecName
		info.Channels = s.Channels
		info.SampleRate, _ = strconv.Atoi(s.SampleRate)
		if d, err := strconv.ParseFloat(s.Duration, 64); err == nil {
			info.DurationSec = d
		}
		break
	}
	if !found {
		return AudioInfo{}, invalid("the file has no audio stream")
	}
	if info.DurationSec <= 0 {
		if d, err := strconv.ParseFloat(p.Format.Duration, 64); err == nil {
			info.DurationSec = d
		}
	}
	if info.DurationSec <= 0 || math.IsNaN(info.DurationSec) || math.IsInf(info.DurationSec, 0) {
		return AudioInfo{}, invalid("the audio duration is unknown")
	}
	if info.DurationSec > MaxDurationSec {
		return AudioInfo{}, invalid("the audio is longer than %d hours", MaxDurationSec/3600)
	}
	return info, nil
}

// AudioMatchesVideo reports whether a track of audioSec fits a video of videoMs.
func AudioMatchesVideo(audioSec float64, videoMs int) bool {
	return math.Abs(audioSec-float64(videoMs)/1000) <= AudioDurationTolerance+1e-9
}

// AudioPlaylist is the media playlist file name of an encoded track inside its output directory.
const AudioPlaylist = "index.m3u8"

// BuildAudioHLSArgs encodes the first audio stream of input into fMP4 HLS in outDir (index.m3u8,
// init.mp4, seg_%05d.m4s), with the same segment length as the video variants. Surround input is
// downmixed to stereo, 44.1 kHz is resampled.
func BuildAudioHLSArgs(input, outDir string) []string {
	out := filepath.ToSlash(outDir)
	return []string{
		"-hide_banner", "-nostdin", "-y", "-loglevel", "error",
		"-progress", "pipe:1", "-nostats", "-protocol_whitelist", "file",
		"-i", filepath.ToSlash(input),
		"-map", "0:a:0", "-vn", "-sn", "-dn",
		"-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
		"-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4", "-hls_flags", "independent_segments+temp_file",
		"-hls_fmp4_init_filename", "init.mp4",
		"-hls_segment_filename", out + "/seg_%05d.m4s",
		out + "/" + AudioPlaylist,
	}
}
