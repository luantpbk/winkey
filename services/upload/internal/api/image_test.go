package api

import (
	"testing"
	"time"

	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

func TestDecideImage(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	l := ImageLimits{MaxPending: 5, DailyCount: 60}
	if ex := decideImage(l, domain.ImageUsage{Pending: 4, Count: 59, Now: now}); ex != nil {
		t.Fatalf("under the limits: %v", ex)
	}
	ex := decideImage(l, domain.ImageUsage{Pending: 5, Count: 10, Now: now})
	if ex == nil || ex.Limit != "concurrent" || ex.RetryAfter != 60 {
		t.Fatalf("pending limit: %+v", ex)
	}
	if got := ex.Error(); got != "upload quota exceeded: concurrent limit is 5 uploads in progress" {
		t.Fatalf("message %q", got)
	}
	ex = decideImage(l, domain.ImageUsage{Pending: 0, Count: 60, Oldest: now.Add(-23 * time.Hour), Now: now})
	if ex == nil || ex.Limit != "daily_count" || ex.RetryAfter != 3600 {
		t.Fatalf("daily limit: %+v", ex)
	}
	if ex := decideImage(ImageLimits{}, domain.ImageUsage{Pending: 100, Count: 1000, Now: now}); ex != nil {
		t.Fatalf("zero limits are off: %v", ex)
	}
}
