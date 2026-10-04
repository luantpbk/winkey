package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/analytics"
	"github.com/luantpbk/winkey/services/video/internal/cursor"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const recommendedTTL = 10 * time.Minute

var (
	recommendedRequests = promauto.NewCounterVec(prometheus.CounterOpts{Name: "video_reco_requests_total", Help: "Recommended feed responses by signal mode."}, []string{"mode"})
	recommendedCompute  = promauto.NewHistogram(prometheus.HistogramOpts{Name: "video_reco_compute_seconds", Help: "Time computing a recommendation list.", Buckets: prometheus.ExponentialBuckets(.001, 2, 16)})
)

type RecommendationCache interface {
	GetRecommendation(context.Context, string) (domain.RecommendationList, bool)
	SetRecommendation(context.Context, string, domain.RecommendationList, time.Duration)
}

// DiversifyRecommended implements #208/#211: first compatible remaining item, else first remaining.
// Apply once to all of L before pagination. Entries are deferred, never discarded (apart from the 200 cap).
func DiversifyRecommended(list []domain.RecommendationCandidate) []uuid.UUID {
	remaining := append([]domain.RecommendationCandidate(nil), list...)
	chosen := make([]domain.RecommendationCandidate, 0, min(len(list), 200))
	for len(remaining) > 0 && len(chosen) < 200 {
		counts := map[uuid.UUID]int{}
		for _, c := range chosen[max(0, len(chosen)-9):] {
			counts[c.OwnerID]++
		}
		at := 0
		for i, c := range remaining {
			if counts[c.OwnerID] < 2 {
				at = i
				break
			}
		}
		chosen = append(chosen, remaining[at])
		remaining = append(remaining[:at], remaining[at+1:]...)
	}
	out := make([]uuid.UUID, len(chosen))
	for i, c := range chosen {
		out[i] = c.ID
	}
	return out
}

func (h *Handler) getRecommendedFeed(w http.ResponseWriter, r *http.Request) {
	limit := 20
	q := r.URL.Query()
	if raw, exists := q["limit"]; exists {
		var err error
		if len(raw) != 1 {
			err = errors.New("multiple limits")
		} else {
			limit, err = strconv.Atoi(raw[0])
		}
		if err != nil || limit < 1 || limit > 50 {
			httpx.BadRequest(w, r, "VALIDATION_ERROR", "limit must be between 1 and 50")
			return
		}
	}
	who := viewer(r)
	scope, key := "anonymous", ""
	if who.Authed {
		scope = who.ID.String()
		key = analytics.ViewerKey(h.AnalyticsSalt, "u:"+scope)
	}
	listID, offset := ids.New(), 0
	if raw, exists := q["cursor"]; exists {
		var err error
		if len(raw) != 1 {
			err = cursor.ErrInvalid
		} else {
			listID, offset, err = cursor.DecodeList(h.CursorSecret, scope, raw[0])
		}
		if err != nil {
			httpx.BadRequest(w, r, "INVALID_CURSOR", "invalid recommendation cursor")
			return
		}
	}
	if h.Recommendations == nil {
		h.fail(w, r, "recommendations", errors.New("recommendation store is not configured"))
		return
	}
	cacheKey := "reco:" + scope + ":" + listID.String()
	var list domain.RecommendationList
	hit := false
	if who.Authed && h.RecommendationCache != nil {
		list, hit = h.RecommendationCache.GetRecommendation(r.Context(), cacheKey)
	}
	if !hit {
		start := time.Now()
		candidates, err := h.Recommendations.RecommendationCandidates(r.Context(), key, who.ID, h.now())
		if err != nil {
			recommendedCompute.Observe(time.Since(start).Seconds())
			h.fail(w, r, "compute recommendation", err)
			return
		}
		list.Mode = "fallback"
		if !who.Authed {
			list.Mode = "anonymous"
		} else {
			for _, c := range candidates {
				if c.Personal {
					list.Mode = "personal"
					break
				}
			}
		}
		list.IDs = DiversifyRecommended(candidates)
		recommendedCompute.Observe(time.Since(start).Seconds())
		if who.Authed && h.RecommendationCache != nil {
			h.RecommendationCache.SetRecommendation(r.Context(), cacheKey, list, recommendedTTL)
		}
	}
	end := min(offset+limit, len(list.IDs))
	offset = min(offset, len(list.IDs))
	rows, err := h.Recommendations.RecommendationPage(r.Context(), list.IDs[offset:end], key, who.ID)
	if err != nil {
		h.fail(w, r, "read recommendation page", err)
		return
	}
	out := pageJSON[summaryJSON]{Items: make([]summaryJSON, 0, len(rows))}
	for _, s := range rows {
		out.Items = append(out.Items, h.summary(s))
	}
	if end < len(list.IDs) {
		token := cursor.EncodeList(h.CursorSecret, scope, listID, end)
		out.NextCursor = &token
	}
	if who.Authed {
		w.Header().Set("Cache-Control", cachePrivate)
	} else {
		w.Header().Set("Cache-Control", "public, max-age=60")
	}
	recommendedRequests.WithLabelValues(list.Mode).Inc()
	httpx.WriteJSON(w, http.StatusOK, out)
}
