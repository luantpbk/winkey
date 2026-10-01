// Package quota decides whether a caller may start another upload (task UQ1, ADR-027).
// The decision is a pure function of the caller's recent usage, so it is tested without a database.
package quota

import (
	"fmt"
	"time"

	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

// Window is the sliding window of the daily limits.
const Window = 24 * time.Hour

// ConcurrentRetryAfter is the Retry-After of the concurrent limit: nothing in the data says when
// an open upload will end, so the client is asked to come back in a minute.
const ConcurrentRetryAfter = 60

// The names of the limits, as used in the 429 detail and in the metric label `limit`.
const (
	LimitConcurrent  = "concurrent"
	LimitDailyCount  = "daily_count"
	LimitDailyBytes  = "daily_bytes"
	maxRetryAfterSec = int64(Window / time.Second)
)

// Limits are the three limits of ADR-027. A field of 0 switches that limit off (tests); the
// service configuration never allows 0.
type Limits struct {
	MaxConcurrent int   // videos in status UPLOADING, whatever their age
	DailyCount    int   // videos created in the last 24 hours
	DailyBytes    int64 // sum of size_bytes created in the last 24 hours, plus the new upload
}

// Usage is what one query over the caller's media.videos rows returns (see domain.Store.Create).
type Usage = domain.Usage

// Exceeded is a refused upload.
type Exceeded struct {
	Limit      string // LimitConcurrent, LimitDailyCount or LimitDailyBytes
	Value      int64  // the configured value of that limit
	RetryAfter int    // seconds, >= 1
}

func (e *Exceeded) Error() string {
	switch e.Limit {
	case LimitConcurrent:
		return fmt.Sprintf("upload quota exceeded: concurrent limit is %d uploads in progress", e.Value)
	case LimitDailyCount:
		return fmt.Sprintf("upload quota exceeded: daily_count limit is %d uploads per 24 hours", e.Value)
	default:
		return fmt.Sprintf("upload quota exceeded: daily_bytes limit is %d bytes per 24 hours", e.Value)
	}
}

// Decide returns nil when an upload of newBytes may start, otherwise the first limit it breaks,
// checked in the order concurrent, daily_count, daily_bytes. Each limit is inclusive: with 3 open
// uploads and a limit of 3 the 4th is refused, and a total that equals DailyBytes exactly is allowed.
func Decide(l Limits, u Usage, newBytes int64) *Exceeded {
	switch {
	case l.MaxConcurrent > 0 && u.Uploading >= l.MaxConcurrent:
		return &Exceeded{Limit: LimitConcurrent, Value: int64(l.MaxConcurrent), RetryAfter: ConcurrentRetryAfter}
	case l.DailyCount > 0 && u.Count >= l.DailyCount:
		return &Exceeded{Limit: LimitDailyCount, Value: int64(l.DailyCount), RetryAfter: dailyRetryAfter(u)}
	case l.DailyBytes > 0 && u.Bytes+newBytes > l.DailyBytes:
		return &Exceeded{Limit: LimitDailyBytes, Value: l.DailyBytes, RetryAfter: dailyRetryAfter(u)}
	}
	return nil
}

// dailyRetryAfter is ceil(oldest + 24h - now) in seconds: when the oldest counted upload leaves the
// window. At least 1, and never more than the window itself.
func dailyRetryAfter(u Usage) int {
	if u.Oldest.IsZero() {
		return 1
	}
	left := u.Oldest.Add(Window).Sub(u.Now)
	secs := int64((left + time.Second - 1) / time.Second) // ceil for positive durations
	return int(min(max(secs, 1), maxRetryAfterSec))
}
