package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/views"
)

// View counting constants of video.v1.yaml (recordView).
const (
	maxWatchedMs         = 86_400_000
	viewThresholdMs      = 30_000
	defaultViewRateLimit = 60
	viewRateWindow       = time.Minute
)

// ViewCounter is the Valkey side of the view counter (views.Valkey).
type ViewCounter interface {
	// Allow counts one report from ip; ok is false above the limit.
	Allow(ctx context.Context, ip string, limit int, window time.Duration) (ok bool, retryAfter time.Duration, err error)
	// Count adds one view unless the viewer or the playback was already counted.
	Count(ctx context.Context, videoID, playbackID uuid.UUID, viewer string) (bool, error)
}

type recordViewRequest struct {
	PlaybackID *string `json:"playback_id"`
	WatchedMs  *int64  `json:"watched_ms"`
}

type recordViewResult struct {
	Counted bool `json:"counted"`
}

func (h *Handler) recordView(w http.ResponseWriter, r *http.Request) {
	id, ok := videoID(r)
	if !ok {
		notFound(w, r)
		return
	}
	ip := views.ClientIP(r, h.TrustedProxies)

	// Rate limit first: it is the cheapest check and keeps floods away from PostgreSQL.
	if h.Views != nil {
		limit := h.ViewRateLimit
		if limit <= 0 {
			limit = defaultViewRateLimit
		}
		allowed, retry, err := h.Views.Allow(r.Context(), ip, limit, viewRateWindow)
		// err != nil: Valkey is down. The limit fails open; Count below fails too and answers counted:false.
		if err == nil && !allowed {
			secs := int(retry.Round(time.Second) / time.Second)
			if secs < 1 {
				secs = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			views.ViewsTotal.WithLabelValues("rate_limited").Inc()
			httpx.WriteProblem(w, r, httpx.NewProblem(http.StatusTooManyRequests, "RATE_LIMITED", "too many view reports; retry later"))
			return
		}
	}

	var req recordViewRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	var fe []httpx.FieldError
	var playback uuid.UUID
	if req.PlaybackID == nil {
		fe = append(fe, httpx.FieldError{Field: "playback_id", Message: "is required"})
	} else if p, err := uuid.Parse(*req.PlaybackID); err != nil {
		fe = append(fe, httpx.FieldError{Field: "playback_id", Message: "must be a UUID"})
	} else {
		playback = p
	}
	if req.WatchedMs == nil {
		fe = append(fe, httpx.FieldError{Field: "watched_ms", Message: "is required"})
	} else if *req.WatchedMs < 0 || *req.WatchedMs > maxWatchedMs {
		fe = append(fe, httpx.FieldError{Field: "watched_ms", Message: "must be between 0 and 86400000"})
	}
	if len(fe) > 0 {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "invalid view report", fe...)
		return
	}

	v, err := h.load(r, id, true)
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return
	}
	if err != nil {
		h.fail(w, r, "load video", err)
		return
	}
	who := viewer(r)
	if !domain.CanView(v, who) || v.Status != domain.StatusReady {
		notFound(w, r)
		return
	}

	// A hidden video is readable by its owner, moderators and admins only, and is
	// never counted (task A2). Everyone else already got 404 above.
	if v.Hidden() {
		views.ViewsTotal.WithLabelValues("hidden").Inc()
		writeCounted(w, false)
		return
	}

	// The server re-checks the threshold: min(30 s, duration / 2).
	need := int64(viewThresholdMs)
	if v.DurationMs != nil && int64(*v.DurationMs)/2 < need {
		need = int64(*v.DurationMs) / 2
	}
	if *req.WatchedMs < need {
		views.ViewsTotal.WithLabelValues("below_threshold").Inc()
		writeCounted(w, false)
		return
	}

	if h.Views == nil {
		views.ViewsTotal.WithLabelValues("valkey_down").Inc()
		writeCounted(w, false)
		return
	}
	counted, err := h.Views.Count(r.Context(), id, playback, viewerKey(who, ip, r.UserAgent()))
	if err != nil {
		h.Log.WarnContext(r.Context(), "view not counted: valkey unavailable", "error", err)
		views.ViewsTotal.WithLabelValues("valkey_down").Inc()
		writeCounted(w, false)
		return
	}
	if counted {
		views.ViewsTotal.WithLabelValues("counted").Inc()
	} else {
		views.ViewsTotal.WithLabelValues("duplicate").Inc()
	}
	writeCounted(w, counted)
}

func writeCounted(w http.ResponseWriter, counted bool) {
	httpx.WriteJSON(w, http.StatusAccepted, recordViewResult{Counted: counted})
}

// viewerKey is the user id when authenticated, otherwise sha256(client_ip + user_agent).
func viewerKey(who domain.Viewer, ip, userAgent string) string {
	if who.Authed {
		return "u:" + who.ID.String()
	}
	sum := sha256.Sum256([]byte(ip + userAgent))
	return "a:" + hex.EncodeToString(sum[:])
}
