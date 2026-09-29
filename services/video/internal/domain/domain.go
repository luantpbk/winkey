// Package domain holds the types, visibility rules and ports of video-svc.
package domain

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Video statuses and visibilities (media.video_status / media.visibility).
const (
	StatusUploading  = "UPLOADING"
	StatusUploaded   = "UPLOADED"
	StatusProcessing = "PROCESSING"
	StatusReady      = "READY"
	StatusFailed     = "FAILED"

	VisPublic   = "PUBLIC"
	VisUnlisted = "UNLISTED"
	VisPrivate  = "PRIVATE"
)

// ErrNotFound: the video does not exist (or, for owner-scoped writes, is not
// the caller's).
var ErrNotFound = errors.New("not found")

// Profile is the owner as exposed by auth.public_profiles.
type Profile struct {
	ID          uuid.UUID `json:"id"`
	Handle      string    `json:"handle"`
	DisplayName string    `json:"display_name"`
	AvatarKey   *string   `json:"avatar_key"`
	// Missing is true when the owner is not an ACTIVE user (suspended, deleted):
	// the view returns no row. Only privileged callers and the owner still see
	// such videos, with a placeholder owner.
	Missing bool `json:"missing"`
}

// Rendition of a READY video.
type Rendition struct {
	Name        string `json:"name"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	BitrateKbps int    `json:"bitrate_kbps"`
}

// Video is a full record with owner profile and renditions. It is viewer
// independent, so it can be cached and the visibility rules applied after.
type Video struct {
	ID           uuid.UUID   `json:"id"`
	OwnerID      uuid.UUID   `json:"owner_id"`
	Title        string      `json:"title"`
	Description  string      `json:"description"`
	Visibility   string      `json:"visibility"`
	Status       string      `json:"status"`
	DurationMs   *int        `json:"duration_ms"`
	Width        *int        `json:"width"`
	Height       *int        `json:"height"`
	ViewCount    int64       `json:"view_count"`
	LikeCount    int64       `json:"like_count"`
	PublishedAt  *time.Time  `json:"published_at"`
	CreatedAt    time.Time   `json:"created_at"`
	HLSMasterKey *string     `json:"hls_master_key"`
	ThumbnailKey *string     `json:"thumbnail_key"`
	Owner        Profile     `json:"owner"`
	Renditions   []Rendition `json:"renditions"`
}

// Summary is one feed entry (READY + PUBLIC only).
type Summary struct {
	ID           uuid.UUID
	Title        string
	Owner        Profile
	DurationMs   int
	ViewCount    int64
	PublishedAt  time.Time
	ThumbnailKey string
}

// StudioItem is one entry of the creator's own list.
type StudioItem struct {
	ID           uuid.UUID
	Title        string
	Visibility   string
	Status       string
	Progress     float64
	Error        *string
	DurationMs   *int
	CreatedAt    time.Time
	ThumbnailKey *string
}

// Position is a keyset position: the sort timestamp and id of the last item
// of the previous page.
type Position struct {
	T  time.Time
	ID uuid.UUID
}

// FeedQuery asks for READY + PUBLIC videos, newest published first.
type FeedQuery struct {
	OwnerID *uuid.UUID
	After   *Position
	Limit   int // the store returns up to Limit rows; callers pass pageSize+1
}

// StudioQuery asks for one user's videos in every status, newest created first.
type StudioQuery struct {
	UserID uuid.UUID
	Status string // "" = every status
	After  *Position
	Limit  int
}

// Update holds the fields of a PATCH; nil means "leave unchanged".
type Update struct {
	Title       *string
	Description *string
	Visibility  *string
}

// Store is the persistence port (media.videos and friends, auth.public_profiles).
type Store interface {
	GetVideo(ctx context.Context, id uuid.UUID) (Video, error)
	ListFeed(ctx context.Context, q FeedQuery) ([]Summary, error)
	ListStudio(ctx context.Context, q StudioQuery) ([]StudioItem, error)
	// UpdateVideo applies u to the video only if ownerID owns it and returns the
	// new record. ErrNotFound if the video does not exist or is not theirs.
	UpdateVideo(ctx context.Context, id, ownerID uuid.UUID, u Update) (Video, error)
	// DeleteVideo, in ONE transaction, deletes the row (cascading to renditions
	// and jobs) and enqueues video.deleted. deleted is false when it no longer exists.
	DeleteVideo(ctx context.Context, id uuid.UUID, mediaBucket string) (deleted bool, err error)
}

// Cache is the optional read cache for GET /v1/videos/{id}.
type Cache interface {
	Get(ctx context.Context, id uuid.UUID) (Video, bool)
	Set(ctx context.Context, v Video)
	Invalidate(ctx context.Context, id uuid.UUID)
}

// DeletedEvent is the `data` of video.deleted.
type DeletedEvent struct {
	VideoID     string `json:"video_id"`
	OwnerID     string `json:"owner_id"`
	RawBucket   string `json:"raw_bucket"`
	RawKey      string `json:"raw_key"`
	MediaBucket string `json:"media_bucket"`
	MediaPrefix string `json:"media_prefix"`
}
