package domain

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Social images (task SOC-1b, ADR-049 §4): avatars, banners and post images, uploaded with one presigned PUT
// and converted to WebP by the transcoder.

// Image limits.
const MaxImageSizeBytes = 20 << 20 // 20 MiB, = the media.images CHECK

// Image statuses (media.image_status).
const (
	ImageUploading  = "UPLOADING"
	ImageProcessing = "PROCESSING"
	ImageReady      = "READY"
	ImageFailed     = "FAILED"
)

// ErrImageState: the image is not in a state that allows the operation.
var ErrImageState = errors.New("image is not uploading")

// Image is one row of media.images.
type Image struct {
	ID          uuid.UUID
	OwnerID     uuid.UUID
	Purpose     string // AVATAR | BANNER | POST
	Status      string
	ContentType string
	SizeBytes   int64
	RawBucket   string
	RawKey      string
	ImageKey    string // empty until READY
	ThumbKey    string
	Width       int
	Height      int
	Error       string
	CreatedAt   time.Time
}

// ImageUsage is the caller's recent image activity, for the image quotas.
type ImageUsage struct {
	Pending int       // images in UPLOADING or PROCESSING
	Count   int       // images created in the last 24 hours
	Oldest  time.Time // min(created_at) of those; zero when none
	Now     time.Time // database clock
}

// ImageUploadedEvent is the `data` of media.image_uploaded.
type ImageUploadedEvent struct {
	ImageID     string `json:"image_id"`
	OwnerID     string `json:"owner_id"`
	Purpose     string `json:"purpose"`
	RawBucket   string `json:"raw_bucket"`
	RawKey      string `json:"raw_key"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
}

// ImageStore is the persistence port of media.images.
type ImageStore interface {
	// CreateImage inserts the UPLOADING row in one transaction under the owner's quota lock; when check is
	// not nil it is called with the owner's usage first and a non-nil error is returned as is (nothing written).
	CreateImage(ctx context.Context, img Image, check func(ImageUsage) error) error
	// GetImage returns the image regardless of owner (ErrNotFound when unknown); callers enforce ownership.
	GetImage(ctx context.Context, id uuid.UUID) (Image, error)
	// MarkImageUploaded flips UPLOADING→PROCESSING and enqueues media.image_uploaded in the same transaction.
	// changed is false when the image was no longer UPLOADING.
	MarkImageUploaded(ctx context.Context, img Image) (changed bool, err error)
	// StaleImageUploads lists UPLOADING images created more than olderThan ago.
	StaleImageUploads(ctx context.Context, olderThan time.Duration, limit int) ([]Image, error)
	// DeleteUploadingImage deletes the row only if it is still UPLOADING.
	DeleteUploadingImage(ctx context.Context, id uuid.UUID) (deleted bool, err error)
}

// ImageStorage is the object-storage port of image uploads.
type ImageStorage interface {
	// PresignPut signs, for the public endpoint, a PUT of exactly contentType and size bytes.
	PresignPut(ctx context.Context, bucket, key, contentType string, size int64, ttl time.Duration) (string, error)
	HeadSize(ctx context.Context, bucket, key string) (int64, error)
	DeleteObject(ctx context.Context, bucket, key string) error
}
