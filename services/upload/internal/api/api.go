// Package api implements upload.v1.yaml.
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
	"github.com/luantpbk/winkey/services/upload/internal/partsize"
)

// PartURLTTL is the lifetime of presigned part URLs.
const PartURLTTL = time.Hour

// Handler serves the upload API.
type Handler struct {
	Store     domain.Store
	Storage   domain.Storage
	RawBucket string
	Log       *slog.Logger
	Now       func() time.Time // defaults to time.Now
}

// Routes mounts the API on r under /v1/uploads.
func (h *Handler) Routes(r chi.Router) {
	r.Route("/v1/uploads", func(r chi.Router) {
		r.Use(httpx.Authenticate)
		r.With(httpx.RequireRole(httpx.RoleCreator)).Post("/", h.create)
		r.Route("/{video_id}", func(r chi.Router) {
			r.Get("/", h.get)
			r.Delete("/", h.abort)
			r.Post("/parts", h.presign)
			r.Post("/complete", h.complete)
		})
	})
}

var allowedContentTypes = map[string]bool{
	"video/mp4": true, "video/quicktime": true, "video/webm": true, "video/x-matroska": true,
}

var allowedVisibility = map[string]bool{"PUBLIC": true, "UNLISTED": true, "PRIVATE": true}

type createRequest struct {
	Title       string  `json:"title"`
	Description *string `json:"description"`
	Visibility  *string `json:"visibility"`
	Filename    string  `json:"filename"`
	ContentType string  `json:"content_type"`
	SizeBytes   int64   `json:"size_bytes"`
}

type createResponse struct {
	VideoID   string `json:"video_id"`
	PartSize  int64  `json:"part_size"`
	PartCount int    `json:"part_count"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	var fe []httpx.FieldError
	bad := func(field, msg string) { fe = append(fe, httpx.FieldError{Field: field, Message: msg}) }

	if n := utf8.RuneCountInString(req.Title); n < 1 || n > 100 {
		bad("title", "must be 1-100 characters")
	}
	desc := ""
	if req.Description != nil {
		desc = *req.Description
	}
	if utf8.RuneCountInString(desc) > 5000 {
		bad("description", "must be at most 5000 characters")
	}
	vis := "PUBLIC"
	if req.Visibility != nil {
		vis = *req.Visibility
	}
	if !allowedVisibility[vis] {
		bad("visibility", "must be PUBLIC, UNLISTED or PRIVATE")
	}
	if n := utf8.RuneCountInString(req.Filename); n < 1 || n > 255 {
		bad("filename", "must be 1-255 characters")
	}
	if !allowedContentTypes[req.ContentType] {
		bad("content_type", "must be one of video/mp4, video/quicktime, video/webm, video/x-matroska")
	}
	switch {
	case req.SizeBytes < 1:
		bad("size_bytes", "must be at least 1")
	case req.SizeBytes > partsize.MaxSize:
		bad("size_bytes", "must be at most 20 GiB")
	}
	if len(fe) > 0 {
		code := "VALIDATION_ERROR"
		if req.SizeBytes > partsize.MaxSize && len(fe) == 1 && fe[0].Field == "size_bytes" {
			code = "UPLOAD_TOO_LARGE"
		}
		httpx.BadRequest(w, r, code, "request validation failed", fe...)
		return
	}

	id, _ := httpx.IdentityFrom(r.Context())
	videoID := ids.New()
	size, count := partsize.Compute(req.SizeBytes)
	rawKey := id.UserID.String() + "/" + videoID.String() + "/source"

	uploadID, err := h.Storage.CreateMultipart(r.Context(), h.RawBucket, rawKey, req.ContentType)
	if err != nil {
		h.fail(w, r, "create multipart upload", err)
		return
	}
	err = h.Store.Insert(r.Context(), domain.NewVideo{
		Video: domain.Video{
			ID: videoID, OwnerID: id.UserID, Status: domain.StatusUploading,
			RawBucket: h.RawBucket, RawKey: rawKey, S3UploadID: uploadID,
			ContentType: req.ContentType, SizeBytes: req.SizeBytes,
		},
		Title: req.Title, Description: desc, Visibility: vis,
	})
	if err != nil {
		// Do not leave an orphaned multipart upload behind.
		if aerr := h.Storage.AbortMultipart(context.WithoutCancel(r.Context()), h.RawBucket, rawKey, uploadID); aerr != nil {
			h.Log.WarnContext(r.Context(), "abort after failed insert", "video_id", videoID, "error", aerr)
		}
		h.fail(w, r, "insert video", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, createResponse{
		VideoID: videoID.String(), PartSize: size, PartCount: count,
	})
}

type statusResponse struct {
	VideoID  string  `json:"video_id"`
	Status   string  `json:"status"`
	Progress float64 `json:"progress"`
	Error    *string `json:"error"`
}

func (h *Handler) status(ctx context.Context, v domain.Video) (statusResponse, error) {
	res := statusResponse{VideoID: v.ID.String(), Status: v.Status}
	switch v.Status {
	case domain.StatusReady:
		res.Progress = 100
	case domain.StatusProcessing, domain.StatusFailed:
		p, err := h.Store.Progress(ctx, v.ID)
		if err != nil {
			return res, err
		}
		res.Progress = p
	}
	if v.Error != "" {
		e := v.Error
		res.Error = &e
	}
	return res, nil
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	v, ok := h.owned(w, r)
	if !ok {
		return
	}
	res, err := h.status(r.Context(), v)
	if err != nil {
		h.fail(w, r, "load progress", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

func (h *Handler) abort(w http.ResponseWriter, r *http.Request) {
	v, ok := h.owned(w, r)
	if !ok {
		return
	}
	if v.Status != domain.StatusUploading {
		httpx.Conflict(w, r, "INVALID_STATE", "only uploads in status UPLOADING can be aborted")
		return
	}
	if v.S3UploadID != "" {
		err := h.Storage.AbortMultipart(r.Context(), v.RawBucket, v.RawKey, v.S3UploadID)
		if err != nil && !errors.Is(err, domain.ErrNoSuchUpload) {
			h.fail(w, r, "abort multipart upload", err)
			return
		}
	}
	deleted, err := h.Store.DeleteUploading(r.Context(), v.ID)
	if err != nil {
		h.fail(w, r, "delete video", err)
		return
	}
	if !deleted {
		httpx.Conflict(w, r, "INVALID_STATE", "upload is no longer in status UPLOADING")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type presignRequest struct {
	PartNumbers []int `json:"part_numbers"`
}

type presignedPart struct {
	PartNumber int    `json:"part_number"`
	URL        string `json:"url"`
}

type presignResponse struct {
	URLs      []presignedPart `json:"urls"`
	ExpiresAt time.Time       `json:"expires_at"`
}

func (h *Handler) presign(w http.ResponseWriter, r *http.Request) {
	v, ok := h.owned(w, r)
	if !ok {
		return
	}
	var req presignRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	_, partCount := partsize.Compute(v.SizeBytes)
	seen := map[int]bool{}
	if n := len(req.PartNumbers); n < 1 || n > 100 {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "part_numbers must contain 1-100 items",
			httpx.FieldError{Field: "part_numbers", Message: "must contain 1-100 items"})
		return
	}
	for _, n := range req.PartNumbers {
		if n < 1 || n > partCount || seen[n] {
			httpx.BadRequest(w, r, "INVALID_PART_NUMBER",
				"part numbers must be unique and within 1..part_count",
				httpx.FieldError{Field: "part_numbers", Message: "must be unique and between 1 and part_count"})
			return
		}
		seen[n] = true
	}
	if v.Status != domain.StatusUploading || v.S3UploadID == "" {
		httpx.Conflict(w, r, "INVALID_STATE", "upload is not in status UPLOADING")
		return
	}

	res := presignResponse{URLs: make([]presignedPart, 0, len(req.PartNumbers)), ExpiresAt: h.now().Add(PartURLTTL).UTC()}
	for _, n := range req.PartNumbers {
		u, err := h.Storage.PresignPart(r.Context(), v.RawBucket, v.RawKey, v.S3UploadID, int32(n), PartURLTTL)
		if err != nil {
			h.fail(w, r, "presign part", err)
			return
		}
		res.URLs = append(res.URLs, presignedPart{PartNumber: n, URL: u})
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

type completeRequest struct {
	Parts []struct {
		PartNumber int    `json:"part_number"`
		ETag       string `json:"etag"`
	} `json:"parts"`
}

func (h *Handler) complete(w http.ResponseWriter, r *http.Request) {
	v, ok := h.owned(w, r)
	if !ok {
		return
	}
	var req completeRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	ctx := r.Context()

	switch v.Status {
	case domain.StatusUploaded, domain.StatusProcessing, domain.StatusReady:
		h.respondStatus(w, r, v) // idempotent
		return
	case domain.StatusUploading:
	default:
		httpx.Conflict(w, r, "INVALID_STATE", "upload is not in status UPLOADING")
		return
	}

	_, partCount := partsize.Compute(v.SizeBytes)
	parts, msg := validateParts(req, partCount)
	if msg != "" {
		httpx.BadRequest(w, r, "INVALID_PARTS", msg, httpx.FieldError{Field: "parts", Message: msg})
		return
	}

	err := h.Storage.CompleteMultipart(ctx, v.RawBucket, v.RawKey, v.S3UploadID, parts)
	switch {
	case err == nil:
	case errors.Is(err, domain.ErrInvalidPart):
		httpx.BadRequest(w, r, "INVALID_PARTS", "one or more parts are missing or their ETag does not match")
		return
	case errors.Is(err, domain.ErrNoSuchUpload):
		// A concurrent complete already finished the multipart upload; the
		// object check below decides whether it is usable.
	default:
		h.fail(w, r, "complete multipart upload", err)
		return
	}

	size, err := h.Storage.HeadSize(ctx, v.RawBucket, v.RawKey)
	if errors.Is(err, domain.ErrNoSuchObject) {
		httpx.Conflict(w, r, "INVALID_STATE", "upload is no longer available")
		return
	}
	if err != nil {
		h.fail(w, r, "head object", err)
		return
	}
	if size != v.SizeBytes {
		if _, err := h.Store.MarkFailed(ctx, v.ID, "The uploaded file size does not match the declared size."); err != nil {
			h.fail(w, r, "mark failed", err)
			return
		}
		if err := h.Storage.DeleteObject(context.WithoutCancel(ctx), v.RawBucket, v.RawKey); err != nil {
			h.Log.WarnContext(ctx, "delete mismatched object", "video_id", v.ID, "error", err)
		}
		httpx.BadRequest(w, r, "SIZE_MISMATCH", "uploaded object size differs from size_bytes")
		return
	}

	changed, err := h.Store.MarkUploaded(ctx, v)
	if err != nil {
		h.fail(w, r, "mark uploaded", err)
		return
	}
	if !changed { // lost a race with a concurrent request: report the current state
		cur, err := h.Store.Get(ctx, v.ID)
		if err != nil {
			h.fail(w, r, "reload video", err)
			return
		}
		v = cur
	} else {
		v.Status = domain.StatusUploaded
	}
	h.respondStatus(w, r, v)
}

// validateParts checks the list is exactly 1..partCount with no gaps or
// duplicates and returns it sorted by part number.
func validateParts(req completeRequest, partCount int) ([]domain.Part, string) {
	if len(req.Parts) != partCount {
		return nil, "parts must list every part from 1 to part_count exactly once"
	}
	parts := make([]domain.Part, 0, len(req.Parts))
	for _, p := range req.Parts {
		if p.PartNumber < 1 || p.PartNumber > partCount {
			return nil, "part_number out of range"
		}
		if strings.TrimSpace(p.ETag) == "" {
			return nil, "etag must not be empty"
		}
		parts = append(parts, domain.Part{Number: int32(p.PartNumber), ETag: p.ETag})
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].Number < parts[j].Number })
	for i, p := range parts {
		if int(p.Number) != i+1 {
			return nil, "parts must list every part from 1 to part_count exactly once"
		}
	}
	return parts, ""
}

func (h *Handler) respondStatus(w http.ResponseWriter, r *http.Request, v domain.Video) {
	res, err := h.status(r.Context(), v)
	if err != nil {
		h.fail(w, r, "load progress", err)
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, res)
}

// owned loads the video from the path and enforces ownership. Unknown IDs,
// malformed IDs and other users' videos all yield the same 404.
func (h *Handler) owned(w http.ResponseWriter, r *http.Request) (domain.Video, bool) {
	id, ok := httpx.IdentityFrom(r.Context())
	if !ok {
		httpx.Unauthorized(w, r)
		return domain.Video{}, false
	}
	vid, err := uuid.Parse(chi.URLParam(r, "video_id"))
	if err != nil {
		httpx.NotFound(w, r)
		return domain.Video{}, false
	}
	v, err := h.Store.Get(r.Context(), vid)
	if errors.Is(err, domain.ErrNotFound) || (err == nil && v.OwnerID != id.UserID) {
		httpx.NotFound(w, r)
		return domain.Video{}, false
	}
	if err != nil {
		h.fail(w, r, "load video", err)
		return domain.Video{}, false
	}
	return v, true
}

func (h *Handler) fail(w http.ResponseWriter, r *http.Request, what string, err error) {
	h.Log.ErrorContext(r.Context(), what+" failed", "error", err)
	httpx.Internal(w, r)
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}
