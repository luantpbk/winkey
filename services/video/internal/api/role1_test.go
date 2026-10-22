package api

import (
	"context"
	"testing"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// ROLE1 (ADR-046): an owner without the creator role (a new viewer-only account,
// or a creator whose role was revoked) cannot manage videos, but can still
// delete their own.
func TestManagingVideosNeedsCreatorRole(t *testing.T) {
	e := newEnv(t, false)
	viewerOnly := &who{ids.New(), "viewer"}
	v := e.audioVideo(viewerOnly)
	track := e.store.addTrack(v.ID, domain.AudioTrack{Lang: "vi", Label: "Thuyết minh", Kind: "voiceover",
		Status: domain.StatusReady})
	unknown := domain.Video{ID: ids.New()}

	calls := []struct{ method, path, body string }{
		{"PATCH", "/v1/videos/" + v.ID.String(), `{"title":"x"}`},
		{"PUT", subPath(v, "vi"), "WEBVTT\n"},
		{"PATCH", subPath(v, "vi"), `{"label":"x"}`},
		{"DELETE", subPath(v, "vi"), ""},
		{"GET", audioPath(v, ""), ""},
		{"PATCH", audioPath(v, "/"+track.ID.String()), `{"label":"x"}`},
		{"DELETE", audioPath(v, "/"+track.ID.String()), ""},
		{"GET", "/v1/studio/videos", ""},
		{"GET", statsPath(v, ""), ""},
		{"GET", "/v1/studio/stats", ""},
		// The roles header answers before anything is read: a missing video looks the same.
		{"PATCH", "/v1/videos/" + unknown.ID.String(), `{"title":"x"}`},
		{"GET", statsPath(unknown, ""), ""},
	}
	for _, c := range calls {
		w := e.req(viewerOnly, c.method, c.path, c.body)
		if w.Code != 403 || problemCode(t, w) != "CREATOR_ROLE_REQUIRED" {
			t.Errorf("%s %s: %d %s", c.method, c.path, w.Code, w.Body)
		}
	}
	if got, _ := e.store.GetVideo(context.Background(), v.ID); got.Title != v.Title {
		t.Fatalf("the video changed: %q", got.Title)
	}

	// Deleting your own video needs no creator role.
	if w := e.req(viewerOnly, "DELETE", "/v1/videos/"+v.ID.String(), ""); w.Code != 204 {
		t.Fatalf("owner delete: %d %s", w.Code, w.Body)
	}
}
