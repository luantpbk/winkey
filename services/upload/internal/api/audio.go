package api

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
	"github.com/luantpbk/winkey/services/upload/internal/partsize"
	"github.com/luantpbk/winkey/services/upload/internal/quota"
)

// Extra audio tracks of a video (task MUX1, ADR-042): the same multipart flow as a video upload,
// under /v1/uploads/{video_id}/audio-tracks. Mounted by Routes when Handler.Audio is set.

var langTag = regexp.MustCompile(`^[a-z]{2,3}(-[A-Z]{2})?$`)

var allowedAudioKinds = map[string]bool{"original": true, "dub": true, "voiceover": true, "commentary": true}

var allowedAudioContentTypes = map[string]bool{
	"audio/wav": true, "audio/x-wav": true, "audio/flac": true, "audio/mp4": true,
	"audio/x-m4a": true, "audio/aac": true, "audio/ogg": true, "audio/webm": true,
}

func (h *Handler) audioRoutes(r chi.Router) {
	r.Route("/audio-tracks", func(r chi.Router) {
		r.Post("/", h.createAudio)
		r.Route("/{track_id}", func(r chi.Router) {
			r.Delete("/", h.abortAudio)
			r.Post("/parts", h.presignAudio)
			r.Post("/complete", h.completeAudio)
		})
	})
}

type createAudioRequest struct {
	Lang        string `json:"lang"`
	Label       string `json:"label"`
	Kind        string `json:"kind"`
	IsDefault   *bool  `json:"is_default"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
}

type createAudioResponse struct {
	TrackID   string `json:"track_id"`
	PartSize  int64  `json:"part_size"`
	PartCount int    `json:"part_count"`
}

// audioTrackResponse is AudioTrack of video.v1.yaml.
type audioTrackResponse struct {
	ID        string    `json:"id"`
	Lang      string    `json:"lang"`
	Label     string    `json:"label"`
	Kind      string    `json:"kind"`
	IsDefault bool      `json:"is_default"`
	Status    string    `json:"status"`
	Error     *string   `json:"error"`
	UpdatedAt time.Time `json:"updated_at"`
}

func toAudioResponse(t domain.AudioTrack) audioTrackResponse {
	res := audioTrackResponse{
		ID: t.ID.String(), Lang: t.Lang, Label: t.Label, Kind: t.Kind, IsDefault: t.IsDefault,
		Status: t.Status, UpdatedAt: t.UpdatedAt.UTC(),
	}
	if t.Error != "" {
		e := t.Error
		res.Error = &e
	}
	return res
}

func (h *Handler) createAudio(w http.ResponseWriter, r *http.Request) {
	v, ok := h.owned(w, r)
	if !ok {
		return
	}
	var req createAudioRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	var fe []httpx.FieldError
	bad := func(field, msg string) { fe = append(fe, httpx.FieldError{Field: field, Message: msg}) }
	if !langTag.MatchString(req.Lang) {
		bad("lang", "must be a language tag such as vi, en or zh-TW")
	}
	if n := utf8.RuneCountInString(req.Label); n < 1 || n > 50 {
		bad("label", "must be 1-50 characters")
	}
	if !allowedAudioKinds[req.Kind] {
		bad("kind", "must be original, dub, voiceover or commentary")
	}
	if n := utf8.RuneCountInString(req.Filename); n < 1 || n > 255 {
		bad("filename", "must be 1-255 characters")
	}
	if !allowedAudioContentTypes[req.ContentType] {
		bad("content_type", "must be an audio type such as audio/wav, audio/flac or audio/mp4")
	}
	switch {
	case req.SizeBytes < 1:
		bad("size_bytes", "must be at least 1")
	case req.SizeBytes > domain.MaxAudioSizeBytes:
		bad("size_bytes", "must be at most 4 GiB")
	}
	if len(fe) > 0 {
		code := "VALIDATION_ERROR"
		if req.SizeBytes > domain.MaxAudioSizeBytes && len(fe) == 1 {
			code = "UPLOAD_TOO_LARGE"
		}
		httpx.BadRequest(w, r, code, "request validation failed", fe...)
		return
	}

	id, _ := httpx.IdentityFrom(r.Context())
	trackID := ids.New()
	size, count := partsize.Compute(req.SizeBytes)
	rawKey := v.OwnerID.String() + "/" + v.ID.String() + "/audio/" + trackID.String() + "/source"
	t := domain.AudioTrack{
		ID: trackID, VideoID: v.ID, OwnerID: v.OwnerID,
		Lang: req.Lang, Label: req.Label, Kind: req.Kind, IsDefault: req.IsDefault != nil && *req.IsDefault,
		Status: domain.StatusUploading, RawBucket: h.RawBucket, RawKey: rawKey,
		ContentType: req.ContentType, SizeBytes: req.SizeBytes,
	}
	var check func(domain.Usage) error
	if !slices.Contains(id.Roles, httpx.RoleAdmin) {
		check = func(u domain.Usage) error {
			if ex := quota.Decide(h.Quota, u, req.SizeBytes); ex != nil {
				return ex
			}
			return nil
		}
	}
	var uploadID string
	var s3Err error
	err := h.Audio.CreateAudioTrack(r.Context(), t, check, func(ctx context.Context) (string, error) {
		var err error
		uploadID, err = h.Storage.CreateMultipart(ctx, h.RawBucket, rawKey, req.ContentType)
		s3Err = err
		return uploadID, err
	})
	if err != nil {
		var ex *quota.Exceeded
		switch {
		case errors.As(err, &ex):
			h.refuse(w, r, v.OwnerID, ex)
			return
		case errors.Is(err, domain.ErrAudioTrackExists):
			httpx.Conflict(w, r, "AUDIO_TRACK_EXISTS", "this video already has an audio track with this lang and kind")
			return
		case errors.Is(err, domain.ErrTooManyAudioTracks):
			httpx.Conflict(w, r, "TOO_MANY_AUDIO_TRACKS", "a video has at most 8 audio tracks")
			return
		case errors.Is(err, domain.ErrNotFound):
			httpx.NotFound(w, r)
			return
		case s3Err != nil:
			h.fail(w, r, "create multipart upload", err)
			return
		}
		if uploadID != "" {
			if aerr := h.Storage.AbortMultipart(context.WithoutCancel(r.Context()), h.RawBucket, rawKey, uploadID); aerr != nil {
				h.Log.WarnContext(r.Context(), "abort after failed insert", "track_id", trackID, "error", aerr)
			}
		}
		h.fail(w, r, "insert audio track", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, createAudioResponse{TrackID: trackID.String(), PartSize: size, PartCount: count})
}

func (h *Handler) abortAudio(w http.ResponseWriter, r *http.Request) {
	t, ok := h.ownedTrack(w, r)
	if !ok {
		return
	}
	if t.Status != domain.StatusUploading {
		httpx.Conflict(w, r, "INVALID_STATE", "only audio tracks in status UPLOADING can be aborted")
		return
	}
	if t.S3UploadID != "" {
		err := h.Storage.AbortMultipart(r.Context(), t.RawBucket, t.RawKey, t.S3UploadID)
		if err != nil && !errors.Is(err, domain.ErrNoSuchUpload) {
			h.fail(w, r, "abort multipart upload", err)
			return
		}
	}
	deleted, err := h.Audio.DeleteUploadingAudio(r.Context(), t.ID)
	if err != nil {
		h.fail(w, r, "delete audio track", err)
		return
	}
	if !deleted {
		httpx.Conflict(w, r, "INVALID_STATE", "audio track is no longer in status UPLOADING")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) presignAudio(w http.ResponseWriter, r *http.Request) {
	t, ok := h.ownedTrack(w, r)
	if !ok {
		return
	}
	var req presignRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	_, partCount := partsize.Compute(t.SizeBytes)
	if !validPartNumbers(w, r, req.PartNumbers, partCount) {
		return
	}
	if t.Status != domain.StatusUploading || t.S3UploadID == "" {
		httpx.Conflict(w, r, "INVALID_STATE", "audio track is not in status UPLOADING")
		return
	}
	h.writePresigned(w, r, t.RawBucket, t.RawKey, t.S3UploadID, req.PartNumbers)
}

func (h *Handler) completeAudio(w http.ResponseWriter, r *http.Request) {
	t, ok := h.ownedTrack(w, r)
	if !ok {
		return
	}
	var req completeRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	ctx := r.Context()
	switch t.Status {
	case domain.StatusUploaded, domain.StatusProcessing, domain.StatusReady:
		httpx.WriteJSON(w, http.StatusAccepted, toAudioResponse(t)) // idempotent
		return
	case domain.StatusUploading:
	default:
		httpx.Conflict(w, r, "INVALID_STATE", "audio track is not in status UPLOADING")
		return
	}

	_, partCount := partsize.Compute(t.SizeBytes)
	parts, msg := validateParts(req, partCount)
	if msg != "" {
		httpx.BadRequest(w, r, "INVALID_PARTS", msg, httpx.FieldError{Field: "parts", Message: msg})
		return
	}
	err := h.Storage.CompleteMultipart(ctx, t.RawBucket, t.RawKey, t.S3UploadID, parts)
	switch {
	case err == nil, errors.Is(err, domain.ErrNoSuchUpload):
	case errors.Is(err, domain.ErrInvalidPart):
		httpx.BadRequest(w, r, "INVALID_PARTS", "one or more parts are missing or their ETag does not match")
		return
	default:
		h.fail(w, r, "complete multipart upload", err)
		return
	}
	size, err := h.Storage.HeadSize(ctx, t.RawBucket, t.RawKey)
	if errors.Is(err, domain.ErrNoSuchObject) {
		httpx.Conflict(w, r, "INVALID_STATE", "upload is no longer available")
		return
	}
	if err != nil {
		h.fail(w, r, "head object", err)
		return
	}
	if size != t.SizeBytes {
		if _, err := h.Audio.MarkAudioFailed(ctx, t.ID, "SIZE_MISMATCH"); err != nil {
			h.fail(w, r, "mark audio failed", err)
			return
		}
		if err := h.Storage.DeleteObject(context.WithoutCancel(ctx), t.RawBucket, t.RawKey); err != nil {
			h.Log.WarnContext(ctx, "delete mismatched object", "track_id", t.ID, "error", err)
		}
		httpx.BadRequest(w, r, "SIZE_MISMATCH", "uploaded object size differs from size_bytes")
		return
	}
	if _, err := h.Audio.MarkAudioUploaded(ctx, t); err != nil {
		h.fail(w, r, "mark audio uploaded", err)
		return
	}
	// Changed or lost a race with a concurrent request: either way report the current state.
	cur, err := h.Audio.GetAudioTrack(ctx, t.VideoID, t.ID)
	if err != nil {
		h.fail(w, r, "reload audio track", err)
		return
	}
	if cur.Status == domain.StatusFailed {
		httpx.Conflict(w, r, "INVALID_STATE", "audio track is not in status UPLOADING")
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, toAudioResponse(cur))
}

// ownedTrack loads the track from the path and enforces ownership of its video. Unknown IDs,
// malformed IDs, a track of another video and other users' videos all yield the same 404.
func (h *Handler) ownedTrack(w http.ResponseWriter, r *http.Request) (domain.AudioTrack, bool) {
	id, ok := httpx.IdentityFrom(r.Context())
	if !ok {
		httpx.Unauthorized(w, r)
		return domain.AudioTrack{}, false
	}
	vid, err1 := uuid.Parse(chi.URLParam(r, "video_id"))
	tid, err2 := uuid.Parse(chi.URLParam(r, "track_id"))
	if err1 != nil || err2 != nil {
		httpx.NotFound(w, r)
		return domain.AudioTrack{}, false
	}
	t, err := h.Audio.GetAudioTrack(r.Context(), vid, tid)
	if errors.Is(err, domain.ErrNotFound) || (err == nil && t.OwnerID != id.UserID) {
		httpx.NotFound(w, r)
		return domain.AudioTrack{}, false
	}
	if err != nil {
		h.fail(w, r, "load audio track", err)
		return domain.AudioTrack{}, false
	}
	return t, true
}
