package media

import (
	"bufio"
	"io"
	"strconv"
	"strings"
)

// ProgressParser turns the key=value blocks of `ffmpeg -progress pipe:1` into
// percentages. Feed it line by line; a block ends with `progress=continue` or
// `progress=end`.
type ProgressParser struct {
	TotalUs int64 // media duration in microseconds
	cur     int64
}

// Feed consumes one line. ok is true at the end of a block, with the percent
// (0..100) reached. Percent stays below 100 until ffmpeg reports `end`.
func (p *ProgressParser) Feed(line string) (percent float64, ok bool) {
	k, v, found := strings.Cut(strings.TrimSpace(line), "=")
	if !found {
		return 0, false
	}
	switch k {
	case "out_time_us", "out_time_ms": // ffmpeg's out_time_ms is also in microseconds
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
			p.cur = n
		}
	case "progress":
		if v == "end" {
			return 100, true
		}
		if p.TotalUs <= 0 {
			return 0, true
		}
		pct := float64(p.cur) / float64(p.TotalUs) * 100
		return clamp(pct, 0, 99.9), true
	}
	return 0, false
}

// ReadProgress reads r until EOF, calling fn with each percentage.
func ReadProgress(r io.Reader, totalUs int64, fn func(percent float64)) {
	p := &ProgressParser{TotalUs: totalUs}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		if pct, ok := p.Feed(sc.Text()); ok {
			fn(pct)
		}
	}
}

func clamp(v, lo, hi float64) float64 {
	return max(lo, min(hi, v))
}
