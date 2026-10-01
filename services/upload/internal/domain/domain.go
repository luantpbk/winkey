// Package domain holds the types and ports shared by the upload service.
package domain

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/s3x"
)

// Video statuses (media.video_status).
const (
	StatusUploading  = "UPLOADING"
	StatusUploaded   = "UPLOADED"
	StatusProcessing = "PROCESSING"
	StatusReady      = "READY"
	StatusFailed     = "FAILED"
)

// ErrNotFound is returned when a video does not exist or is not owned by the
// caller. The two cases are deliberately indistinguishable (no ID probing).
var ErrNotFound = errors.New("not found")

// Video is the subset of media.videos the upload service works with.
type Video struct {
	ID          uuid.UUID
	OwnerID     uuid.UUID
	Status      string
	RawBucket   string
	RawKey      string
	S3UploadID  string // empty once UPLOADED
	ContentType string
	SizeBytes   int64
	Error       string // owner-safe failure message; empty if none
}

// NewVideo is the input of Store.Insert.
type NewVideo struct {
	Video
	Title       string
	Description string
	Visibility  string
}

// Usage is the recent upload usage of one owner, read inside the transaction of Store.Create.
type Usage struct {
	Uploading int       // media.videos rows in status UPLOADING, whatever their age
	Count     int       // media.upload_ledger rows of the last 24 hours (deleted videos included)
	Bytes     int64     // sum of their size_bytes
	Oldest    time.Time // min(created_at) of those ledger rows; zero when there are none
	Now       time.Time // the database clock the window was computed with
}

// UploadedEvent is the `data` of the video.uploaded event.
type UploadedEvent struct {
	VideoID     string `json:"video_id"`
	OwnerID     string `json:"owner_id"`
	RawBucket   string `json:"raw_bucket"`
	RawKey      string `json:"raw_key"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
}

// Store is the persistence port (media.videos, media.transcode_jobs, outbox).
type Store interface {
	// Create inserts the video in ONE transaction (task UQ1):
	//  1. if check is not nil: take the owner's advisory lock, read the owner's Usage and call check;
	//     a non-nil error from check is returned as is and nothing is written;
	//  2. insert the UPLOADING row (without s3_upload_id) and the media.upload_ledger row (always,
	//     admins included; a refusal or a failed startUpload writes neither);
	//  3. call startUpload (S3 CreateMultipartUpload) and store its id in the row;
	//  4. commit.
	// startUpload runs only after the quota check passed, inside the lock, so concurrent requests of
	// one owner cannot overshoot a limit and a refused request never touches S3. When startUpload
	// fails nothing is written. When Create fails after startUpload succeeded (the commit), the
	// caller must abort the multipart upload; v.S3UploadID is ignored.
	Create(ctx context.Context, v NewVideo, check func(Usage) error, startUpload func(ctx context.Context) (uploadID string, err error)) error
	// Get returns the video regardless of owner; callers enforce ownership.
	Get(ctx context.Context, id uuid.UUID) (Video, error)
	// Progress returns the progress (0..100) of the latest transcode job, 0 if none.
	Progress(ctx context.Context, id uuid.UUID) (float64, error)
	// MarkUploaded atomically flips UPLOADING→UPLOADED, clears s3_upload_id and
	// enqueues video.uploaded in the same transaction. changed is false when
	// the video was no longer UPLOADING (lost a race).
	MarkUploaded(ctx context.Context, v Video) (changed bool, err error)
	// MarkFailed flips UPLOADING→FAILED with an owner-safe message.
	MarkFailed(ctx context.Context, id uuid.UUID, message string) (changed bool, err error)
	// DeleteUploading deletes the row only if it is still UPLOADING.
	DeleteUploading(ctx context.Context, id uuid.UUID) (deleted bool, err error)
	// PurgeLedger deletes at most limit rows of media.upload_ledger created more than olderThan ago
	// and returns how many (retention sweep; the database refuses rows younger than 25 h).
	PurgeLedger(ctx context.Context, olderThan time.Duration, limit int) (int, error)
	// StaleUploads lists UPLOADING videos created more than olderThan ago.
	StaleUploads(ctx context.Context, olderThan time.Duration, limit int) ([]Video, error)
}

// Part is one completed multipart part.
type Part struct {
	Number int32
	ETag   string
}

// Errors returned by Storage implementations: the shared s3x sentinels, so
// errors.Is works no matter which layer wrapped them.
var (
	// ErrNoSuchUpload: the multipart upload id is unknown (aborted/completed).
	ErrNoSuchUpload = s3x.ErrNoSuchUpload
	// ErrInvalidPart: a part is missing or its ETag does not match.
	ErrInvalidPart = s3x.ErrInvalidPart
	// ErrNoSuchObject: the object does not exist.
	ErrNoSuchObject = s3x.ErrNotFound
)

// Storage is the object-storage port. Server-side calls use the internal
// endpoint; PresignPart signs for the public endpoint.
type Storage interface {
	CreateMultipart(ctx context.Context, bucket, key, contentType string) (uploadID string, err error)
	PresignPart(ctx context.Context, bucket, key, uploadID string, part int32, ttl time.Duration) (url string, err error)
	CompleteMultipart(ctx context.Context, bucket, key, uploadID string, parts []Part) error
	AbortMultipart(ctx context.Context, bucket, key, uploadID string) error
	HeadSize(ctx context.Context, bucket, key string) (int64, error)
	DeleteObject(ctx context.Context, bucket, key string) error
	// Ping checks the bucket is reachable (readiness).
	Ping(ctx context.Context, bucket string) error
}
