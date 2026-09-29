package domain

import (
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
)

// Viewer is the caller as seen by the visibility rules. The zero value is an
// anonymous viewer.
type Viewer struct {
	Authed bool
	ID     uuid.UUID
	Roles  []string
}

// ViewerFrom builds a Viewer from the gateway identity.
func ViewerFrom(id httpx.Identity, ok bool) Viewer {
	if !ok {
		return Viewer{}
	}
	return Viewer{Authed: true, ID: id.UserID, Roles: id.Roles}
}

// Privileged reports whether the viewer is a moderator or admin (they see and
// may delete everything).
func (v Viewer) Privileged() bool {
	if !v.Authed {
		return false
	}
	return httpx.Identity{UserID: v.ID, Roles: v.Roles}.HasRole(httpx.RoleModerator)
}

// Owns reports whether the viewer owns the video.
func (v Viewer) Owns(video Video) bool { return v.Authed && v.ID == video.OwnerID }

// CanView applies the visibility rules of video.v1.yaml:
//   - the owner, moderators and admins see every video in every status;
//   - everyone else sees only READY videos: PUBLIC and UNLISTED by id,
//     PRIVATE never (the caller then gets 404, not 403);
//   - videos of owners who are no longer ACTIVE are hidden from everyone else.
func CanView(video Video, viewer Viewer) bool {
	if viewer.Owns(video) || viewer.Privileged() {
		return true
	}
	if video.Status != StatusReady || video.Visibility == VisPrivate {
		return false
	}
	return !video.Owner.Missing
}

// IsPublicReady reports whether the video is PUBLIC and READY: the only case
// in which the response may be cached publicly.
func IsPublicReady(video Video) bool {
	return video.Status == StatusReady && video.Visibility == VisPublic
}
