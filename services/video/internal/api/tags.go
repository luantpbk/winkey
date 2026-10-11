package api

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Tag landing pages (task SEO2, ADR-037). Slugs are derived by PostgreSQL (public.winkey_tag_slug), never here.
const (
	cacheTag        = "public, max-age=60"
	cacheTagList    = "public, max-age=300"
	maxTagInput     = 100
	defaultTagLimit = 100
	maxTagLimit     = 1000
)

type tagJSON struct {
	Slug              string    `json:"slug"`
	Name              string    `json:"name"`
	VideoCount        int       `json:"video_count"`
	LatestPublishedAt time.Time `json:"latest_published_at"`
}

func tagOut(t domain.Tag) tagJSON {
	return tagJSON{Slug: t.Slug, Name: t.Name, VideoCount: t.VideoCount, LatestPublishedAt: t.LatestPublishedAt.UTC()}
}

// parseTag reads the optional listVideos `tag` filter: trimmed, 1..100 characters. "" = no filter.
func parseTag(w http.ResponseWriter, r *http.Request, q url.Values) (string, bool) {
	if !q.Has("tag") {
		return "", true
	}
	tag := strings.TrimSpace(q.Get("tag"))
	if tag == "" || utf8.RuneCountInString(tag) > maxTagInput {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "tag must be 1 to 100 characters",
			httpx.FieldError{Field: "tag", Message: "must be 1 to 100 characters"})
		return "", false
	}
	return tag, true
}

// ---- GET /v1/tags -------------------------------------------------------------

func (h *Handler) listTags(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, ok := intParam(w, r, q, "limit", defaultTagLimit, maxTagLimit)
	if !ok {
		return
	}
	minVideos, ok := intParam(w, r, q, "min_videos", 1, maxTagLimit)
	if !ok {
		return
	}
	tags, err := h.Store.ListTags(r.Context(), limit, minVideos)
	if err != nil {
		h.fail(w, r, "list tags", err)
		return
	}
	out := struct {
		Items []tagJSON `json:"items"`
	}{Items: make([]tagJSON, 0, len(tags))}
	for _, t := range tags {
		out.Items = append(out.Items, tagOut(t))
	}
	w.Header().Set("Cache-Control", cacheTagList)
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ---- GET /v1/tags/{tag} -------------------------------------------------------

func (h *Handler) getTag(w http.ResponseWriter, r *http.Request) {
	tag := strings.TrimSpace(chi.URLParam(r, "tag"))
	if tag == "" || utf8.RuneCountInString(tag) > maxTagInput {
		notFound(w, r)
		return
	}
	t, err := h.Store.GetTag(r.Context(), tag)
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return
	}
	if err != nil {
		h.fail(w, r, "get tag", err)
		return
	}
	w.Header().Set("Cache-Control", cacheTag)
	httpx.WriteJSON(w, http.StatusOK, tagOut(t))
}

// intParam reads an optional integer query parameter in [1, max]; def when absent.
func intParam(w http.ResponseWriter, r *http.Request, q url.Values, name string, def, max int) (int, bool) {
	raw := q.Get(name)
	if raw == "" {
		return def, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > max {
		msg := "must be an integer between 1 and " + strconv.Itoa(max)
		httpx.BadRequest(w, r, "VALIDATION_ERROR", name+" "+msg, httpx.FieldError{Field: name, Message: msg})
		return 0, false
	}
	return n, true
}
