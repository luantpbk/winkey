package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/vtt"
)

// Subtitles (task V5b, ADR-018).
const (
	subtitleContentType = "text/vtt; charset=utf-8"
	// cacheImmutable is what the transcoder sets on its outputs: every upload has a new key, so the
	// object never changes.
	cacheImmutable = "public, max-age=31536000, immutable"
	// maxSubtitleBody bounds the JSON body: 512 KiB of text can grow up to 6x when every character
	// needs a \u00XX escape, so 4 MiB is generous; a larger body is SUBTITLE_TOO_LARGE too.
	maxSubtitleBody = 4 << 20
	maxLabelRunes   = 50
)

var langRe = regexp.MustCompile(`^[a-z]{2,3}(-[A-Z]{2})?$`)

type putSubtitleRequest struct {
	Label   *string `json:"label"`
	Content *string `json:"content"`
}

type subtitleJSON struct {
	Lang      string    `json:"lang"`
	Label     string    `json:"label"`
	Source    string    `json:"source"`
	URL       string    `json:"url"`
	UpdatedAt time.Time `json:"updated_at"`
}

// subtitleTracks renders the tracks of a video for playback: plain URLs, or signed with expires when the
// video is not publicly watchable (the same rule and the same expiry as hls_url). Never nil.
func (h *Handler) subtitleTracks(v domain.Video, signedUntil *time.Time) []subtitleJSON {
	out := make([]subtitleJSON, 0, len(v.Subtitles))
	for _, s := range v.Subtitles {
		u := h.mediaURL(s.ObjectKey)
		if signedUntil != nil {
			u = h.signedMediaURL(v.ID, s.ObjectKey, *signedUntil)
		}
		out = append(out, subtitleJSON{Lang: s.Lang, Label: s.Label, Source: s.Source, URL: u, UpdatedAt: s.UpdatedAt.UTC()})
	}
	return out
}

// ownedVideo applies the rules of updateVideo to a subtitle call: 404 when the video does not exist or the
// caller may not see it, 403 when they see it but do not own it (moderators and admins included).
func (h *Handler) ownedVideo(w http.ResponseWriter, r *http.Request) (domain.Video, domain.Viewer, bool) {
	id, ok := videoID(r)
	if !ok {
		notFound(w, r)
		return domain.Video{}, domain.Viewer{}, false
	}
	v, err := h.load(r, id, false) // from the database, never the cache: authorisation
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return domain.Video{}, domain.Viewer{}, false
	}
	if err != nil {
		h.fail(w, r, "load video", err)
		return domain.Video{}, domain.Viewer{}, false
	}
	who := viewer(r)
	if !domain.CanView(v, who) {
		notFound(w, r)
		return domain.Video{}, domain.Viewer{}, false
	}
	if !who.Owns(v) {
		httpx.Forbidden(w, r, "only the owner can edit the subtitles of this video")
		return domain.Video{}, domain.Viewer{}, false
	}
	return v, who, true
}

// ---- PUT /v1/videos/{video_id}/subtitles/{lang} --------------------------------

func (h *Handler) putSubtitle(w http.ResponseWriter, r *http.Request) {
	v, _, ok := h.ownedVideo(w, r)
	if !ok {
		return
	}
	if v.Status == domain.StatusFailed {
		httpx.Conflict(w, r, "VIDEO_FAILED", "a video whose processing failed cannot have subtitles")
		return
	}
	lang := chi.URLParam(r, "lang")
	if !langRe.MatchString(lang) {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "invalid language tag",
			httpx.FieldError{Field: "lang", Message: "must look like vi, en or en-US"})
		return
	}

	var req putSubtitleRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxSubtitleBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpx.BadRequest(w, r, "SUBTITLE_TOO_LARGE", "the request body is too large for a subtitle file",
				httpx.FieldError{Field: "content", Message: "at most 524288 bytes"})
			return
		}
		httpx.BadRequest(w, r, "INVALID_JSON", "request body is not valid JSON for this endpoint")
		return
	}
	if dec.More() {
		httpx.BadRequest(w, r, "INVALID_JSON", "unexpected data after JSON body")
		return
	}

	var fe []httpx.FieldError
	label := ""
	if req.Label == nil {
		fe = append(fe, httpx.FieldError{Field: "label", Message: "is required"})
	} else if label = strings.TrimSpace(*req.Label); label == "" || utf8.RuneCountInString(label) > maxLabelRunes || !utf8.ValidString(label) {
		fe = append(fe, httpx.FieldError{Field: "label", Message: "must be 1-50 characters"})
	}
	if req.Content == nil {
		fe = append(fe, httpx.FieldError{Field: "content", Message: "is required"})
	}
	if len(fe) > 0 {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "request validation failed", fe...)
		return
	}

	normalised, verr := vtt.Validate(*req.Content)
	if verr != nil {
		code := "INVALID_WEBVTT"
		if verr.TooLarge {
			code = "SUBTITLE_TOO_LARGE"
		}
		httpx.BadRequest(w, r, code, verr.Error(), httpx.FieldError{Field: "content", Message: verr.Error()})
		return
	}

	// 1. The object first, under a NEW key (never overwritten, so it can be cached forever) ...
	key := "v/" + v.ID.String() + "/subtitles/" + lang + "-" + ids.NewString() + ".vtt"
	if err := h.Objects.Put(r.Context(), h.MediaBucket, key, []byte(normalised), subtitleContentType, cacheImmutable); err != nil {
		h.fail(w, r, "upload subtitle", err)
		return
	}
	// 2. ... then the row, in one transaction with the limit checked under a lock on the video.
	res, err := h.Store.PutSubtitle(r.Context(), domain.SubtitleWrite{
		VideoID: v.ID, Lang: lang, Label: label, ObjectKey: key, SizeBytes: len(normalised),
	})
	if err != nil {
		h.deleteObject(key, v, "discard subtitle after a failed update") // the row does not point at it
		switch {
		case errors.Is(err, domain.ErrTooManySubtitles):
			httpx.Conflict(w, r, "TOO_MANY_SUBTITLES", "a video has at most 20 subtitle tracks")
		case errors.Is(err, domain.ErrNotFound):
			notFound(w, r) // deleted in the meantime
		case errors.Is(err, domain.ErrVideoFailed):
			httpx.Conflict(w, r, "VIDEO_FAILED", "a video whose processing failed cannot have subtitles")
		default:
			h.fail(w, r, "put subtitle", err)
		}
		return
	}
	if h.Cache != nil {
		h.Cache.Invalidate(r.Context(), v.ID)
	}
	// 3. After the commit: the replaced object is garbage now. Best effort, never fails the request.
	if res.PreviousKey != "" && res.PreviousKey != key {
		h.deleteObject(res.PreviousKey, v, "delete the replaced subtitle object")
	}

	var signedUntil *time.Time
	if !v.PubliclyWatchable() {
		exp := h.mediaExpiry()
		signedUntil = &exp
	}
	track := h.subtitleTracks(domain.Video{ID: v.ID, Subtitles: []domain.Subtitle{res.Track}}, signedUntil)[0]
	status := http.StatusOK
	if res.Created {
		status = http.StatusCreated
	}
	w.Header().Set("Cache-Control", cachePrivate)
	httpx.WriteJSON(w, status, track)
}

// ---- DELETE /v1/videos/{video_id}/subtitles/{lang} -----------------------------

func (h *Handler) deleteSubtitle(w http.ResponseWriter, r *http.Request) {
	v, _, ok := h.ownedVideo(w, r)
	if !ok {
		return
	}
	lang := chi.URLParam(r, "lang")
	if !langRe.MatchString(lang) {
		notFound(w, r) // no such track, whatever it was
		return
	}
	key, err := h.Store.DeleteSubtitle(r.Context(), v.ID, lang)
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return
	}
	if err != nil {
		h.fail(w, r, "delete subtitle", err)
		return
	}
	if h.Cache != nil {
		h.Cache.Invalidate(r.Context(), v.ID)
	}
	h.deleteObject(key, v, "delete the subtitle object")
	w.WriteHeader(http.StatusNoContent)
}

// deleteObject removes an object best effort: a failure is logged (video id and key, never the content)
// and never reaches the caller; an orphan is harmless, it is under v/{id}/ and goes with the video.
func (h *Handler) deleteObject(key string, v domain.Video, what string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := h.Objects.Delete(ctx, h.MediaBucket, key); err != nil {
		h.Log.Warn(what+" failed", "video_id", v.ID, "key", key, "error", err)
	}
}
