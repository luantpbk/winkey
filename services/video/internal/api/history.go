package api

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/cursor"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Watch history (task HIST1, ADR-044).

type historyItemJSON struct {
	Video     summaryJSON `json:"video"`
	WatchedAt time.Time   `json:"watched_at"`
	WatchedMs int64       `json:"watched_ms"`
}

// recordHistory adds the video to a signed-in viewer's history after a view report that passed the threshold.
// Best effort: a failure is logged and never fails the view report.
func (h *Handler) recordHistory(ctx context.Context, user, video uuid.UUID, watchedMs int64) {
	if err := h.Store.RecordWatch(context.WithoutCancel(ctx), user, video, watchedMs); err != nil {
		h.Log.WarnContext(ctx, "watch history not recorded", "video_id", video, "error", err)
	}
}

// ---- GET /v1/me/history -----------------------------------------------------------

func (h *Handler) getWatchHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, ok := h.parseLimit(w, r, q)
	if !ok {
		return
	}
	who := viewer(r)
	scope := "user=" + who.ID.String()
	after, ok := h.parseCursor(w, r, q, cursorHistory, scope)
	if !ok {
		return
	}
	rows, err := h.Store.ListHistory(r.Context(), domain.HistoryQuery{User: who.ID, After: after, Limit: limit + 1})
	if err != nil {
		h.fail(w, r, "list history", err)
		return
	}
	out := pageJSON[historyItemJSON]{Items: make([]historyItemJSON, 0, min(len(rows), limit))}
	for i, e := range rows {
		if i == limit {
			last := rows[limit-1]
			next := cursor.Encode(h.CursorSecret, cursorHistory, scope, domain.Position{T: last.WatchedAt, ID: last.Video.ID})
			out.NextCursor = &next
			break
		}
		out.Items = append(out.Items, historyItemJSON{Video: h.summary(e.Video), WatchedAt: e.WatchedAt.UTC(), WatchedMs: e.WatchedMs})
	}
	w.Header().Set("Cache-Control", cachePrivate)
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ---- DELETE /v1/me/history and /v1/me/history/{video_id} --------------------------

func (h *Handler) clearWatchHistory(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.ClearHistory(r.Context(), viewer(r).ID); err != nil {
		h.fail(w, r, "clear history", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) removeFromWatchHistory(w http.ResponseWriter, r *http.Request) {
	id, ok := videoID(r)
	if !ok {
		w.WriteHeader(http.StatusNoContent) // never in anyone's history
		return
	}
	if err := h.Store.RemoveFromHistory(r.Context(), viewer(r).ID, id); err != nil {
		h.fail(w, r, "remove from history", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
