package api

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/cursor"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// ---- GET /v1/studio/admin/videos (task ADMV1, ADR-047) ------------------------

type adminVideoJSON struct {
	studioJSON
	Owner       profileJSON `json:"owner"`
	OwnerActive bool        `json:"owner_active"`
}

var (
	validVisibilities = map[string]bool{domain.VisPublic: true, domain.VisUnlisted: true, domain.VisPrivate: true}
	validModeration   = map[string]bool{domain.ModVisible: true, domain.ModHidden: true}
)

func (h *Handler) adminListVideos(w http.ResponseWriter, r *http.Request) {
	// Authorisation from X-User-Roles only, before anything is read.
	if !viewer(r).Privileged() {
		httpx.Forbidden(w, r, "only a moderator or admin can list every video")
		return
	}
	q := r.URL.Query()
	limit, ok := h.parseLimit(w, r, q)
	if !ok {
		return
	}
	f := domain.AdminVideoQuery{
		Q: strings.TrimSpace(q.Get("q")), Status: q.Get("status"), Visibility: q.Get("visibility"),
		ModerationState: q.Get("moderation_state"),
	}
	var errs []httpx.FieldError
	if n := utf8.RuneCountInString(f.Q); q.Has("q") && (n < 2 || n > 100) {
		errs = append(errs, httpx.FieldError{Field: "q", Message: "must be 2 to 100 characters"})
	}
	if f.Status != "" && !validStatuses[f.Status] {
		errs = append(errs, httpx.FieldError{Field: "status", Message: "must be UPLOADING, UPLOADED, PROCESSING, READY or FAILED"})
	}
	if f.Visibility != "" && !validVisibilities[f.Visibility] {
		errs = append(errs, httpx.FieldError{Field: "visibility", Message: "must be PUBLIC, UNLISTED or PRIVATE"})
	}
	if f.ModerationState != "" && !validModeration[f.ModerationState] {
		errs = append(errs, httpx.FieldError{Field: "moderation_state", Message: "must be VISIBLE or HIDDEN"})
	}
	if raw := q.Get("owner_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil || id.String() != raw {
			errs = append(errs, httpx.FieldError{Field: "owner_id", Message: "must be a UUID"})
		} else {
			f.OwnerID = &id
		}
	}
	if len(errs) > 0 {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "invalid filter", errs...)
		return
	}
	// The cursor is bound to the filters, so a page cannot continue a different listing.
	scope := "q=" + f.Q + ";status=" + f.Status + ";visibility=" + f.Visibility + ";mod=" + f.ModerationState +
		";owner=" + q.Get("owner_id")
	after, ok := h.parseCursor(w, r, q, cursorAdminVideos, scope)
	if !ok {
		return
	}
	f.After, f.Limit = after, limit+1

	rows, err := h.Store.ListAdminVideos(r.Context(), f)
	if err != nil {
		h.fail(w, r, "list admin videos", err)
		return
	}
	out := pageJSON[adminVideoJSON]{Items: make([]adminVideoJSON, 0, min(len(rows), limit))}
	for i, s := range rows {
		if i == limit {
			next := cursor.Encode(h.CursorSecret, cursorAdminVideos, scope, domain.Position{T: rows[limit-1].CreatedAt, ID: rows[limit-1].ID})
			out.NextCursor = &next
			break
		}
		out.Items = append(out.Items, adminVideoJSON{studioJSON: h.studio(s.StudioItem), Owner: h.profile(s.Owner), OwnerActive: s.OwnerActive})
	}
	w.Header().Set("Cache-Control", cachePrivate)
	httpx.WriteJSON(w, http.StatusOK, out)
}
