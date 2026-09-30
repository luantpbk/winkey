package api

import (
	"net/http"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/cursor"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// subscriptionFeed serves GET /v1/feed/subscriptions (task R2-b, ADR-021): the newest public videos of the channels
// the caller follows, from video-svc's own projection of social.subscription.changed (so a new subscription shows up
// within seconds, not instantly). Identity is required (401 from the middleware); the answer depends on the caller,
// so it is never cached. The cursor is the (published_at, id) keyset of the last item, bound to the caller: another
// user's cursor is an INVALID_CURSOR.
func (h *Handler) subscriptionFeed(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, ok := h.parseLimit(w, r, q)
	if !ok {
		return
	}
	who := viewer(r)
	scope := "user=" + who.ID.String()
	after, ok := h.parseCursor(w, r, q, cursorSubscriptions, scope)
	if !ok {
		return
	}
	rows, err := h.Store.ListSubscriptionFeed(r.Context(), domain.SubscriptionFeedQuery{Subscriber: who.ID, After: after, Limit: limit + 1})
	if err != nil {
		h.fail(w, r, "list subscription feed", err)
		return
	}
	out := pageJSON[summaryJSON]{Items: make([]summaryJSON, 0, min(len(rows), limit))}
	for i, s := range rows {
		if i == limit {
			next := cursor.Encode(h.CursorSecret, cursorSubscriptions, scope, domain.Position{T: rows[limit-1].PublishedAt, ID: rows[limit-1].ID})
			out.NextCursor = &next
			break
		}
		out.Items = append(out.Items, h.summary(s))
	}
	w.Header().Set("Cache-Control", cachePrivate)
	httpx.WriteJSON(w, http.StatusOK, out)
}
