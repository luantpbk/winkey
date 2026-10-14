package api

import (
	"context"
	"errors"
	"net/http"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Extra audio tracks (task MUX1, ADR-042). upload-svc creates them and the transcoder makes them READY;
// here the owner lists, renames, re-defaults and deletes them, and playback lists the READY ones.

// audioTrackJSON is AudioTrack of video.v1.yaml.
type audioTrackJSON struct {
	ID        string    `json:"id"`
	Lang      string    `json:"lang"`
	Label     string    `json:"label"`
	Kind      string    `json:"kind"`
	IsDefault bool      `json:"is_default"`
	Status    string    `json:"status"`
	Error     *string   `json:"error"`
	UpdatedAt time.Time `json:"updated_at"`
}

// playbackAudioJSON is PlaybackAudioTrack.
type playbackAudioJSON struct {
	ID        string `json:"id"`
	Lang      string `json:"lang"`
	Label     string `json:"label"`
	Kind      string `json:"kind"`
	IsDefault bool   `json:"is_default"`
}

func toAudioJSON(t domain.AudioTrack) audioTrackJSON {
	out := audioTrackJSON{
		ID: t.ID.String(), Lang: t.Lang, Label: t.Label, Kind: t.Kind, IsDefault: t.IsDefault,
		Status: t.Status, UpdatedAt: t.UpdatedAt.UTC(),
	}
	if t.Error != "" {
		e := t.Error
		out.Error = &e
	}
	return out
}

func hlsTracks(ts []domain.AudioTrack) []hlsmaster.Track {
	out := make([]hlsmaster.Track, 0, len(ts))
	for _, t := range ts {
		out = append(out, hlsmaster.Track{
			ID: t.ID.String(), Lang: t.Lang, Label: t.Label, Kind: t.Kind, Default: t.IsDefault, PlaylistKey: t.PlaylistKey,
		})
	}
	return out
}

// playbackAudio is the audio group of the master in the same order (hlsmaster.Group): empty without READY
// tracks, else the muxed original (id = the video id, lang "und") unless an extra track of kind original
// replaces it, then the tracks. Never nil.
func playbackAudio(v domain.Video) []playbackAudioJSON {
	group := hlsmaster.Group(hlsmaster.OriginalLabel, hlsTracks(v.AudioTracks))
	out := make([]playbackAudioJSON, 0, len(group))
	for _, r := range group {
		id := r.ID
		if r.Original {
			id = v.ID.String()
		}
		out = append(out, playbackAudioJSON{ID: id, Lang: r.Lang, Label: r.Label, Kind: r.Kind, IsDefault: r.Default})
	}
	return out
}

// rewriteMaster is the domain.MasterRewrite of video-svc: it reads the current master, replaces its audio
// group and stores the result under a new key next to it (masters are cached as immutable).
func (h *Handler) rewriteMaster(ctx context.Context, _ uuid.UUID, masterKey string, ready []domain.AudioTrack) (string, error) {
	data, err := h.Objects.Read(ctx, h.MediaBucket, masterKey, hlsmaster.MaxSize)
	if err != nil {
		return "", err
	}
	newKey := hlsmaster.NewKey(masterKey, ids.NewString())
	out, err := hlsmaster.With(data, masterKey, newKey, hlsmaster.OriginalLabel, hlsTracks(ready))
	if err != nil {
		return "", err
	}
	if err := h.Objects.Put(ctx, h.MediaBucket, newKey, out, hlsmaster.ContentType, cacheImmutable); err != nil {
		return "", err
	}
	return newKey, nil
}

func trackID(r *http.Request) (uuid.UUID, bool) {
	raw := chi.URLParam(r, "track_id")
	id, err := uuid.Parse(raw)
	return id, err == nil && len(raw) == 36
}

// ---- GET /v1/videos/{video_id}/audio-tracks -----------------------------------

func (h *Handler) listAudioTracks(w http.ResponseWriter, r *http.Request) {
	v, _, ok := h.ownedVideo(w, r)
	if !ok {
		return
	}
	ts, err := h.Store.ListAudioTracks(r.Context(), v.ID)
	if err != nil {
		h.fail(w, r, "list audio tracks", err)
		return
	}
	items := make([]audioTrackJSON, 0, len(ts))
	for _, t := range ts {
		items = append(items, toAudioJSON(t))
	}
	w.Header().Set("Cache-Control", cachePrivate)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

// ---- PATCH /v1/videos/{video_id}/audio-tracks/{track_id} ----------------------

type updateAudioRequest struct {
	Label     *string `json:"label"`
	IsDefault *bool   `json:"is_default"`
}

func (h *Handler) updateAudioTrack(w http.ResponseWriter, r *http.Request) {
	v, _, ok := h.ownedVideo(w, r)
	if !ok {
		return
	}
	tid, ok := trackID(r)
	if !ok {
		notFound(w, r)
		return
	}
	var req updateAudioRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	var fe []httpx.FieldError
	var u domain.AudioTrackUpdate
	if req.Label == nil && req.IsDefault == nil {
		fe = append(fe, httpx.FieldError{Field: "label", Message: "label or is_default is required"})
	}
	if req.Label != nil {
		label := strings.TrimSpace(*req.Label)
		if label == "" || utf8.RuneCountInString(label) > maxLabelRunes || !utf8.ValidString(label) {
			fe = append(fe, httpx.FieldError{Field: "label", Message: "must be 1-50 characters"})
		}
		u.Label = &label
	}
	if req.IsDefault != nil {
		if !*req.IsDefault {
			fe = append(fe, httpx.FieldError{Field: "is_default", Message: "only true; set it on another track to move the default"})
		}
		u.MakeDefault = *req.IsDefault
	}
	if len(fe) > 0 {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "request validation failed", fe...)
		return
	}
	t, err := h.Store.UpdateAudioTrack(r.Context(), v.ID, tid, u, h.rewriteMaster)
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return
	}
	if err != nil {
		h.fail(w, r, "update audio track", err)
		return
	}
	if h.Cache != nil {
		h.Cache.Invalidate(r.Context(), v.ID)
	}
	w.Header().Set("Cache-Control", cachePrivate)
	httpx.WriteJSON(w, http.StatusOK, toAudioJSON(t))
}

// ---- DELETE /v1/videos/{video_id}/audio-tracks/{track_id} ---------------------

func (h *Handler) deleteAudioTrack(w http.ResponseWriter, r *http.Request) {
	v, _, ok := h.ownedVideo(w, r)
	if !ok {
		return
	}
	tid, ok := trackID(r)
	if !ok {
		notFound(w, r)
		return
	}
	t, err := h.Store.DeleteAudioTrack(r.Context(), v.ID, tid, h.rewriteMaster)
	switch {
	case errors.Is(err, domain.ErrNotFound):
		notFound(w, r)
		return
	case errors.Is(err, domain.ErrAudioTrackUploading):
		httpx.Conflict(w, r, "INVALID_STATE", "the track is still uploading; abort it through upload-svc")
		return
	case err != nil:
		h.fail(w, r, "delete audio track", err)
		return
	}
	if h.Cache != nil {
		h.Cache.Invalidate(r.Context(), v.ID)
	}
	// After the commit: the track's own objects are garbage now. Best effort; an orphan is under v/{id}/
	// and goes with the video.
	if prefix := trackPrefix(v.ID, t.PlaylistKey); prefix != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := h.Objects.RemovePrefix(ctx, h.MediaBucket, prefix); err != nil {
			h.Log.Warn("delete audio track objects failed", "video_id", v.ID, "prefix", prefix, "error", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// trackPrefix is the directory of a track's playlist and segments, or "" when it has none or the key is not
// under the video's own prefix (never delete anything else).
func trackPrefix(videoID uuid.UUID, playlistKey string) string {
	if playlistKey == "" || strings.Contains(playlistKey, "..") {
		return ""
	}
	dir := path.Dir(playlistKey) + "/"
	if !strings.HasPrefix(dir, "v/"+videoID.String()+"/") || strings.Count(dir, "/") < 4 {
		return ""
	}
	return dir
}
