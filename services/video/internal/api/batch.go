package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

const maxBatchIDs = 50

var batchGetIDs = promauto.NewHistogram(prometheus.HistogramOpts{
	Name: "video_batch_get_ids", Help: "Number of ids per GET /v1/videos/batch request.",
	Buckets: []float64{1, 2, 5, 10, 20, 30, 40, 50},
})

type batchJSON struct {
	Items []summaryJSON `json:"items"`
}

// batchGetVideos serves GET /v1/videos/batch?ids=a,b,c (task PL1-v, ADR-024): summaries in the order of ids, only of
// the videos getVideo would return to this caller right now; the others are silently left out.
func (h *Handler) batchGetVideos(w http.ResponseWriter, r *http.Request) {
	ids, fe := parseBatchIDs(r.URL.Query()["ids"])
	if fe != nil {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "ids: "+fe.Message, *fe)
		return
	}
	batchGetIDs.Observe(float64(len(ids)))
	who := viewer(r)

	found := make(map[uuid.UUID]domain.Video, len(ids))
	var missing []uuid.UUID
	for _, id := range ids {
		if h.Cache != nil {
			if v, ok := h.Cache.Get(r.Context(), id); ok {
				found[id] = v
				continue
			}
		}
		missing = append(missing, id)
	}
	if len(missing) > 0 { // ONE query for all misses; not written to the cache (no renditions or subtitles in it)
		rows, err := h.Store.VideosByID(r.Context(), missing)
		if err != nil {
			h.fail(w, r, "batch get videos", err)
			return
		}
		for _, v := range rows {
			found[v.ID] = v
		}
	}

	items := make([]summaryJSON, 0, len(ids))
	for _, id := range ids {
		v, ok := found[id]
		if !ok || !readableSummary(v, who) {
			continue
		}
		items = append(items, h.batchSummary(v))
	}
	if who.Authed {
		w.Header().Set("Cache-Control", cachePrivate)
	} else {
		w.Header().Set("Cache-Control", cachePublic)
	}
	httpx.WriteJSON(w, http.StatusOK, batchJSON{Items: items})
}

// readableSummary is what getVideo would return AND has the fields of a VideoSummary: READY, visible to the caller.
func readableSummary(v domain.Video, who domain.Viewer) bool {
	return v.Status == domain.StatusReady && domain.CanView(v, who) &&
		v.ThumbnailKey != nil && v.PublishedAt != nil && v.DurationMs != nil
}

func (h *Handler) batchSummary(v domain.Video) summaryJSON {
	thumb := h.mediaURL(*v.ThumbnailKey)
	if !v.PubliclyWatchable() { // owner, moderator or admin looking at a private or hidden video: signed (ADR-017)
		thumb = h.signedMediaURL(v.ID, *v.ThumbnailKey, h.mediaExpiry())
	}
	owner := h.profile(v.Owner)
	if owner.ID == "" {
		owner.ID = v.OwnerID.String()
	}
	return summaryJSON{ID: v.ID.String(), Title: v.Title, Owner: owner, DurationMs: *v.DurationMs, ViewCount: v.ViewCount,
		PublishedAt: v.PublishedAt.UTC(), ThumbnailURL: thumb}
}

// parseBatchIDs accepts ids=a,b,c (or a repeated ids parameter), 1..50 valid distinct UUIDs.
func parseBatchIDs(values []string) ([]uuid.UUID, *httpx.FieldError) {
	var raw []string
	for _, v := range values {
		if v == "" {
			continue
		}
		raw = append(raw, strings.Split(v, ",")...)
	}
	if len(raw) == 0 {
		return nil, &httpx.FieldError{Field: "ids", Message: "is required: 1 to 50 comma-separated video ids"}
	}
	if len(raw) > maxBatchIDs {
		return nil, &httpx.FieldError{Field: "ids", Message: "must hold at most 50 ids"}
	}
	seen := make(map[uuid.UUID]bool, len(raw))
	out := make([]uuid.UUID, 0, len(raw))
	for _, s := range raw {
		id, err := uuid.Parse(strings.TrimSpace(s))
		if err != nil || len(strings.TrimSpace(s)) != 36 {
			return nil, &httpx.FieldError{Field: "ids", Message: "every id must be a UUID"}
		}
		if seen[id] {
			return nil, &httpx.FieldError{Field: "ids", Message: "must not contain duplicates"}
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}
