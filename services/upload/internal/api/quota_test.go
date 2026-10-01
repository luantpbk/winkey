package api

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
	"github.com/luantpbk/winkey/services/upload/internal/quota"
)

func newQuotaEnv(l quota.Limits, usage domain.Usage) (*env, *strings.Builder) {
	e := &env{store: newFakeStore(), storage: &fakeStorage{}, owner: ids.NewString()}
	e.store.usage = usage
	logs := &strings.Builder{}
	h := &Handler{
		Store: e.store, Storage: e.storage, RawBucket: "winkey-raw", Quota: l,
		Log: slog.New(slog.NewJSONHandler(logs, nil)),
		Now: func() time.Time { return time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC) },
	}
	r := httpx.NewRouter("upload-test", slog.New(slog.NewJSONHandler(io.Discard, nil)))
	h.Routes(r)
	e.h = r
	return e, logs
}

var qnow = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

func TestQuotaRefusalIsA429WithRetryAfterAndNoS3Call(t *testing.T) {
	for name, tc := range map[string]struct {
		usage      domain.Usage
		limit      string
		value      string
		retryAfter string
	}{
		"concurrent": {domain.Usage{Uploading: 3, Count: 3, Oldest: qnow.Add(-time.Hour), Now: qnow}, "concurrent", "3", "60"},
		"daily_count": {domain.Usage{Count: 20, Oldest: qnow.Add(-2 * time.Hour), Now: qnow}, "daily_count", "20",
			strconv.Itoa(22 * 3600)},
		"daily_bytes": {domain.Usage{Count: 1, Bytes: 50<<30 - 10, Oldest: qnow.Add(-23 * time.Hour), Now: qnow}, "daily_bytes", "53687091200", "3600"},
	} {
		t.Run(name, func(t *testing.T) {
			e, logs := newQuotaEnv(quota.Limits{MaxConcurrent: 3, DailyCount: 20, DailyBytes: 50 << 30}, tc.usage)
			before := testutil.ToFloat64(quotaRejections.WithLabelValues(tc.limit))

			w := e.do(e.owner, "creator", "POST", "/v1/uploads", validCreate)
			if w.Code != http.StatusTooManyRequests {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
			if got := w.Header().Get("Retry-After"); got != tc.retryAfter {
				t.Errorf("Retry-After = %q, want %s", got, tc.retryAfter)
			}
			if code := problemCode(t, w); code != "UPLOAD_QUOTA_EXCEEDED" {
				t.Errorf("code %s", code)
			}
			var p httpx.Problem
			decode(t, w, &p)
			if p.Status != 429 || !strings.Contains(p.Detail, tc.limit) || !strings.Contains(p.Detail, tc.value) {
				t.Errorf("problem %+v: detail must name %s and %s", p, tc.limit, tc.value)
			}
			if len(e.storage.created) != 0 || len(e.store.videos) != 0 {
				t.Errorf("a refused call created S3 uploads %v or rows %d", e.storage.created, len(e.store.videos))
			}
			if got := testutil.ToFloat64(quotaRejections.WithLabelValues(tc.limit)) - before; got != 1 {
				t.Errorf("upload_quota_rejections_total{limit=%s} grew by %v", tc.limit, got)
			}
			if !strings.Contains(logs.String(), `"owner_id":"`+e.owner+`"`) || !strings.Contains(logs.String(), `"limit":"`+tc.limit+`"`) {
				t.Errorf("log lacks owner_id/limit: %s", logs)
			}
			if strings.Contains(logs.String(), "My clip") || strings.Contains(logs.String(), "a.mp4") {
				t.Errorf("log leaks the title or filename: %s", logs)
			}
		})
	}
}

func TestQuotaPassesWhenUnderTheLimits(t *testing.T) {
	e, _ := newQuotaEnv(quota.Limits{MaxConcurrent: 3, DailyCount: 20, DailyBytes: 50 << 30},
		domain.Usage{Uploading: 2, Count: 19, Bytes: 1 << 30, Oldest: qnow.Add(-time.Hour), Now: qnow})
	if w := e.do(e.owner, "creator", "POST", "/v1/uploads", validCreate); w.Code != 201 {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if len(e.store.checked) != 1 || !e.store.checked[0] {
		t.Errorf("quota was not checked: %v", e.store.checked)
	}
}

func TestAdminSkipsTheQuota(t *testing.T) {
	over := domain.Usage{Uploading: 99, Count: 999, Bytes: 1 << 60, Oldest: qnow.Add(-time.Hour), Now: qnow}
	e, _ := newQuotaEnv(quota.Limits{MaxConcurrent: 3, DailyCount: 20, DailyBytes: 50 << 30}, over)
	if w := e.do(e.owner, "creator,admin", "POST", "/v1/uploads", validCreate); w.Code != 201 {
		t.Fatalf("admin: %d %s", w.Code, w.Body)
	}
	if len(e.store.checked) != 1 || e.store.checked[0] {
		t.Errorf("admin must not be checked: %v", e.store.checked)
	}
	// The same usage refuses a creator without the admin role.
	if w := e.do(e.owner, "creator", "POST", "/v1/uploads", validCreate); w.Code != 429 {
		t.Fatalf("creator: %d", w.Code)
	}
	// Only the exact role counts: a creator is not an admin.
	if w := e.do(e.owner, "creator,administrator", "POST", "/v1/uploads", validCreate); w.Code != 429 {
		t.Fatalf("lookalike role: %d", w.Code)
	}
}

func TestQuotaCountsTheNewUploadsOwnBytes(t *testing.T) {
	// 100 MiB are already used; the limit leaves exactly 100 MiB - 1 byte.
	used := int64(50<<30) - 104857600 + 1
	e, _ := newQuotaEnv(quota.Limits{DailyBytes: 50 << 30}, domain.Usage{Count: 1, Bytes: used, Oldest: qnow.Add(-time.Hour), Now: qnow})
	if w := e.do(e.owner, "creator", "POST", "/v1/uploads", validCreate); w.Code != 429 { // validCreate is 100 MiB
		t.Fatalf("one byte over: %d %s", w.Code, w.Body)
	}
	e, _ = newQuotaEnv(quota.Limits{DailyBytes: 50 << 30}, domain.Usage{Count: 1, Bytes: used - 1, Oldest: qnow.Add(-time.Hour), Now: qnow})
	if w := e.do(e.owner, "creator", "POST", "/v1/uploads", validCreate); w.Code != 201 {
		t.Fatalf("exactly at the limit: %d %s", w.Code, w.Body)
	}
}

// If the transaction fails to commit after S3 CreateMultipartUpload succeeded, the multipart upload is
// aborted: no orphan, no row.
func TestCommitFailureAbortsTheMultipartUpload(t *testing.T) {
	e, _ := newQuotaEnv(quota.Limits{MaxConcurrent: 3}, domain.Usage{Now: qnow})
	e.store.createErr = errors.New("commit failed")
	w := e.do(e.owner, "creator", "POST", "/v1/uploads", validCreate)
	if w.Code != 500 {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if len(e.storage.created) != 1 || len(e.storage.aborted) != 1 || len(e.store.videos) != 0 {
		t.Errorf("created %v, aborted %v, rows %d", e.storage.created, e.storage.aborted, len(e.store.videos))
	}
}

// If S3 refuses, nothing is written and nothing needs aborting.
func TestS3FailureWritesNothing(t *testing.T) {
	e, _ := newQuotaEnv(quota.Limits{MaxConcurrent: 3}, domain.Usage{Now: qnow})
	e.storage.createErr = errors.New("s3 down")
	if w := e.do(e.owner, "creator", "POST", "/v1/uploads", validCreate); w.Code != 500 {
		t.Fatalf("got %d", w.Code)
	}
	if len(e.storage.aborted) != 0 || len(e.store.videos) != 0 {
		t.Errorf("aborted %v, rows %d", e.storage.aborted, len(e.store.videos))
	}
}
