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
	ID           uuid.UUID  `json:"id"`
	OwnerID      uuid.UUID  `json:"owner_id"`
	Title        string     `json:"title"`
	Description  string     `json:"description"`
	Visibility   string     `json:"visibility"`
	Status       string     `json:"status"`
	DurationMs   *int       `json:"duration_ms"`
	Width        *int       `json:"width"`
	Height       *int       `json:"height"`
	ViewCount    int64      `json:"view_count"`
	LikeCount    int64      `json:"like_count"`
	PublishedAt  *time.Time `json:"published_at"`
	CreatedAt    time.Time  `json:"created_at"`
	HLSMasterKey *string    `json:"hls_master_key"`
	ThumbnailKey *string    `json:"thumbnail_key"`
	// StoryboardKey is the key of storyboard.vtt (seek preview, V5a); nil when there is none.
	StoryboardKey *string     `json:"storyboard_key"`
	Owner         Profile     `json:"owner"`
	Renditions    []Rendition `json:"renditions"`
	Subtitles     []Subtitle  `json:"subtitles"` // READY videos only, sorted by lang (V5b)

	// Moderation (A2). A HIDDEN video is PRIVATE for everyone but its owner,
	// moderators and admins.
	ModerationState  string     `json:"moderation_state"`
	ModerationReason *string    `json:"moderation_reason"`
	ModeratedBy      *uuid.UUID `json:"moderated_by"`
	ModeratedAt      *time.Time `json:"moderated_at"`
}

// Hidden reports whether a moderator hid the video.
func (v Video) Hidden() bool { return v.ModerationState == ModHidden }

// DailyStats is one analytics.video_daily row (a day in Asia/Ho_Chi_Minh).
type DailyStats struct {
	Day          time.Time // midnight UTC of the calendar date
	Starts       int64
	WatchedMs    int64
	RebufferMs   int64
	Errors       int64
	Viewers      int64
	StartupP50Ms *int
	StartupP95Ms *int
	RefreshedAt  time.Time
}

// VideoStatsData is what the store knows for getVideoStats.
type VideoStatsData struct {
	OwnerID   uuid.UUID
	ViewCount int64
	Days      []DailyStats // only the days that have a row, ascending
}

// ChannelDay is the sum over the owner's videos for one day.
type ChannelDay struct {
	Day         time.Time
	Starts      int64
	WatchedMs   int64
	RebufferMs  int64
	Errors      int64
	RefreshedAt time.Time // latest refresh of the summed rows
}

// TopVideo is one entry of the channel ranking.
type TopVideo struct {
	ID        uuid.UUID
	Title     string
	Starts    int64
	WatchedMs int64
}

// ChannelStatsData is what the store knows for getChannelStats.
type ChannelStatsData struct {
	Days []ChannelDay // only the days that have rows, ascending
	Top  []TopVideo   // at most 10, ordered
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

	ModerationState  string
	ModerationReason *string
	ModeratedAt      *time.Time

	// OwnerActive is false when the owner is not in auth.public_profiles (suspended, deleted).
	OwnerActive bool
}

// MaxSubtitles is the number of subtitle tracks a video may have (ADR-018).
const MaxSubtitles = 20

// Subtitle is one WebVTT track of a video (media.video_subtitles, task V5b).
type Subtitle struct {
	Lang      string    `json:"lang"`
	Label     string    `json:"label"`
	Source    string    `json:"source"` // UPLOAD; AUTO is reserved for V5c
	ObjectKey string    `json:"object_key"`
	SizeBytes int       `json:"size_bytes"`
	UpdatedAt time.Time `json:"updated_at"`
}

// SubtitleWrite is a track whose object is already in the media bucket.
type SubtitleWrite struct {
	VideoID   uuid.UUID
	Lang      string
	Label     string
	ObjectKey string
	SizeBytes int
}

// SubtitleResult is what Store.PutSubtitle committed.
type SubtitleResult struct {
	Track       Subtitle
	Created     bool   // false: an existing track of that language was replaced
	PreviousKey string // object of the replaced track, to delete after the commit; "" when created
}

// Errors of the subtitle operations.
var (
	ErrTooManySubtitles = errors.New("too many subtitles")
	ErrVideoFailed      = errors.New("video failed")
)

// Objects is the media bucket as video-svc needs it (subtitles only).
type Objects interface {
	Put(ctx context.Context, bucket, key string, data []byte, contentType, cacheControl string) error
	Delete(ctx context.Context, bucket, key string) error
}

// SubscriptionFeedQuery asks for the newest public videos of the channels Subscriber follows (task R2-b).
type SubscriptionFeedQuery struct {
	Subscriber uuid.UUID
	After      *Position
	Limit      int // the store returns up to Limit rows; callers pass pageSize+1
}

// TrendingQuery asks for the current trending ranking (task R2-a), best first.
type TrendingQuery struct {
	AfterRank int // 0 = from the top
	Limit     int // the store returns up to Limit rows; callers pass pageSize+1
}

// TrendingItem is one entry of the ranking with its rank.
type TrendingItem struct {
	Summary
	Rank int
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
	// new record. ErrNotFound if the video does not exist or is not theirs. In the
	// SAME transaction, when the visibility actually changes, it enqueues
	// video.visibility_changed (nothing for a no-op or for other fields).
	UpdateVideo(ctx context.Context, id, ownerID uuid.UUID, u Update) (Video, error)
	// DeleteVideo, in ONE transaction, deletes the row (cascading to renditions
	// and jobs) and enqueues video.deleted. deleted is false when it no longer exists.
	DeleteVideo(ctx context.Context, id uuid.UUID, mediaBucket string) (deleted bool, err error)
	// ModerateVideo, in ONE transaction, sets the moderation state (row locked, so
	// concurrent calls serialise) and, only when the state changed, enqueues
	// video.moderated. changed is false for a no-op (same state again: nothing is
	// written, no event). ErrNotFound if the video does not exist.
	ModerateVideo(ctx context.Context, id, moderatorID uuid.UUID, state string, reason *string) (v Video, changed bool, err error)
	// PutSubtitle, in ONE transaction, locks the video row (FOR UPDATE), refuses a 21st language
	// (ErrTooManySubtitles; replacing a language is always allowed), and upserts the track. The
	// object at w.ObjectKey must already exist. ErrNotFound if the video is gone, ErrVideoFailed if
	// it is FAILED.
	PutSubtitle(ctx context.Context, w SubtitleWrite) (SubtitleResult, error)
	// DeleteSubtitle removes the row and returns its object key; ErrNotFound if there is no such track.
	DeleteSubtitle(ctx context.Context, videoID uuid.UUID, lang string) (objectKey string, err error)
	// ListSubscriptionFeed reads one page of the public-feed videos of the channels the subscriber follows
	// (media.subscriptions, the projection of social.subscription.changed), newest first by (published_at, id).
	ListSubscriptionFeed(ctx context.Context, q SubscriptionFeedQuery) ([]Summary, error)
	// ListTrending reads media.trending by rank, joined to the videos and re-applying the public-feed predicate
	// (a video made PRIVATE or HIDDEN since the last recompute is not returned) in ONE query.
	ListTrending(ctx context.Context, q TrendingQuery) ([]TrendingItem, error)
	// VideosForPlayback reads, with ONE query for all ids, what the visibility rules need of each video that
	// exists (ID, OwnerID, Status, Visibility, ModerationState, Owner.Missing). Unknown ids are absent from the
	// result. Task R1 (playback heartbeats).
	VideosForPlayback(ctx context.Context, ids []uuid.UUID) ([]Video, error)
	// VideosByID reads the rows of every video in ids that exists, in ONE query (no renditions or subtitles: the
	// result is for summaries and must not be cached as a full Video). Unknown ids are absent. Task PL1-v.
	VideosByID(ctx context.Context, ids []uuid.UUID) ([]Video, error)
	// VideoStats reads, with ONE query, the owner and view_count of the video and its analytics.video_daily rows
	// between from and to (days in Asia/Ho_Chi_Minh). ErrNotFound when the video does not exist. Task R1-b.
	VideoStats(ctx context.Context, id uuid.UUID, from, to time.Time) (VideoStatsData, error)
	// ChannelStats reads the owner's daily sums and top videos with two queries; videos that are deleted or
	// not the owner's are never counted (INNER JOIN media.videos). Task R1-b.
	ChannelStats(ctx context.Context, owner uuid.UUID, from, to time.Time) (ChannelStatsData, error)
	// RelatedSimilar returns up to limit public videos whose search_vector matches tsquery (a ready-made
	// to_tsquery('simple') text of OR-ed words, folded in SQL), best ts_rank first, never excluding more than the
	// source itself. Uses videos_search_fts. Task R2-c.
	RelatedSimilar(ctx context.Context, exclude uuid.UUID, tsquery string, limit int) ([]Summary, error)
	// RelatedSameChannel returns the owner's newest public videos except exclude. Task R2-c.
	RelatedSameChannel(ctx context.Context, owner, exclude uuid.UUID, limit int) ([]Summary, error)
	// RelatedTrending returns media.trending by rank, re-applying the public predicate, except exclude. Task R2-c.
	RelatedTrending(ctx context.Context, exclude uuid.UUID, limit int) ([]Summary, error)
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

// VisibilityChangedEvent is the `data` of video.visibility_changed (task C4).
type VisibilityChangedEvent struct {
	VideoID    string `json:"video_id"`
	OwnerID    string `json:"owner_id"`
	Visibility string `json:"visibility"`
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
