package api

import (
	"net/http"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/cursor"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// cacheTrending: the ranking only changes every few minutes and does not depend on the caller.
const cacheTrending = "public, max-age=60"

// listTrending serves GET /v1/videos?sort=trending (task R2-a, ADR-020): the current ranking by rank, the
// cursor is the last rank returned. The store re-applies the public-feed predicate at read time, so a video
// made PRIVATE or hidden since the last recompute is never shown. Paging while a recompute happens can show a
// video twice or skip one (the ranking changed under the cursor); a client that needs the whole ranking
// reads it in one go (200 entries at most, limit up to 100).
func (h *Handler) listTrending(w http.ResponseWriter, r *http.Request, limit int) {
	after := 0
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		rank, err := cursor.DecodeRank(h.CursorSecret, cursorTrending, "", raw)
		if err != nil {
			httpx.BadRequest(w, r, "INVALID_CURSOR", "the cursor is invalid or does not belong to this request",
				httpx.FieldError{Field: "cursor", Message: "invalid cursor"})
			return
		}
		after = rank
	}
	rows, err := h.Store.ListTrending(r.Context(), domain.TrendingQuery{AfterRank: after, Limit: limit + 1})
	if err != nil {
		h.fail(w, r, "list trending", err)
		return
	}
	out := pageJSON[summaryJSON]{Items: make([]summaryJSON, 0, min(len(rows), limit))}
	for i, it := range rows {
		if i == limit {
			next := cursor.EncodeRank(h.CursorSecret, cursorTrending, "", rows[limit-1].Rank)
			out.NextCursor = &next
			break
		}
		out.Items = append(out.Items, h.summary(it.Summary))
	}
	w.Header().Set("Cache-Control", cacheTrending)
	httpx.WriteJSON(w, http.StatusOK, out)
}
