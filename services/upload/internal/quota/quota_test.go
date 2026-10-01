package quota

import (
	"testing"
	"time"
)

var now = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

var limits = Limits{MaxConcurrent: 3, DailyCount: 20, DailyBytes: 50 << 30}

func TestDecide(t *testing.T) {
	for name, tc := range map[string]struct {
		u         Usage
		newBytes  int64
		wantLimit string // "" = allowed
		wantValue int64
	}{
		"empty account":                                   {Usage{Now: now}, 1, "", 0},
		"2 open: the 3rd is fine":                         {Usage{Uploading: 2, Count: 2, Now: now}, 1, "", 0},
		"3 open: the 4th is refused":                      {Usage{Uploading: 3, Count: 3, Oldest: now.Add(-time.Hour), Now: now}, 1, LimitConcurrent, 3},
		"more than 3 open (config lowered)":               {Usage{Uploading: 7, Count: 7, Oldest: now.Add(-time.Hour), Now: now}, 1, LimitConcurrent, 3},
		"19 in 24h: the 20th is fine":                     {Usage{Count: 19, Oldest: now.Add(-time.Hour), Now: now}, 1, "", 0},
		"20 in 24h: the 21st is refused":                  {Usage{Count: 20, Oldest: now.Add(-time.Hour), Now: now}, 1, LimitDailyCount, 20},
		"bytes: exactly at the limit is fine":             {Usage{Count: 1, Bytes: 50<<30 - 100, Oldest: now.Add(-time.Hour), Now: now}, 100, "", 0},
		"bytes: one over is refused (new upload counted)": {Usage{Count: 1, Bytes: 50<<30 - 100, Oldest: now.Add(-time.Hour), Now: now}, 101, LimitDailyBytes, 50 << 30},
		"bytes: the new upload alone fits an empty day":   {Usage{Now: now}, 20 << 30, "", 0},
		"concurrent wins over daily_count":                {Usage{Uploading: 3, Count: 20, Oldest: now.Add(-time.Hour), Now: now}, 1, LimitConcurrent, 3},
		"daily_count wins over daily_bytes":               {Usage{Count: 20, Bytes: 50 << 30, Oldest: now.Add(-time.Hour), Now: now}, 1, LimitDailyCount, 20},
	} {
		t.Run(name, func(t *testing.T) {
			got := Decide(limits, tc.u, tc.newBytes)
			switch {
			case tc.wantLimit == "" && got != nil:
				t.Fatalf("refused: %+v", got)
			case tc.wantLimit != "" && got == nil:
				t.Fatalf("allowed, want %s", tc.wantLimit)
			case got != nil && (got.Limit != tc.wantLimit || got.Value != tc.wantValue):
				t.Fatalf("got %+v, want %s=%d", got, tc.wantLimit, tc.wantValue)
			}
		})
	}
}

func TestZeroLimitsSwitchTheCheckOff(t *testing.T) {
	u := Usage{Uploading: 100, Count: 1000, Bytes: 1 << 50, Oldest: now.Add(-time.Hour), Now: now}
	if ex := Decide(Limits{}, u, 1<<40); ex != nil {
		t.Fatalf("zero limits refused: %+v", ex)
	}
}

func TestRetryAfter(t *testing.T) {
	for name, tc := range map[string]struct {
		oldest time.Time
		limit  string
		want   int
	}{
		"concurrent is always 60":                          {now.Add(-time.Hour), LimitConcurrent, 60},
		"oldest 1 h old: 23 h left":                        {now.Add(-time.Hour), LimitDailyCount, 23 * 3600},
		"a started fraction of a second rounds up":         {now.Add(-24*time.Hour + 1500*time.Millisecond), LimitDailyCount, 2},
		"half a second left is 1":                          {now.Add(-24*time.Hour + 500*time.Millisecond), LimitDailyCount, 1},
		"expires exactly now: at least 1":                  {now.Add(-24 * time.Hour), LimitDailyCount, 1},
		"already past the window (clock skew): at least 1": {now.Add(-25 * time.Hour), LimitDailyCount, 1},
		"just created: the whole window":                   {now, LimitDailyBytes, 24 * 3600},
		"in the future (skew) is capped at the window":     {now.Add(time.Hour), LimitDailyBytes, 24 * 3600},
	} {
		t.Run(name, func(t *testing.T) {
			u := Usage{Uploading: 3, Count: 20, Bytes: 50 << 30, Oldest: tc.oldest, Now: now}
			l := limits
			var want Limits
			switch tc.limit { // make exactly the wanted limit the one that trips
			case LimitConcurrent:
				want = Limits{MaxConcurrent: 3}
			case LimitDailyCount:
				want = Limits{DailyCount: 20}
			default:
				want = Limits{DailyBytes: 50 << 30}
				u.Bytes = 50 << 30
			}
			_ = l
			got := Decide(want, u, 1)
			if got == nil || got.Limit != tc.limit {
				t.Fatalf("got %+v, want %s", got, tc.limit)
			}
			if got.RetryAfter != tc.want {
				t.Errorf("Retry-After = %d, want %d", got.RetryAfter, tc.want)
			}
		})
	}
	// No counted row (cannot happen for the daily limits, but must not panic or return 0).
	if got := Decide(Limits{DailyCount: 1}, Usage{Count: 1, Now: now}, 1); got == nil || got.RetryAfter != 1 {
		t.Errorf("no oldest: %+v", got)
	}
}

func TestExceededMessageNamesTheLimitAndItsValue(t *testing.T) {
	for _, tc := range []struct {
		ex   Exceeded
		want []string
	}{
		{Exceeded{Limit: LimitConcurrent, Value: 3}, []string{"concurrent", "3"}},
		{Exceeded{Limit: LimitDailyCount, Value: 20}, []string{"daily_count", "20"}},
		{Exceeded{Limit: LimitDailyBytes, Value: 53687091200}, []string{"daily_bytes", "53687091200"}},
	} {
		msg := tc.ex.Error()
		for _, w := range tc.want {
			if !contains(msg, w) {
				t.Errorf("%q does not contain %q", msg, w)
			}
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
