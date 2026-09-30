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

	// Moderation states (media.moderation_state, task A2).
	ModVisible = "VISIBLE"
	ModHidden  = "HIDDEN"

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

	// Moderation (A2). A HIDDEN video is PRIVATE for everyone but its owner,
	// moderators and admins.
	ModerationState  string     `json:"moderation_state"`
	ModerationReason *string    `json:"moderation_reason"`
	ModeratedBy      *uuid.UUID `json:"moderated_by"`
	ModeratedAt      *time.Time `json:"moderated_at"`
}

// Hidden reports whether a moderator hid the video.
func (v Video) Hidden() bool { return v.ModerationState == ModHidden }

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

	ModerationState  string
	ModerationReason *string
	ModeratedAt      *time.Time

	// OwnerActive is false when the owner is not in auth.public_profiles (suspended, deleted).
	OwnerActive bool
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

// Search modes (task SR1): full text first, trigram similarity on the title as
// the fallback of an empty first page.
const (
	SearchFTS  = "fts"
	SearchTrgm = "trgm"
)

// SearchAfter is the keyset position of a search page, in the order
// (rank DESC, published_at DESC, id DESC). Rank is a float4 so it survives a
// cursor round trip bit for bit.
type SearchAfter struct {
	Rank float32
	T    time.Time
	ID   uuid.UUID
}

// SearchQuery asks for one page of READY + PUBLIC + VISIBLE videos matching Q.
// Q is the trimmed user text: the store folds it in SQL. Mode "" (first page)
// lets the store fall back to trigrams when full text finds nothing; a cursor
// pins the mode.
type SearchQuery struct {
	Q     string
	Mode  string
	After *SearchAfter
	Limit int // the store returns up to Limit rows; callers pass pageSize+1
}

// SearchHit is one result with the rank it was ordered by.
type SearchHit struct {
	Summary
	Rank float32
}

// SearchResult is one page and the mode that produced it.
type SearchResult struct {
	Mode string
	Hits []SearchHit
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
	// ModerateVideo, in ONE transaction, sets the moderation state (row locked, so
	// concurrent calls serialise) and, only when the state changed, enqueues
	// video.moderated. changed is false for a no-op (same state again: nothing is
	// written, no event). ErrNotFound if the video does not exist.
	ModerateVideo(ctx context.Context, id, moderatorID uuid.UUID, state string, reason *string) (v Video, changed bool, err error)
	// MediaPublic reports whether the public may fetch the video's media
	// (PubliclyWatchable), with ONE primary-key query. Unknown ids are false.
	MediaPublic(ctx context.Context, id uuid.UUID) (bool, error)
	// SearchVideos runs one page of the public video search (task SR1).
	SearchVideos(ctx context.Context, q SearchQuery) (SearchResult, error)
	// SuggestTitles returns up to limit distinct titles of public videos for a search box.
	SuggestTitles(ctx context.Context, q string, limit int) ([]string, error)
}

// Cache is the optional read cache for GET /v1/videos/{id}.
type Cache interface {
	Get(ctx context.Context, id uuid.UUID) (Video, bool)
	Set(ctx context.Context, v Video)
	Invalidate(ctx context.Context, id uuid.UUID)
}

// ModeratedEvent is the `data` of video.moderated.
type ModeratedEvent struct {
	VideoID     string `json:"video_id"`
	OwnerID     string `json:"owner_id"`
	State       string `json:"state"`
	ModeratorID string `json:"moderator_id"`
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
