package api

import (
	"strings"
	"time"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// JSON models: exactly the schemas of contracts/openapi/video.v1.yaml.

type profileJSON struct {
	ID          string  `json:"id"`
	Handle      string  `json:"handle"`
	DisplayName string  `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
}

type renditionJSON struct {
	Name        string `json:"name"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	BitrateKbps int    `json:"bitrate_kbps"`
}

type playbackJSON struct {
	HLSURL       string `json:"hls_url"`
	ThumbnailURL string `json:"thumbnail_url"`
	// StoryboardURL is the WebVTT seek-preview track (V5a); null when the video has none.
	StoryboardURL *string         `json:"storyboard_url"`
	ExpiresAt     *time.Time      `json:"expires_at,omitempty"` // only with signed URLs (SEC1)
	Renditions    []renditionJSON `json:"renditions"`
}

type videoJSON struct {
	ID          string        `json:"id"`
	Title       string        `json:"title"`
	Description string        `json:"description"`
	Owner       profileJSON   `json:"owner"`
	Visibility  string        `json:"visibility"`
	Status      string        `json:"status"`
	DurationMs  *int          `json:"duration_ms"`
	Width       *int          `json:"width"`
	Height      *int          `json:"height"`
	ViewCount   int64         `json:"view_count"`
	LikeCount   int64         `json:"like_count"`
	PublishedAt *time.Time    `json:"published_at"`
	CreatedAt   time.Time     `json:"created_at"`
	Playback    *playbackJSON `json:"playback"`
	// Moderation is present only for the owner, moderators and admins (A2).
	Moderation *moderationJSON `json:"moderation,omitempty"`
}

type moderationJSON struct {
	State       string     `json:"state"`
	Reason      *string    `json:"reason"`
	ModeratedAt *time.Time `json:"moderated_at"`
}

type summaryJSON struct {
	ID           string      `json:"id"`
	Title        string      `json:"title"`
	Owner        profileJSON `json:"owner"`
	DurationMs   int         `json:"duration_ms"`
	ViewCount    int64       `json:"view_count"`
	PublishedAt  time.Time   `json:"published_at"`
	ThumbnailURL string      `json:"thumbnail_url"`
}

type studioJSON struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	Visibility   string    `json:"visibility"`
	Status       string    `json:"status"`
	Progress     float64   `json:"progress"`
	Error        *string   `json:"error"`
	DurationMs   *int      `json:"duration_ms"`
	CreatedAt    time.Time `json:"created_at"`
	ThumbnailURL *string   `json:"thumbnail_url"`
	// The studio is the owner's own list, so the moderation state is always shown.
	Moderation *moderationJSON `json:"moderation,omitempty"`
}

type pageJSON[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// deletedOwner stands in for an owner who is not an ACTIVE user any more; only
// the owner (never the case here), moderators and admins can still see such videos.
var deletedOwner = profileJSON{Handle: "deleted_user", DisplayName: "Deleted user"}

func (h *Handler) mediaURL(key string) string {
	return strings.TrimRight(h.MediaBaseURL, "/") + "/" + strings.TrimLeft(key, "/")
}

func (h *Handler) mediaURLPtr(key *string) *string {
	if key == nil || *key == "" {
		return nil
	}
	u := h.mediaURL(*key)
	return &u
}

func (h *Handler) profile(p domain.Profile) profileJSON {
	if p.Missing {
		out := deletedOwner
		out.ID = p.ID.String()
		return out
	}
	return profileJSON{ID: p.ID.String(), Handle: p.Handle, DisplayName: p.DisplayName, AvatarURL: h.mediaURLPtr(p.AvatarKey)}
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

func moderation(state string, reason *string, at *time.Time) *moderationJSON {
	if state == "" {
		state = domain.ModVisible
	}
	return &moderationJSON{State: state, Reason: reason, ModeratedAt: utcPtr(at)}
}

// video renders the record; who decides whether `moderation` is included
// (owner, moderator, admin only).
func (h *Handler) video(v domain.Video, who domain.Viewer) videoJSON {
	out := videoJSON{
		ID: v.ID.String(), Title: v.Title, Description: v.Description, Owner: h.profile(v.Owner),
		Visibility: v.Visibility, Status: v.Status, DurationMs: v.DurationMs, Width: v.Width, Height: v.Height,
		ViewCount: v.ViewCount, LikeCount: v.LikeCount, PublishedAt: utcPtr(v.PublishedAt), CreatedAt: v.CreatedAt.UTC(),
	}
	if out.Owner.ID == "" {
		out.Owner.ID = v.OwnerID.String()
	}
	if who.SeesModeration(v) {
		out.Moderation = moderation(v.ModerationState, v.ModerationReason, v.ModeratedAt)
	}
	// playback is null unless the video is READY (and has its keys, which the
	// database guarantees for READY rows).
	if v.Status == domain.StatusReady && v.HLSMasterKey != nil && v.ThumbnailKey != nil {
		pb := &playbackJSON{Renditions: make([]renditionJSON, 0, len(v.Renditions))}
		if v.PubliclyWatchable() {
			pb.HLSURL, pb.ThumbnailURL = h.mediaURL(*v.HLSMasterKey), h.mediaURL(*v.ThumbnailKey)
			pb.StoryboardURL = h.mediaURLPtr(v.StoryboardKey)
		} else { // only the owner, moderators and admins get here: signed, short lived (ADR-017)
			exp := h.mediaExpiry()
			pb.HLSURL, pb.ThumbnailURL = h.signedMediaURL(v.ID, *v.HLSMasterKey, exp), h.signedMediaURL(v.ID, *v.ThumbnailKey, exp)
			if v.StoryboardKey != nil && *v.StoryboardKey != "" { // same expiry as the other URLs
				u := h.signedMediaURL(v.ID, *v.StoryboardKey, exp)
				pb.StoryboardURL = &u
			}
			at := exp.UTC()
			pb.ExpiresAt = &at
		}
		for _, r := range v.Renditions {
			pb.Renditions = append(pb.Renditions, renditionJSON{Name: r.Name, Width: r.Width, Height: r.Height, BitrateKbps: r.BitrateKbps})
		}
		out.Playback = pb
	}
	return out
}

func (h *Handler) summary(s domain.Summary) summaryJSON {
	return summaryJSON{
		ID: s.ID.String(), Title: s.Title, Owner: h.profile(s.Owner), DurationMs: s.DurationMs,
		ViewCount: s.ViewCount, PublishedAt: s.PublishedAt.UTC(), ThumbnailURL: h.mediaURL(s.ThumbnailKey),
	}
}

func (h *Handler) studio(s domain.StudioItem) studioJSON {
	p := s.Progress
	if s.Status == domain.StatusReady {
		p = 100
	}
	thumb := h.mediaURLPtr(s.ThumbnailKey)
	if thumb != nil && !domain.PubliclyWatchable(s.Status, s.Visibility, s.ModerationState, s.OwnerActive) {
		u := h.signedMediaURL(s.ID, *s.ThumbnailKey, h.mediaExpiry())
		thumb = &u
	}
	return studioJSON{
		ID: s.ID.String(), Title: s.Title, Visibility: s.Visibility, Status: s.Status, Progress: p,
		Error: s.Error, DurationMs: s.DurationMs, CreatedAt: s.CreatedAt.UTC(), ThumbnailURL: thumb,
		Moderation: moderation(s.ModerationState, s.ModerationReason, s.ModeratedAt),
	}
}
