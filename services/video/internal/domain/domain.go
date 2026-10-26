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
	// Codec is "h264" or "av1" (ENC2, ADR-041); empty in entries cached before ENC2 means h264.
	Codec string `json:"codec,omitempty"`
}

// Video is a full record with owner profile and renditions. It is viewer
// independent, so it can be cached and the visibility rules applied after.
type Video struct {
	ID           uuid.UUID  `json:"id"`
	OwnerID      uuid.UUID  `json:"owner_id"`
	Title        string     `json:"title"`
	Description  string     `json:"description"`
	Tags         []string   `json:"tags"`      // TAG1 (ADR-036); never nil when read from the store
	TagSlugs     []string   `json:"tag_slugs"` // SEO2 (ADR-037): media.videos.tag_slugs, aligned with Tags
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
	StoryboardKey *string `json:"storyboard_key"`
	// HLSAV1MasterKey is the master of the separate AV1 set (ENC2, ADR-041); nil when the video has none.
	// Renditions then also lists its codec='av1' rows, after the H.264 ones.
	HLSAV1MasterKey *string     `json:"hls_av1_master_key"`
	Owner           Profile     `json:"owner"`
	Renditions      []Rendition `json:"renditions"`
	Subtitles       []Subtitle  `json:"subtitles"` // READY videos only, sorted by lang (V5b)
	// AudioTracks are the READY extra audio tracks (MUX1), READY videos only, sorted by lang then kind.
	AudioTracks []AudioTrack `json:"audio_tracks"`

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
	Kind      string    `json:"kind"`       // subtitles or captions (MUX1)
	Source    string    `json:"source"`     // UPLOAD; AUTO is reserved for V5c
	IsDefault bool      `json:"is_default"` // turned on when the viewer has no preference (DEF1)
	ObjectKey string    `json:"object_key"`
	SizeBytes int       `json:"size_bytes"`
	UpdatedAt time.Time `json:"updated_at"`
}

// SubtitleWrite is a track whose object is already in the media bucket.
type SubtitleWrite struct {
	VideoID   uuid.UUID
	Lang      string
	Label     string
	Kind      string // subtitles or captions
	ObjectKey string
	SizeBytes int
	// Default: nil keeps the current flag of a replaced track (false for a new one); true makes it the
	// video's default subtitle and clears the others; false clears it (DEF1).
	Default *bool
}

// SubtitleUpdate is a PATCH of a track's metadata: a nil field keeps it; Default as in SubtitleWrite.
type SubtitleUpdate struct {
	Label   *string
	Default *bool
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

// Objects is the media bucket as video-svc needs it: subtitle files, and the HLS master and audio track
// objects of MUX1.
type Objects interface {
	Put(ctx context.Context, bucket, key string, data []byte, contentType, cacheControl string) error
	Delete(ctx context.Context, bucket, key string) error
	// Read reads a small object (at most max bytes).
	Read(ctx context.Context, bucket, key string, max int64) ([]byte, error)
	// RemovePrefix removes every object under prefix, which ends in "/".
	RemovePrefix(ctx context.Context, bucket, prefix string) error
}

// AudioTrack is one row of media.video_audio_tracks (task MUX1, ADR-042).
type AudioTrack struct {
	ID          uuid.UUID `json:"id"`
	Lang        string    `json:"lang"`
	Label       string    `json:"label"`
	Kind        string    `json:"kind"`
	IsDefault   bool      `json:"is_default"`
	Status      string    `json:"status"`
	Error       string    `json:"error"`
	PlaylistKey string    `json:"playlist_key"` // set when READY
	UpdatedAt   time.Time `json:"updated_at"`
}

// AudioTrackUpdate is a PATCH of a track: a nil Label keeps it; MakeDefault moves the default to it;
// ClearDefault unsets it, so the video's own audio becomes the default (DEF1). At most one of the two.
type AudioTrackUpdate struct {
	Label        *string
	MakeDefault  bool
	ClearDefault bool
}

// MasterRewrite builds the HLS master of a video for its READY audio tracks (hlsmaster.With) from the
// master at masterKey, stores it under a new key and returns that key. The store calls it inside the
// transaction that holds the video row lock, so concurrent rewrites (video-svc, transcoder) serialise.
type MasterRewrite func(ctx context.Context, videoID uuid.UUID, masterKey string, ready []AudioTrack) (newKey string, err error)

// ErrAudioTrackUploading: the track is still being uploaded; upload-svc aborts it.
var ErrAudioTrackUploading = errors.New("audio track is uploading")

// SubscriptionFeedQuery asks for the newest public videos of the channels Subscriber follows (task R2-b).
type SubscriptionFeedQuery struct {
	Subscriber uuid.UUID
	After      *Position
	Limit      int // the store returns up to Limit rows; callers pass pageSize+1
}

// MaxHistory is the number of videos kept in a user's watch history (task HIST1).
const MaxHistory = 500

// HistoryQuery asks for one page of a user's watch history, most recent first (task HIST1).
type HistoryQuery struct {
	User  uuid.UUID
	After *Position // keyset (watched_at, video id) of the last item of the previous page
	Limit int       // the store returns up to Limit rows; callers pass pageSize+1
}

// HistoryEntry is one video of a watch history.
type HistoryEntry struct {
	Video     Summary
	WatchedAt time.Time
	WatchedMs int64
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
	Tag     string // SEO2: a tag slug or tag text; the database derives the slug ("" = no tag filter)
	After   *Position
	Limit   int // the store returns up to Limit rows; callers pass pageSize+1
}

// StudioQuery asks for one user's videos in every status, newest created first.
// AdminVideoQuery filters adminListVideos (task ADMV1): every video, whoever owns it. Empty strings and a
// nil OwnerID mean "any".
type AdminVideoQuery struct {
	Q               string
	Status          string
	Visibility      string
	ModerationState string
	OwnerID         *uuid.UUID
	After           *Position
	Limit           int
}

// AdminVideoItem is a studio row plus its owner (a placeholder profile when Owner.Missing).
type AdminVideoItem struct {
	StudioItem
	Owner Profile
}

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
	Tags        *[]string // already normalized (NormalizeTags); nil = unchanged, empty = clear
}

// Store is the persistence port (media.videos and friends, auth.public_profiles).
type Store interface {
	GetVideo(ctx context.Context, id uuid.UUID) (Video, error)
	ListFeed(ctx context.Context, q FeedQuery) ([]Summary, error)
	ListStudio(ctx context.Context, q StudioQuery) ([]StudioItem, error)
	ListAdminVideos(ctx context.Context, q AdminVideoQuery) ([]AdminVideoItem, error)
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
	// UpdateSubtitle applies u to the track in ONE transaction that locks the video row (a default set here
	// clears the others) and returns the track. ErrNotFound if the video or the track does not exist.
	UpdateSubtitle(ctx context.Context, videoID uuid.UUID, lang string, u SubtitleUpdate) (Subtitle, error)
	// ListAudioTracks returns every audio track of the video in every status, sorted by lang then kind.
	ListAudioTracks(ctx context.Context, videoID uuid.UUID) ([]AudioTrack, error)
	// UpdateAudioTrack applies u in ONE transaction that locks the video row; when the video has a master and
	// READY tracks before or after the change, it calls rewrite and stores the new hls_master_key in the same
	// transaction, and does the same for hls_av1_master_key when the video has an AV1 set (ENC2). ErrNotFound if the track is not the video's.
	UpdateAudioTrack(ctx context.Context, videoID, trackID uuid.UUID, u AudioTrackUpdate, rewrite MasterRewrite) (AudioTrack, error)
	// DeleteAudioTrack deletes a track that is not UPLOADING (ErrAudioTrackUploading) the same way and returns
	// the deleted row. ErrNotFound if the track is not the video's.
	DeleteAudioTrack(ctx context.Context, videoID, trackID uuid.UUID, rewrite MasterRewrite) (AudioTrack, error)
	// ListSubscriptionFeed reads one page of the public-feed videos of the channels the subscriber follows
	// (media.subscriptions, the projection of social.subscription.changed), newest first by (published_at, id).
	ListSubscriptionFeed(ctx context.Context, q SubscriptionFeedQuery) ([]Summary, error)
	// RecordWatch upserts (user, video) at the top of the user's history and prunes it to MaxHistory rows, in ONE
	// transaction. A video deleted in the meantime is not an error (nothing is written). Task HIST1.
	RecordWatch(ctx context.Context, user, video uuid.UUID, watchedMs int64) error
	// ListHistory reads one page of the user's history, skipping videos the user can no longer watch from a list.
	ListHistory(ctx context.Context, q HistoryQuery) ([]HistoryEntry, error)
	// RemoveFromHistory deletes one row; a missing one is not an error.
	RemoveFromHistory(ctx context.Context, user, video uuid.UUID) error
	// ClearHistory deletes all of the user's rows.
	ClearHistory(ctx context.Context, user uuid.UUID) error
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
	// ListTags ranks the tags of public videos by video count (task SEO2).
	ListTags(ctx context.Context, limit, minVideos int) ([]Tag, error)
	// GetTag returns one tag by slug or tag text; ErrNotFound when no public video carries it (task SEO2).
	GetTag(ctx context.Context, tag string) (Tag, error)
}

// Tag is one tag of the public videos (task SEO2, ADR-037). Name is the spelling most of those videos use.
type Tag struct {
	Slug              string
	Name              string
	VideoCount        int
	LatestPublishedAt time.Time
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
