// Package api implements contracts/openapi/video.v1.yaml.
package api

import (
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/analytics"
	"github.com/luantpbk/winkey/services/video/internal/cursor"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Pagination limits of common.yaml (Limit parameter).
const (
	DefaultLimit = 24
	MaxLimit     = 100
)

const (
	cursorFeed          = "feed"
	cursorStudio        = "studio"
	cursorSearch        = "search"
	cursorTrending      = "trending"
	cursorSubscriptions = "subscriptions"
)

// Cache-Control values of GET /v1/videos/{id} (video.v1.yaml).
const (
	cachePublic  = "public, max-age=30"
	cachePrivate = "private, no-store"
)

// Handler serves the video API.
type Handler struct {
	Store        domain.Store
	Cache        domain.Cache // may be nil
	MediaBaseURL string       // e.g. https://media.winkey.vn
	MediaBucket  string       // bucket named in video.deleted
	// Objects is the media bucket for subtitle files (task V5b).
	Objects domain.Objects
	// MediaLinkSecret signs media URLs of videos the public cannot watch (SEC1, ADR-017); never logged.
	MediaLinkSecret []byte
	Now             func() time.Time // default time.Now; tests fix it
	CursorSecret    []byte
	Log             *slog.Logger

	// View counter (task C3). Views nil disables counting: reports get 202 {counted:false}.
	Views          ViewCounter
	TrustedProxies []netip.Prefix // TRUST_PROXY_CIDRS
	ViewRateLimit  int            // reports per client IP per minute; default 60

	// Search rate limits (task SR1), per client IP. Limiter nil disables them.
	Limiter          Limiter
	SearchRateLimit  int // per minute; default 60
	SuggestRateLimit int // per minute; default 120

	// Player analytics (task R1). Analytics nil = telemetry off: heartbeats are accepted and forgotten.
	Analytics          analytics.Publisher
	AnalyticsSalt      []byte // ANALYTICS_VIEWER_SALT, never logged
	HeartbeatRateLimit int    // requests per client IP per minute; default 30
}

// Routes mounts the API on r.
func (h *Handler) Routes(r chi.Router) {
	// Infrastructure only (nginx auth_request). Never routed publicly; no identity headers are read.
	r.Get("/internal/media-access/{video_id}", h.mediaAccess)
	r.Group(func(r chi.Router) { // anonymous callers allowed
		r.Use(httpx.OptionalAuthenticate)
		r.Get("/v1/videos", h.listVideos)
		r.Get("/v1/videos/batch", h.batchGetVideos) // static route: before {video_id}
		r.Get("/v1/videos/{video_id}", h.getVideo)
		r.Post("/v1/videos/{video_id}/views", h.recordView)
		r.Post("/v1/playback/heartbeats", h.recordPlaybackHeartbeats)
		r.Get("/v1/search", h.searchVideos)
		r.Get("/v1/search/suggest", h.suggestSearch)
	})
	r.Group(func(r chi.Router) { // identity required
		r.Use(httpx.Authenticate)
		r.Patch("/v1/videos/{video_id}", h.updateVideo)
		r.Delete("/v1/videos/{video_id}", h.deleteVideo)
		r.Put("/v1/videos/{video_id}/subtitles/{lang}", h.putSubtitle)
		r.Delete("/v1/videos/{video_id}/subtitles/{lang}", h.deleteSubtitle)
		r.Put("/v1/videos/{video_id}/moderation", h.moderateVideo)
		r.Get("/v1/studio/videos", h.listStudio)
		r.Get("/v1/feed/subscriptions", h.subscriptionFeed)
		r.Get("/v1/studio/stats", h.getChannelStats)
		r.Get("/v1/studio/videos/{video_id}/stats", h.getVideoStats)
	})
}

func viewer(r *http.Request) domain.Viewer {
	id, ok := httpx.IdentityFrom(r.Context())
	return domain.ViewerFrom(id, ok)
}

// ---- GET /v1/videos ---------------------------------------------------------

func (h *Handler) listVideos(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, ok := h.parseLimit(w, r, q)
	if !ok {
		return
	}
	switch sort := q.Get("sort"); sort {
	case "", "newest":
	case "trending": // task R2-a, ADR-020
		if q.Get("owner_id") != "" {
			httpx.BadRequest(w, r, "INVALID_SORT", "sort=trending cannot be combined with owner_id",
				httpx.FieldError{Field: "sort", Message: "trending has no per-channel ranking"})
			return
		}
		h.listTrending(w, r, limit)
		return
	default:
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "sort must be newest or trending",
			httpx.FieldError{Field: "sort", Message: "must be newest or trending"})
		return
	}
	var owner *uuid.UUID
	scope := "all"
	if raw := q.Get("owner_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "VALIDATION_ERROR", "owner_id must be a UUID",
				httpx.FieldError{Field: "owner_id", Message: "must be a UUID"})
			return
		}
		owner, scope = &id, "owner="+id.String()
	}
	after, ok := h.parseCursor(w, r, q, cursorFeed, scope)
	if !ok {
		return
	}

	// One query per page: the owner profiles come with it (join on
	// auth.public_profiles), so there is no per-item lookup.
	rows, err := h.Store.ListFeed(r.Context(), domain.FeedQuery{OwnerID: owner, After: after, Limit: limit + 1})
	if err != nil {
		h.fail(w, r, "list feed", err)
		return
	}
	out := pageJSON[summaryJSON]{Items: make([]summaryJSON, 0, min(len(rows), limit))}
	for i, s := range rows {
		if i == limit {
			next := cursor.Encode(h.CursorSecret, cursorFeed, scope, domain.Position{T: rows[limit-1].PublishedAt, ID: rows[limit-1].ID})
			out.NextCursor = &next
			break
		}
		out.Items = append(out.Items, h.summary(s))
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ---- GET /v1/videos/{video_id} ------------------------------------------------

func (h *Handler) getVideo(w http.ResponseWriter, r *http.Request) {
	id, ok := videoID(r)
	if !ok {
		notFound(w, r)
		return
	}
	v, err := h.load(r, id, true)
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return
	}
	if err != nil {
		h.fail(w, r, "get video", err)
		return
	}
	who := viewer(r)
	if !domain.CanView(v, who) {
		notFound(w, r) // 404, never 403: hidden videos are not confirmed to exist
		return
	}
	setCacheControl(w, v)
	httpx.WriteJSON(w, http.StatusOK, h.video(v, who))
}

// load returns the video, from the cache when useCache is set (the cached
// value is viewer independent; visibility is applied by the caller).
func (h *Handler) load(r *http.Request, id uuid.UUID, useCache bool) (domain.Video, error) {
	if useCache && h.Cache != nil {
		if v, ok := h.Cache.Get(r.Context(), id); ok {
			return v, nil
		}
	}
	v, err := h.Store.GetVideo(r.Context(), id)
	if err != nil {
		return domain.Video{}, err
	}
	if useCache && h.Cache != nil {
		h.Cache.Set(r.Context(), v)
	}
	return v, nil
}

func setCacheControl(w http.ResponseWriter, v domain.Video) {
	if domain.IsPublicReady(v) {
		w.Header().Set("Cache-Control", cachePublic)
	} else {
		w.Header().Set("Cache-Control", cachePrivate)
	}
}

// ---- PATCH /v1/videos/{video_id} ----------------------------------------------

type updateRequest struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	Visibility  *string `json:"visibility"`
}

func (h *Handler) updateVideo(w http.ResponseWriter, r *http.Request) {
	id, ok := videoID(r)
	if !ok {
		notFound(w, r)
		return
	}
	// Authorisation first, from the database (never the cache): unknown or
	// invisible → 404, visible but not yours → 403.
	v, err := h.load(r, id, false)
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return
	}
	if err != nil {
		h.fail(w, r, "load video", err)
		return
	}
	who := viewer(r)
	if !domain.CanView(v, who) {
		notFound(w, r)
		return
	}
	if !who.Owns(v) {
		httpx.Forbidden(w, r, "only the owner can edit this video")
		return
	}

	var req updateRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	var fe []httpx.FieldError
	if req.Title == nil && req.Description == nil && req.Visibility == nil {
		fe = append(fe, httpx.FieldError{Field: "body", Message: "at least one of title, description, visibility is required"})
	}
	if req.Title != nil {
		if n := utf8.RuneCountInString(*req.Title); n < 1 || n > 100 {
			fe = append(fe, httpx.FieldError{Field: "title", Message: "must be 1-100 characters"})
		}
	}
	if req.Description != nil && utf8.RuneCountInString(*req.Description) > 5000 {
		fe = append(fe, httpx.FieldError{Field: "description", Message: "must be at most 5000 characters"})
	}
	if req.Visibility != nil {
		switch *req.Visibility {
		case domain.VisPublic, domain.VisUnlisted, domain.VisPrivate:
		default:
			fe = append(fe, httpx.FieldError{Field: "visibility", Message: "must be PUBLIC, UNLISTED or PRIVATE"})
		}
	}
	if len(fe) > 0 {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "request validation failed", fe...)
		return
	}

	updated, err := h.Store.UpdateVideo(r.Context(), id, who.ID, domain.Update{
		Title: req.Title, Description: req.Description, Visibility: req.Visibility,
	})
	if h.Cache != nil {
		h.Cache.Invalidate(r.Context(), id)
	}
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r) // deleted in the meantime
		return
	}
	if err != nil {
		h.fail(w, r, "update video", err)
		return
	}
	setCacheControl(w, updated)
	httpx.WriteJSON(w, http.StatusOK, h.video(updated, who))
}

// ---- DELETE /v1/videos/{video_id} ---------------------------------------------

func (h *Handler) deleteVideo(w http.ResponseWriter, r *http.Request) {
	id, ok := videoID(r)
	if !ok {
		notFound(w, r)
		return
	}
	v, err := h.load(r, id, false)
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return
	}
	if err != nil {
		h.fail(w, r, "load video", err)
		return
	}
	who := viewer(r)
	if !domain.CanView(v, who) {
		notFound(w, r)
		return
	}
	if !who.Owns(v) && !who.Privileged() {
		httpx.Forbidden(w, r, "only the owner or a moderator can delete this video")
		return
	}

	deleted, err := h.Store.DeleteVideo(r.Context(), id, h.MediaBucket)
	if h.Cache != nil {
		h.Cache.Invalidate(r.Context(), id)
	}
	if err != nil {
		h.fail(w, r, "delete video", err)
		return
	}
	if !deleted {
		notFound(w, r) // someone else deleted it first
		return
	}
	h.Log.InfoContext(r.Context(), "video deleted", "video_id", id, "by", who.ID, "moderation", !who.Owns(v))
	w.WriteHeader(http.StatusNoContent)
}

// ---- PUT /v1/videos/{video_id}/moderation (task A2) ---------------------------

type moderateRequest struct {
	State  *string `json:"state"`
	Reason *string `json:"reason"`
}

// Longest reason: media.videos.videos_moderation_reason_len.
const maxReasonRunes = 500

func (h *Handler) moderateVideo(w http.ResponseWriter, r *http.Request) {
	who := viewer(r)
	// Authorisation from X-User-Roles only, before anything is read: 403 for
	// every authenticated caller who is not a moderator or admin.
	if !who.Privileged() {
		httpx.Forbidden(w, r, "only a moderator or admin can moderate videos")
		return
	}
	id, ok := videoID(r)
	if !ok {
		notFound(w, r)
		return
	}
	var req moderateRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	var fe []httpx.FieldError
	state := ""
	switch {
	case req.State == nil:
		fe = append(fe, httpx.FieldError{Field: "state", Message: "is required"})
	case *req.State != domain.ModVisible && *req.State != domain.ModHidden:
		fe = append(fe, httpx.FieldError{Field: "state", Message: "must be VISIBLE or HIDDEN"})
	default:
		state = *req.State
	}
	var reason *string
	if state == domain.ModHidden {
		text := ""
		if req.Reason != nil {
			text = strings.TrimSpace(*req.Reason)
		}
		switch n := utf8.RuneCountInString(text); {
		case n == 0:
			fe = append(fe, httpx.FieldError{Field: "reason", Message: "is required when state is HIDDEN"})
		case n > maxReasonRunes:
			fe = append(fe, httpx.FieldError{Field: "reason", Message: "must be at most 500 characters"})
		default:
			reason = &text
		}
	} // VISIBLE clears the reason: whatever was sent is ignored.
	if len(fe) > 0 {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "request validation failed", fe...)
		return
	}

	v, changed, err := h.Store.ModerateVideo(r.Context(), id, who.ID, state, reason)
	if h.Cache != nil {
		h.Cache.Invalidate(r.Context(), id)
	}
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return
	}
	if err != nil {
		h.fail(w, r, "moderate video", err)
		return
	}
	if changed {
		h.Log.InfoContext(r.Context(), "video moderated", "video_id", id, "state", state, "by", who.ID)
	}
	w.Header().Set("Cache-Control", cachePrivate)
	httpx.WriteJSON(w, http.StatusOK, h.video(v, who))
}

// ---- GET /v1/studio/videos ----------------------------------------------------

var validStatuses = map[string]bool{
	domain.StatusUploading: true, domain.StatusUploaded: true, domain.StatusProcessing: true,
	domain.StatusReady: true, domain.StatusFailed: true,
}

func (h *Handler) listStudio(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, ok := h.parseLimit(w, r, q)
	if !ok {
		return
	}
	status := q.Get("status")
	if status != "" && !validStatuses[status] {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "invalid status filter",
			httpx.FieldError{Field: "status", Message: "must be UPLOADING, UPLOADED, PROCESSING, READY or FAILED"})
		return
	}
	who := viewer(r)
	scope := "user=" + who.ID.String() + ";status=" + status
	after, ok := h.parseCursor(w, r, q, cursorStudio, scope)
	if !ok {
		return
	}

	rows, err := h.Store.ListStudio(r.Context(), domain.StudioQuery{UserID: who.ID, Status: status, After: after, Limit: limit + 1})
	if err != nil {
		h.fail(w, r, "list studio", err)
		return
	}
	out := pageJSON[studioJSON]{Items: make([]studioJSON, 0, min(len(rows), limit))}
	for i, s := range rows {
		if i == limit {
			next := cursor.Encode(h.CursorSecret, cursorStudio, scope, domain.Position{T: rows[limit-1].CreatedAt, ID: rows[limit-1].ID})
			out.NextCursor = &next
			break
		}
		out.Items = append(out.Items, h.studio(s))
	}
	w.Header().Set("Cache-Control", cachePrivate)
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ---- helpers ------------------------------------------------------------------

func videoID(r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "video_id"))
	return id, err == nil
}

func notFound(w http.ResponseWriter, r *http.Request) { httpx.NotFound(w, r) }

func (h *Handler) parseLimit(w http.ResponseWriter, r *http.Request, q url.Values) (int, bool) {
	raw := q.Get("limit")
	if raw == "" {
		return DefaultLimit, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > MaxLimit {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "limit must be an integer between 1 and 100",
			httpx.FieldError{Field: "limit", Message: "must be between 1 and 100"})
		return 0, false
	}
	return n, true
}

func (h *Handler) parseCursor(w http.ResponseWriter, r *http.Request, q url.Values, kind, scope string) (*domain.Position, bool) {
	raw := q.Get("cursor")
	if raw == "" {
		return nil, true
	}
	pos, err := cursor.Decode(h.CursorSecret, kind, scope, raw)
	if err != nil {
		httpx.BadRequest(w, r, "INVALID_CURSOR", "the cursor is invalid or does not belong to this request",
			httpx.FieldError{Field: "cursor", Message: "invalid cursor"})
		return nil, false
	}
	return &pos, true
}

func (h *Handler) fail(w http.ResponseWriter, r *http.Request, what string, err error) {
	h.Log.ErrorContext(r.Context(), what+" failed", "error", err)
	httpx.Internal(w, r)
}
