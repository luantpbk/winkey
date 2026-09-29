package media

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Limits enforced on inputs (non-retryable INVALID_INPUT beyond them).
const (
	MaxDurationSec = 12 * 3600
	Max8KLongEdge  = 7680
	Max8KShortEdge = 4320
	MaxFPS         = 60
)

// InvalidInputError marks input that will never transcode (corrupt file, no
// video stream, out-of-range limits). It is non-retryable.
type InvalidInputError struct{ Msg string }

func (e *InvalidInputError) Error() string { return "invalid input: " + e.Msg }

func invalid(format string, a ...any) error {
	return &InvalidInputError{Msg: fmt.Sprintf(format, a...)}
}

// Info is what the pipeline needs to know about the source.
type Info struct {
	DurationSec float64
	DisplayW    int    // width after rotation and SAR correction
	DisplayH    int    // height after rotation
	Rotation    int    // 0, 90, 180 or 270 (clockwise, as applied by autorotate)
	PixFmt      string // e.g. yuv420p10le
	BitDepth    int
	FPS         string // avg frame rate as an ffmpeg rational, already capped at MaxFPS
	HasAudio    bool
	VideoCodec  string
}

type probeOutput struct {
	Streams []struct {
		CodecType        string `json:"codec_type"`
		CodecName        string `json:"codec_name"`
		Width            int    `json:"width"`
		Height           int    `json:"height"`
		PixFmt           string `json:"pix_fmt"`
		BitsPerRawSample string `json:"bits_per_raw_sample"`
		AvgFrameRate     string `json:"avg_frame_rate"`
		RFrameRate       string `json:"r_frame_rate"`
		SampleAspect     string `json:"sample_aspect_ratio"`
		Duration         string `json:"duration"`
		Disposition      struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
		Tags     map[string]string `json:"tags"`
		SideData []struct {
			Rotation *float64 `json:"rotation"`
		} `json:"side_data_list"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// ParseProbe interprets `ffprobe -print_format json -show_format -show_streams`
// output and validates it. Errors are *InvalidInputError.
func ParseProbe(data []byte) (Info, error) {
	var p probeOutput
	if err := json.Unmarshal(data, &p); err != nil {
		return Info{}, invalid("unreadable probe output")
	}
	var info Info
	found := false
	for _, s := range p.Streams {
		switch {
		case s.CodecType == "audio":
			info.HasAudio = true
		case s.CodecType == "video" && s.Disposition.AttachedPic == 0 && !found:
			found = true
			info.VideoCodec = s.CodecName
			info.PixFmt = s.PixFmt
			info.BitDepth = bitDepth(s.PixFmt, s.BitsPerRawSample)
			info.FPS = chooseFPS(s.AvgFrameRate, s.RFrameRate)
			info.Rotation = rotation(s.SideData, s.Tags)
			w, h := s.Width, s.Height
			if num, den, ok := parseRatio(s.SampleAspect); ok && num > 0 && den > 0 && num != den {
				w = int(math.Round(float64(w) * float64(num) / float64(den)))
			}
			if info.Rotation == 90 || info.Rotation == 270 {
				w, h = h, w
			}
			info.DisplayW, info.DisplayH = w, h
			if d, err := strconv.ParseFloat(s.Duration, 64); err == nil && d > 0 {
				info.DurationSec = d
			}
		}
	}
	if !found {
		return Info{}, invalid("no video stream")
	}
	if d, err := strconv.ParseFloat(p.Format.Duration, 64); err == nil && d > 0 {
		info.DurationSec = d // the container duration covers audio and video
	}
	return info, info.Validate()
}

// Validate applies the input limits.
func (i Info) Validate() error {
	switch {
	case i.DisplayW < 2 || i.DisplayH < 2:
		return invalid("video has no usable dimensions")
	case !(i.DurationSec > 0) || math.IsInf(i.DurationSec, 0):
		return invalid("video has no duration")
	case i.DurationSec > MaxDurationSec:
		return invalid("video is longer than 12 hours")
	case max(i.DisplayW, i.DisplayH) > Max8KLongEdge || min(i.DisplayW, i.DisplayH) > Max8KShortEdge:
		return invalid("video is larger than 8K")
	}
	return nil
}

func bitDepth(pixFmt, bitsPerRaw string) int {
	if n, err := strconv.Atoi(bitsPerRaw); err == nil && n > 0 {
		return n
	}
	for _, d := range []int{16, 14, 12, 10, 9} {
		if strings.Contains(pixFmt, strconv.Itoa(d)+"le") || strings.Contains(pixFmt, strconv.Itoa(d)+"be") {
			return d
		}
	}
	if strings.HasPrefix(pixFmt, "p010") {
		return 10
	}
	return 8
}

func rotation(side []struct {
	Rotation *float64 `json:"rotation"`
}, tags map[string]string) int {
	var deg float64
	found := false
	for _, sd := range side {
		if sd.Rotation != nil {
			deg, found = *sd.Rotation, true
		}
	}
	if !found {
		if v, err := strconv.ParseFloat(tags["rotate"], 64); err == nil {
			deg = v
		}
	}
	r := (int(math.Round(deg))%360 + 360) % 360
	if r%90 != 0 {
		return 0
	}
	return r
}

func parseRatio(s string) (num, den int, ok bool) {
	a, b, found := strings.Cut(s, "/")
	if !found {
		a, b, found = strings.Cut(s, ":")
	}
	if !found {
		return 0, 0, false
	}
	n, err1 := strconv.Atoi(a)
	d, err2 := strconv.Atoi(b)
	return n, d, err1 == nil && err2 == nil && d != 0
}

// chooseFPS returns the average frame rate as an ffmpeg rational, capped at
// MaxFPS, falling back to the nominal rate and finally 30.
func chooseFPS(avg, r string) string {
	for _, s := range []string{avg, r} {
		num, den, ok := parseRatio(s)
		if !ok || num <= 0 {
			continue
		}
		if float64(num)/float64(den) > MaxFPS {
			return strconv.Itoa(MaxFPS)
		}
		if den == 1 {
			return strconv.Itoa(num)
		}
		return fmt.Sprintf("%d/%d", num, den)
	}
	return "30"
}
