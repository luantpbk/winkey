package media

import (
	"fmt"
	"regexp"
	"strings"
)

// FFmpeg's HLS muxer writes CODECS only for H.264 and HEVC variants. An AV1 master (ENC2, ADR-041) comes out
// without it, and players need it to choose between hls_url and hls_av1_url, so av1-upgrade fills it in from
// the encoded streams themselves.

// AACCodec is the RFC 6381 string of the variants' muxed audio (AAC-LC).
const AACCodec = "mp4a.40.2"

// AV1Codec builds the RFC 6381 / AV1-ISOBMFF codecs string `av01.P.LLT.DD` of a probed AV1 stream: profile
// (Main 0, High 1, Professional 2), seq_level_idx, tier and bit depth. ffprobe does not report the tier;
// av1_nvenc encodes Main tier ("M").
func AV1Codec(info Info) (string, error) {
	if info.VideoCodec != "av1" {
		return "", fmt.Errorf("video codec is %q, not av1", info.VideoCodec)
	}
	profile := map[string]int{"Main": 0, "High": 1, "Professional": 2}
	p, ok := profile[info.VideoProfile]
	if !ok {
		return "", fmt.Errorf("unknown AV1 profile %q", info.VideoProfile)
	}
	if info.VideoLevel < 0 || info.VideoLevel > 31 {
		return "", fmt.Errorf("unknown AV1 level %d", info.VideoLevel)
	}
	switch info.BitDepth {
	case 8, 10, 12:
	default:
		return "", fmt.Errorf("unsupported AV1 bit depth %d", info.BitDepth)
	}
	return fmt.Sprintf("av01.%d.%02dM.%02d", p, info.VideoLevel, info.BitDepth), nil
}

var codecsAttrRe = regexp.MustCompile(`,?CODECS="[^"]*"`)

// SetMasterCodecs sets CODECS on every #EXT-X-STREAM-INF of master whose URI is "<name>/index.m3u8", replacing
// any value FFmpeg wrote. It fails when a variant has no entry in codecs, so no variant is left without one.
func SetMasterCodecs(master []byte, codecs map[string]string) ([]byte, error) {
	lines := strings.Split(string(master), "\n")
	set := 0
	for i := 0; i < len(lines); i++ {
		rest, ok := strings.CutPrefix(lines[i], "#EXT-X-STREAM-INF:")
		if !ok {
			continue
		}
		uri := ""
		for j := i + 1; j < len(lines); j++ {
			if l := strings.TrimSpace(lines[j]); l != "" && !strings.HasPrefix(l, "#") {
				uri = l
				break
			}
		}
		name := strings.TrimSuffix(uri, "/index.m3u8")
		c, ok := codecs[name]
		if !ok || name == uri {
			return nil, fmt.Errorf("no codecs for variant %q", uri)
		}
		rest = strings.TrimSuffix(codecsAttrRe.ReplaceAllString(strings.TrimRight(rest, "\r"), ""), ",")
		lines[i] = "#EXT-X-STREAM-INF:" + rest + `,CODECS="` + c + `"`
		set++
	}
	if set == 0 {
		return nil, fmt.Errorf("master has no variants")
	}
	return []byte(strings.Join(lines, "\n")), nil
}
