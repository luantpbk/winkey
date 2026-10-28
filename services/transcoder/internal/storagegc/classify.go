// Package storagegc inventories the media and raw buckets against the database (task STOR1) and says which
// objects are still needed. Classification is pure (no I/O) so it is unit-tested without S3 or Postgres.
//
// Media bucket layout: v/{video}/a{n}/... (one directory per transcode attempt; the current one is the
// directory of hls_master_key), v/{video}/av1/{run}/... (AV1 set, current one = directory of
// hls_av1_master_key), v/{video}/audio/{track}/... (extra audio tracks, MUX1), v/{video}/subtitles/...
// Raw bucket layout: {owner}/{video}/source and {owner}/{video}/audio/{track}/source.
// Social images (SOC-1b): media i/{owner}/{image}/{image,thumb}.webp, raw {owner}/images/{image}.
package storagegc

import (
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Category names one row of the report. Only the Deletable ones can be removed with -apply.
type Category string

const (
	// Kept: needed for playback or for a future re-encode.
	MediaCurrent    Category = "media-current"     // current H.264 attempt, subtitles, other files of a live video
	MediaAV1Current Category = "media-av1-current" // current AV1 set
	MediaAudio      Category = "media-audio"       // extra audio track of a live track
	MediaInFlight   Category = "media-in-flight"   // attempt of a video that is not READY yet
	RawSource       Category = "raw-source"        // source of a live video (re-encode, AV1 upgrade)
	RawAudioLive    Category = "raw-audio-pending" // raw audio of a track that is not READY yet
	MediaImage      Category = "media-image"       // WebP of a READY image that is a post image or a current avatar/banner
	RawImageLive    Category = "raw-image-pending" // raw image not processed yet (UPLOADING / PROCESSING)
	Recent          Category = "recent"            // younger than the age guard: never judged
	Unknown         Category = "unknown"           // outside the documented layout: never deleted

	// Deletable garbage.
	MediaOrphanVideo  Category = "media-orphan-video"  // v/{video}/ of a video that no longer exists
	MediaOldAttempt   Category = "media-old-attempt"   // a{n}/ that is not the current attempt of a READY video
	MediaOldAV1       Category = "media-old-av1"       // av1/{run}/ that is not the current AV1 set
	MediaOrphanAudio  Category = "media-orphan-audio"  // audio/{track}/ of a track that no longer exists
	RawOrphanVideo    Category = "raw-orphan-video"    // raw files of a video that no longer exists
	RawOrphanAudio    Category = "raw-orphan-audio"    // raw audio of a track that no longer exists
	RawAudioProcessed Category = "raw-audio-processed" // raw audio of a READY track (the HLS output is all that is used)
	MediaOrphanImage  Category = "media-orphan-image"  // i/{owner}/{image}/ of an image that is gone or not READY
	ImageUnreferenced Category = "image-unreferenced"  // READY avatar/banner no profile uses, or post image no post uses (row deleted too)
	RawImageProcessed Category = "raw-image-processed" // raw image of a READY or FAILED image
	RawOrphanImage    Category = "raw-orphan-image"    // raw image without a row
)

// Deletable lists the garbage categories, in report order.
var Deletable = []Category{MediaOrphanVideo, MediaOldAttempt, MediaOldAV1, MediaOrphanAudio,
	RawOrphanVideo, RawOrphanAudio, RawAudioProcessed,
	MediaOrphanImage, ImageUnreferenced, RawImageProcessed, RawOrphanImage}

// IsDeletable reports whether c is one of the garbage categories.
func IsDeletable(c Category) bool {
	for _, d := range Deletable {
		if d == c {
			return true
		}
	}
	return false
}

// Video is the part of a media.videos row the classification needs.
type Video struct {
	ID, Owner     uuid.UUID
	Status        string
	MasterKey     string // hls_master_key ("" when none)
	AV1MasterKey  string // hls_av1_master_key ("" when none)
	audioByID     map[uuid.UUID]string
	currentAttDir string
	currentAV1Dir string
}

// Snapshot is the database state the objects are judged against.
type Snapshot struct {
	videos map[uuid.UUID]*Video
	images map[uuid.UUID]Image
	inUse  map[string]bool // avatar_key / banner_key of active profiles, plus post image keys (SOC-2a)
	// postRefsKnown: social.post_media was readable. Without it no POST image is ever judged unreferenced.
	postRefsKnown bool
}

// Image is the part of a media.images row the classification needs.
type Image struct {
	ID, Owner uuid.UUID
	Purpose   string
	Status    string
	ImageKey  string
}

// SetImages adds the social images and the image keys in use: avatars and banners of active profiles (SOC-1b)
// and, when postRefsKnown, the images of posts (social.post_media, SOC-2a).
func (s *Snapshot) SetImages(images []Image, inUse map[string]bool, postRefsKnown bool) {
	s.images = make(map[uuid.UUID]Image, len(images))
	for _, i := range images {
		s.images[i.ID] = i
	}
	s.inUse = inUse
	s.postRefsKnown = postRefsKnown
}

// ImageID returns the image id of an i/{owner}/{image}/ media key.
func ImageID(key string) (uuid.UUID, bool) {
	parts := strings.Split(key, "/")
	if len(parts) < 4 || parts[0] != "i" {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(parts[2])
	return id, err == nil && id.String() == parts[2]
}

// NewSnapshot indexes the videos and their audio tracks (track id → status).
func NewSnapshot(videos []Video, tracks map[uuid.UUID]map[uuid.UUID]string) *Snapshot {
	s := &Snapshot{videos: make(map[uuid.UUID]*Video, len(videos))}
	for i := range videos {
		v := videos[i]
		v.audioByID = tracks[v.ID]
		if v.MasterKey != "" {
			v.currentAttDir = attemptDir(v.ID, v.MasterKey)
		}
		if v.AV1MasterKey != "" {
			v.currentAV1Dir = path.Dir(v.AV1MasterKey) + "/"
		}
		s.videos[v.ID] = &v
	}
	return s
}

// attemptDir is "v/{id}/a{n}/" for a master key under an attempt directory, else "".
func attemptDir(id uuid.UUID, key string) string {
	prefix := "v/" + id.String() + "/"
	rest, ok := strings.CutPrefix(key, prefix)
	if !ok {
		return ""
	}
	first, _, _ := strings.Cut(rest, "/")
	if !isAttempt(first) {
		return ""
	}
	return prefix + first + "/"
}

func isAttempt(s string) bool {
	if len(s) < 2 || s[0] != 'a' {
		return false
	}
	for _, r := range s[1:] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ClassifyMedia judges one object of the media bucket.
func (s *Snapshot) ClassifyMedia(key string, modified, now time.Time, minAge time.Duration) Category {
	if now.Sub(modified) < minAge {
		return Recent
	}
	parts := strings.Split(key, "/")
	if len(parts) >= 4 && parts[0] == "i" {
		return s.classifyImage(parts)
	}
	if len(parts) < 3 || parts[0] != "v" {
		return Unknown
	}
	id, err := uuid.Parse(parts[1])
	if err != nil || id.String() != parts[1] {
		return Unknown
	}
	v, ok := s.videos[id]
	if !ok {
		return MediaOrphanVideo
	}
	switch dir := parts[2]; {
	case isAttempt(dir):
		if v.Status != "READY" || v.currentAttDir == "" {
			return MediaInFlight
		}
		if "v/"+id.String()+"/"+dir+"/" == v.currentAttDir {
			return MediaCurrent
		}
		return MediaOldAttempt
	case dir == "av1" && len(parts) >= 5:
		if v.currentAV1Dir != "" && strings.HasPrefix(key, v.currentAV1Dir) {
			return MediaAV1Current
		}
		return MediaOldAV1
	case dir == "audio" && len(parts) >= 5:
		tid, err := uuid.Parse(parts[3])
		if err != nil {
			return Unknown
		}
		if _, ok := v.audioByID[tid]; ok {
			return MediaAudio
		}
		return MediaOrphanAudio
	default:
		return MediaCurrent
	}
}

func (s *Snapshot) classifyImage(parts []string) Category {
	id, err := uuid.Parse(parts[2])
	if err != nil || id.String() != parts[2] {
		return Unknown
	}
	img, ok := s.images[id]
	switch {
	case !ok || img.Owner.String() != parts[1]:
		return MediaOrphanImage
	case img.Status == "PROCESSING":
		return MediaInFlight
	case img.Status != "READY":
		return MediaOrphanImage
	case !s.inUse[img.ImageKey] && (img.Purpose != "POST" || s.postRefsKnown):
		return ImageUnreferenced
	}
	return MediaImage
}

// ClassifyRaw judges one object of the raw bucket.
func (s *Snapshot) ClassifyRaw(key string, modified, now time.Time, minAge time.Duration) Category {
	if now.Sub(modified) < minAge {
		return Recent
	}
	parts := strings.Split(key, "/")
	if len(parts) < 3 {
		return Unknown
	}
	if _, err := uuid.Parse(parts[0]); err != nil {
		return Unknown
	}
	if len(parts) == 3 && parts[1] == "images" {
		iid, err := uuid.Parse(parts[2])
		if err != nil {
			return Unknown
		}
		img, ok := s.images[iid]
		switch {
		case !ok || img.Owner.String() != parts[0]:
			return RawOrphanImage
		case img.Status == "READY" || img.Status == "FAILED":
			return RawImageProcessed
		default:
			return RawImageLive
		}
	}
	id, err := uuid.Parse(parts[1])
	if err != nil || id.String() != parts[1] {
		return Unknown
	}
	v, ok := s.videos[id]
	switch {
	case len(parts) == 3 && parts[2] == "source":
		if !ok || v.Owner.String() != parts[0] {
			return RawOrphanVideo
		}
		return RawSource
	case len(parts) == 5 && parts[2] == "audio" && parts[4] == "source":
		if !ok {
			return RawOrphanVideo
		}
		tid, err := uuid.Parse(parts[3])
		if err != nil {
			return Unknown
		}
		status, ok := v.audioByID[tid]
		switch {
		case !ok:
			return RawOrphanAudio
		case status == "READY":
			return RawAudioProcessed
		default:
			return RawAudioLive
		}
	}
	return Unknown
}
