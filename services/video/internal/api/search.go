package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/cursor"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/views"
)

// Search constants of video.v1.yaml (searchVideos, suggestSearch).
const (
	maxSearchPages = 10 // pages served per query; the last one has next_cursor null

	searchMaxRunes  = 100
	suggestMinRunes = 2
	suggestMaxRunes = 50
	suggestLimit    = 8

	defaultSearchRateLimit  = 60
	defaultSuggestRateLimit = 120
	searchRateWindow        = time.Minute

	cacheSearch  = "public, max-age=30"
	cacheSuggest = "public, max-age=60"
)

var (
	// searchTotal counts searches by the mode that served them: fts, trgm
	// (the typo fallback) or empty (no result); rate_limited when refused.
	searchTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "video_search_total", Help: "Search requests by result mode.",
	}, []string{"mode"})
	searchSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "video_search_seconds", Help: "Time GET /v1/search spends in the database.",
		Buckets: prometheus.ExponentialBuckets(0.002, 2, 12),
	})
)

// Limiter is a fixed-window rate limiter keyed by scope and client IP (views.Valkey).
type Limiter interface {
	AllowScoped(ctx context.Context, scope, ip string, limit int, window time.Duration) (ok bool, retryAfter time.Duration, err error)
}

type suggestionsJSON struct {
	Items []string `json:"items"`
}

// searchText validates and trims q. The text itself is never logged.
func searchText(w http.ResponseWriter, r *http.Request, minRunes, maxRunes int) (string, bool) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	n := utf8.RuneCountInString(q)
	if n < minRunes || n > maxRunes || !utf8.ValidString(q) || strings.ContainsRune(q, 0) {
		msg := "must be " + strconv.Itoa(minRunes) + "-" + strconv.Itoa(maxRunes) + " valid characters"
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "invalid q", httpx.FieldError{Field: "q", Message: msg})
		return "", false
	}
	return q, true
}

// limited applies the per-IP limit of an endpoint and answers 429 itself. A
// Valkey outage fails open: search must not depend on the limiter.
func (h *Handler) limited(w http.ResponseWriter, r *http.Request, scope string, limit, def int) bool {
	if h.Limiter == nil {
		return false
	}
	if limit <= 0 {
		limit = def
	}
	ok, retry, err := h.Limiter.AllowScoped(r.Context(), scope, views.ClientIP(r, h.TrustedProxies), limit, searchRateWindow)
	if err != nil || ok {
		return false
	}
	secs := int(retry.Round(time.Second) / time.Second)
	if secs < 1 {
		secs = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	if scope == "search" {
		searchTotal.WithLabelValues("rate_limited").Inc()
	}
	httpx.WriteProblem(w, r, httpx.NewProblem(http.StatusTooManyRequests, "RATE_LIMITED", "too many requests; retry later"))
	return true
}

// ---- GET /v1/search -------------------------------------------------------------

func (h *Handler) searchVideos(w http.ResponseWriter, r *http.Request) {
	if h.limited(w, r, "search", h.SearchRateLimit, defaultSearchRateLimit) {
		return
	}
	q, ok := searchText(w, r, 1, searchMaxRunes)
	if !ok {
		return
	}
	query := r.URL.Query()
	limit, ok := h.parseLimit(w, r, query)
	if !ok {
		return
	}

	// The cursor is bound to the query text, so it cannot be replayed with another q.
	scope := "q=" + q
	sq := domain.SearchQuery{Q: q, Limit: limit + 1}
	page := 1
	if raw := query.Get("cursor"); raw != "" {
		pos, err := cursor.DecodeSearch(h.CursorSecret, cursorSearch, scope, raw)
		if err != nil || pos.Page > maxSearchPages {
			httpx.BadRequest(w, r, "INVALID_CURSOR", "the cursor is invalid or does not belong to this request",
				httpx.FieldError{Field: "cursor", Message: "invalid cursor"})
			return
		}
		sq.Mode, sq.After, page = pos.Mode, &pos.SearchAfter, pos.Page
	}

	start := time.Now()
	res, err := h.Store.SearchVideos(r.Context(), sq)
	searchSeconds.Observe(time.Since(start).Seconds())
	if err != nil {
		h.fail(w, r, "search videos", err)
		return
	}
	mode := res.Mode
	if len(res.Hits) == 0 {
		mode = "empty"
	}
	searchTotal.WithLabelValues(mode).Inc()
	// Length only: the text is user input and may be personal.
	h.Log.DebugContext(r.Context(), "search", "q_len", utf8.RuneCountInString(q), "mode", mode, "page", page, "hits", len(res.Hits))

	out := pageJSON[summaryJSON]{Items: make([]summaryJSON, 0, min(len(res.Hits), limit))}
	for i, hit := range res.Hits {
		if i == limit {
			if page < maxSearchPages {
				last := res.Hits[limit-1]
				next := cursor.EncodeSearch(h.CursorSecret, cursorSearch, scope, cursor.SearchPosition{
					Mode: res.Mode, Page: page + 1,
					SearchAfter: domain.SearchAfter{Rank: last.Rank, T: last.PublishedAt, ID: last.ID},
				})
				out.NextCursor = &next
			}
			break
		}
		out.Items = append(out.Items, h.summary(hit.Summary))
	}
	w.Header().Set("Cache-Control", cacheSearch)
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ---- GET /v1/search/suggest -----------------------------------------------------

func (h *Handler) suggestSearch(w http.ResponseWriter, r *http.Request) {
	if h.limited(w, r, "suggest", h.SuggestRateLimit, defaultSuggestRateLimit) {
		return
	}
	q, ok := searchText(w, r, suggestMinRunes, suggestMaxRunes)
	if !ok {
		return
	}
	titles, err := h.Store.SuggestTitles(r.Context(), q, suggestLimit)
	if err != nil {
		h.fail(w, r, "suggest titles", err)
		return
	}
	if titles == nil {
		titles = []string{}
	}
	w.Header().Set("Cache-Control", cacheSuggest)
	httpx.WriteJSON(w, http.StatusOK, suggestionsJSON{Items: titles})
}
