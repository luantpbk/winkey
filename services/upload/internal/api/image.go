package api

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
	"github.com/luantpbk/winkey/services/upload/internal/quota"
)

// Social images (task SOC-1b, ADR-049 §4) under /v1/images: one presigned PUT, then the transcoder converts the
// file to WebP. Mounted by Routes when Handler.Images is set.

// ImageURLTTL is the lifetime of the presigned PUT.
const ImageURLTTL = 15 * time.Minute

// ImageLimits are the image quotas; a field of 0 switches that limit off (tests).
type ImageLimits struct {
	MaxPending int // images in UPLOADING or PROCESSING
	DailyCount int // images started in the last 24 hours
}

// Images groups what the image routes need.
type Images struct {
	Store        domain.ImageStore
	Storage      domain.ImageStorage
	MediaBaseURL string // public base of the media bucket, e.g. https://winkey.vn/media
	Limits       ImageLimits
}

var allowedImagePurposes = map[string]bool{"AVATAR": true, "BANNER": true, "POST": true}

var allowedImageContentTypes = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/webp": true, "image/avif": true,
}

func (h *Handler) imageRoutes(r chi.Router) {
	r.Route("/v1/images", func(r chi.Router) {
		r.Use(httpx.Authenticate)
		r.Post("/", h.createImage)
		r.Get("/{image_id}", h.getImage)
		r.Post("/{image_id}/complete", h.completeImage)
	})
}

type createImageRequest struct {
	Purpose     string `json:"purpose"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
}

type createImageResponse struct {
	ImageID       string            `json:"image_id"`
	UploadURL     string            `json:"upload_url"`
	UploadHeaders map[string]string `json:"upload_headers"`
	ExpiresAt     time.Time         `json:"expires_at"`
}

// imageResponse is Image of upload.v1.yaml.
type imageResponse struct {
	ID        string    `json:"id"`
	Purpose   string    `json:"purpose"`
	Status    string    `json:"status"`
	URL       *string   `json:"url"`
	ThumbURL  *string   `json:"thumb_url"`
	Width     *int      `json:"width"`
	Height    *int      `json:"height"`
	Error     *string   `json:"error"`
	CreatedAt time.Time `json:"created_at"`
}

func (h *Handler) toImageResponse(i domain.Image) imageResponse {
	res := imageResponse{ID: i.ID.String(), Purpose: i.Purpose, Status: i.Status, CreatedAt: i.CreatedAt.UTC()}
	if i.Status == domain.ImageReady {
		base := strings.TrimRight(h.Images.MediaBaseURL, "/")
		u, t := base+"/"+i.ImageKey, base+"/"+i.ThumbKey
		w, hh := i.Width, i.Height
		res.URL, res.ThumbURL, res.Width, res.Height = &u, &t, &w, &hh
	}
	if i.Status == domain.ImageFailed && i.Error != "" {
		e := i.Error
		res.Error = &e
	}
	return res
}

func (h *Handler) createImage(w http.ResponseWriter, r *http.Request) {
	var req createImageRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}
	var fe []httpx.FieldError
	bad := func(field, msg string) { fe = append(fe, httpx.FieldError{Field: field, Message: msg}) }
	if !allowedImagePurposes[req.Purpose] {
		bad("purpose", "must be AVATAR, BANNER or POST")
	}
	if !allowedImageContentTypes[req.ContentType] {
		bad("content_type", "must be image/jpeg, image/png, image/webp or image/avif")
	}
	switch {
	case req.SizeBytes < 1:
		bad("size_bytes", "must be at least 1")
	case req.SizeBytes > domain.MaxImageSizeBytes:
		bad("size_bytes", "must be at most 20 MiB")
	}
	if len(fe) > 0 {
		code := "VALIDATION_ERROR"
		if req.SizeBytes > domain.MaxImageSizeBytes && len(fe) == 1 {
			code = "UPLOAD_TOO_LARGE"
		}
		httpx.BadRequest(w, r, code, "request validation failed", fe...)
		return
	}

	id, _ := httpx.IdentityFrom(r.Context())
	imageID := ids.New()
	img := domain.Image{
		ID: imageID, OwnerID: id.UserID, Purpose: req.Purpose, Status: domain.ImageUploading,
		ContentType: req.ContentType, SizeBytes: req.SizeBytes,
		RawBucket: h.RawBucket, RawKey: id.UserID.String() + "/images/" + imageID.String(),
	}
	var check func(domain.ImageUsage) error
	if !slices.Contains(id.Roles, httpx.RoleAdmin) {
		check = func(u domain.ImageUsage) error {
			if ex := decideImage(h.Images.Limits, u); ex != nil {
				return ex
			}
			return nil
		}
	}
	// Presign first: it is local (no network), and a failure must not leave a row behind.
	url, err := h.Images.Storage.PresignPut(r.Context(), img.RawBucket, img.RawKey, img.ContentType, img.SizeBytes, ImageURLTTL)
	if err != nil {
		h.fail(w, r, "presign image put", err)
		return
	}
	if err := h.Images.Store.CreateImage(r.Context(), img, check); err != nil {
		var ex *quota.Exceeded
		if errors.As(err, &ex) {
			h.refuse(w, r, id.UserID, ex)
			return
		}
		h.fail(w, r, "insert image", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, createImageResponse{
		ImageID: imageID.String(), UploadURL: url,
		UploadHeaders: map[string]string{"Content-Type": img.ContentType},
		ExpiresAt:     h.now().UTC().Add(ImageURLTTL).Truncate(time.Second),
	})
}

// decideImage applies the image quotas with the same Exceeded type (and 429 body) as video uploads.
func decideImage(l ImageLimits, u domain.ImageUsage) *quota.Exceeded {
	return quota.Decide(quota.Limits{MaxConcurrent: l.MaxPending, DailyCount: l.DailyCount},
		domain.Usage{Uploading: u.Pending, Count: u.Count, Oldest: u.Oldest, Now: u.Now}, 0)
}

// ownedImage loads the image and answers 404 unless the caller owns it.
func (h *Handler) ownedImage(w http.ResponseWriter, r *http.Request) (domain.Image, bool) {
	imageID, err := uuid.Parse(chi.URLParam(r, "image_id"))
	if err != nil {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "image_id must be a UUID")
		return domain.Image{}, false
	}
	img, err := h.Images.Store.GetImage(r.Context(), imageID)
	id, _ := httpx.IdentityFrom(r.Context())
	if errors.Is(err, domain.ErrNotFound) || (err == nil && img.OwnerID != id.UserID) {
		httpx.NotFound(w, r)
		return domain.Image{}, false
	}
	if err != nil {
		h.fail(w, r, "get image", err)
		return domain.Image{}, false
	}
	return img, true
}

func (h *Handler) getImage(w http.ResponseWriter, r *http.Request) {
	img, ok := h.ownedImage(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.WriteJSON(w, http.StatusOK, h.toImageResponse(img))
}

func (h *Handler) completeImage(w http.ResponseWriter, r *http.Request) {
	img, ok := h.ownedImage(w, r)
	if !ok {
		return
	}
	if img.Status != domain.ImageUploading { // idempotent: already completed
		httpx.WriteJSON(w, http.StatusAccepted, h.toImageResponse(img))
		return
	}
	size, err := h.Images.Storage.HeadSize(r.Context(), img.RawBucket, img.RawKey)
	switch {
	case errors.Is(err, domain.ErrNoSuchObject):
		httpx.WriteProblem(w, r, httpx.NewProblem(http.StatusConflict, "UPLOAD_INCOMPLETE", "the image has not been uploaded"))
		return
	case err != nil:
		h.fail(w, r, "head image", err)
		return
	case size != img.SizeBytes:
		httpx.WriteProblem(w, r, httpx.NewProblem(http.StatusConflict, "UPLOAD_INCOMPLETE", "the uploaded size differs from size_bytes"))
		return
	}
	changed, err := h.Images.Store.MarkImageUploaded(r.Context(), img)
	if err != nil {
		h.fail(w, r, "mark image uploaded", err)
		return
	}
	if changed {
		img.Status = domain.ImageProcessing
	} else if img, err = h.Images.Store.GetImage(r.Context(), img.ID); err != nil { // lost a race: report the winner
		h.fail(w, r, "get image", err)
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, h.toImageResponse(img))
}
