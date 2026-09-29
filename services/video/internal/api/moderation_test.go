package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/libs/go/ids"
)

// --- PUT /v1/videos/{id}/moderation (task A2) ------------------------------------

func moderationPathOf(id string) string { return "/v1/videos/" + id + "/moderation" }

func hide(reason string) string {
	b, _ := json.Marshal(map[string]string{"state": "HIDDEN", "reason": reason})
	return string(b)
}

const visible = `{"state":"VISIBLE"}`

// rawVideo decodes a video response into a map, to check which keys are present.
func rawVideo(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestModerateRoleMatrix(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	p := moderationPathOf(v.ID.String())

	if w := e.req(anon, "PUT", p, hide("spam")); w.Code != 401 {
		t.Errorf("anonymous: %d", w.Code)
	}
	for name, u := range map[string]*who{"viewer": bob, "owner (creator)": alice} {
		w := e.req(u, "PUT", p, hide("spam"))
		if w.Code != 403 || problemCode(t, w) != "FORBIDDEN" {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	// The role check comes first: a non-moderator learns nothing about which ids exist.
	if w := e.req(bob, "PUT", moderationPathOf(ids.NewString()), hide("spam")); w.Code != 403 {
		t.Errorf("unknown video as viewer: %d", w.Code)
	}
	if len(e.store.moderated) != 0 {
		t.Fatal("a forbidden request changed something")
	}
	for name, u := range map[string]*who{"moderator": mod, "admin": admin} {
		if w := e.req(u, "PUT", p, hide("spam")); w.Code != 200 {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
		e.req(u, "PUT", p, visible)
	}
}

func TestModerateValidation(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	p := moderationPathOf(v.ID.String())
	for name, body := range map[string]string{
		"empty body":          ``,
		"not json":            `nope`,
		"missing state":       `{"reason":"x"}`,
		"unknown state":       `{"state":"DELETED","reason":"x"}`,
		"lower case state":    `{"state":"hidden","reason":"x"}`,
		"HIDDEN, no reason":   `{"state":"HIDDEN"}`,
		"HIDDEN, empty":       `{"state":"HIDDEN","reason":""}`,
		"HIDDEN, blank":       `{"state":"HIDDEN","reason":"   \n"}`,
		"reason too long":     hide(strings.Repeat("x", 501)),
		"unknown field":       `{"state":"HIDDEN","reason":"x","extra":1}`,
		"state is not string": `{"state":1}`,
	} {
		w := e.req(mod, "PUT", p, body)
		if w.Code != 400 || problemCode(t, w) == "" {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	if len(e.store.moderated) != 0 {
		t.Fatal("an invalid request changed something")
	}
	// Boundaries: 500 characters (counted as characters, not bytes) is fine.
	if w := e.req(mod, "PUT", p, hide(strings.Repeat("é", 500))); w.Code != 200 {
		t.Errorf("500 characters: %d %s", w.Code, w.Body)
	}
	// VISIBLE ignores a reason that was sent along.
	w := e.req(mod, "PUT", p, `{"state":"VISIBLE","reason":"ignored"}`)
	out := decode[videoJSON](t, w)
	if w.Code != 200 || out.Moderation == nil || out.Moderation.State != "VISIBLE" || out.Moderation.Reason != nil {
		t.Errorf("VISIBLE: %d %s", w.Code, w.Body)
	}
	if w := e.req(mod, "PUT", moderationPathOf(ids.NewString()), hide("x")); w.Code != 404 {
		t.Errorf("unknown video: %d", w.Code)
	}
	if w := e.req(mod, "PUT", moderationPathOf("not-a-uuid"), hide("x")); w.Code != 404 {
		t.Errorf("bad id: %d", w.Code)
	}
}

func TestModerateStateChangesAndNoOps(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	p := moderationPathOf(v.ID.String())

	// A video that was never moderated is VISIBLE: restoring it is a no-op.
	if w := e.req(mod, "PUT", p, visible); w.Code != 200 || len(e.store.moderated) != 0 {
		t.Fatalf("VISIBLE on a visible video: %d, events %d", w.Code, len(e.store.moderated))
	}

	w := e.req(mod, "PUT", p, hide("  copyright claim  "))
	out := decode[videoJSON](t, w)
	if w.Code != 200 || out.Moderation == nil || out.Moderation.State != "HIDDEN" ||
		out.Moderation.Reason == nil || *out.Moderation.Reason != "copyright claim" || out.Moderation.ModeratedAt == nil {
		t.Fatalf("hide: %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "private, no-store" {
		t.Errorf("Cache-Control %q", w.Header().Get("Cache-Control"))
	}
	if len(e.store.moderated) != 1 || e.store.moderated[0].State != "HIDDEN" ||
		e.store.moderated[0].ModeratorID != mod.id.String() || e.store.moderated[0].OwnerID != alice.id.String() {
		t.Fatalf("events %+v", e.store.moderated)
	}

	// The same state again, even with another reason and another moderator: 200, nothing changes, no event.
	w = e.req(admin, "PUT", p, hide("another reason"))
	out = decode[videoJSON](t, w)
	if w.Code != 200 || *out.Moderation.Reason != "copyright claim" || len(e.store.moderated) != 1 {
		t.Fatalf("no-op: %d %s events %d", w.Code, w.Body, len(e.store.moderated))
	}

	w = e.req(admin, "PUT", p, visible)
	out = decode[videoJSON](t, w)
	if w.Code != 200 || out.Moderation.State != "VISIBLE" || out.Moderation.Reason != nil || len(e.store.moderated) != 2 ||
		e.store.moderated[1].State != "VISIBLE" || e.store.moderated[1].ModeratorID != admin.id.String() {
		t.Fatalf("restore: %d %s events %+v", w.Code, w.Body, e.store.moderated)
	}
	e.req(mod, "PUT", p, visible)
	if len(e.store.moderated) != 2 {
		t.Fatalf("restoring twice emitted an event: %+v", e.store.moderated)
	}
}

func TestHiddenVideoVisibilityMatrix(t *testing.T) {
	e := newEnv(t, false)
	v := e.video(alice)
	vp := "/v1/videos/" + v.ID.String()

	// VISIBLE: everyone sees the video, only the owner/moderator/admin get `moderation`.
	for name, u := range map[string]*who{"anon": anon, "viewer": bob, "owner": alice, "moderator": mod, "admin": admin} {
		w := e.req(u, "GET", vp, "")
		if w.Code != 200 {
			t.Fatalf("%s: %d", name, w.Code)
		}
		_, has := rawVideo(t, w.Body.Bytes())["moderation"]
		if want := u == alice || u == mod || u == admin; has != want {
			t.Errorf("VISIBLE, %s: moderation present = %v, want %v", name, has, want)
		}
	}

	e.req(mod, "PUT", moderationPathOf(v.ID.String()), hide("hate speech"))

	for name, u := range map[string]*who{"anon": anon, "viewer": bob} {
		w := e.req(u, "GET", vp, "")
		if w.Code != 404 || problemCode(t, w) != "NOT_FOUND" {
			t.Errorf("HIDDEN, %s: %d %s", name, w.Code, w.Body)
		}
		if strings.Contains(w.Body.String(), "hate speech") {
			t.Errorf("the reason leaked to %s", name)
		}
	}
	for name, u := range map[string]*who{"owner": alice, "moderator": mod, "admin": admin} {
		w := e.req(u, "GET", vp, "")
		out := decode[videoJSON](t, w)
		if w.Code != 200 || out.Moderation == nil || out.Moderation.State != "HIDDEN" ||
			out.Moderation.Reason == nil || *out.Moderation.Reason != "hate speech" {
			t.Errorf("HIDDEN, %s: %d %s", name, w.Code, w.Body)
		}
		if cc := w.Header().Get("Cache-Control"); cc != "private, no-store" {
			t.Errorf("HIDDEN, %s: Cache-Control %q (a hidden video must never be cached publicly)", name, cc)
		}
	}
	// The owner can still edit it; the response keeps showing the moderation.
	w := e.req(alice, "PATCH", vp, `{"title":"new title"}`)
	if out := decode[videoJSON](t, w); w.Code != 200 || out.Moderation == nil || out.Moderation.State != "HIDDEN" {
		t.Errorf("PATCH by the owner: %d %s", w.Code, w.Body)
	}
	// Restored: public again, and `moderation` disappears for outsiders.
	e.req(mod, "PUT", moderationPathOf(v.ID.String()), visible)
	w = e.req(anon, "GET", vp, "")
	if _, has := rawVideo(t, w.Body.Bytes())["moderation"]; w.Code != 200 || has || w.Header().Get("Cache-Control") != "public, max-age=30" {
		t.Errorf("restored: %d moderation=%v cache=%q", w.Code, has, w.Header().Get("Cache-Control"))
	}
}

func TestHiddenVideoIsNotListed(t *testing.T) {
	e := newEnv(t, false)
	shown := e.video(alice)
	hidden := e.video(alice)
	other := e.video(bob)
	e.req(mod, "PUT", moderationPathOf(hidden.ID.String()), hide("spam"))

	listed := func(path string) []string {
		var got []string
		for _, it := range decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", path, "")).Items {
			got = append(got, it.ID)
		}
		return got
	}
	for _, path := range []string{"/v1/videos", "/v1/videos?owner_id=" + alice.id.String()} {
		got := listed(path)
		for _, id := range got {
			if id == hidden.ID.String() {
				t.Errorf("%s lists the hidden video", path)
			}
		}
		if len(got) == 0 || (path == "/v1/videos" && len(got) != 2) {
			t.Errorf("%s: %v (expected %s and %s)", path, got, shown.ID, other.ID)
		}
	}
	// Even the owner's channel feed skips it (the studio is where they see it).
	for _, it := range decode[pageJSON[summaryJSON]](t, e.req(alice, "GET", "/v1/videos?owner_id="+alice.id.String(), "")).Items {
		if it.ID == hidden.ID.String() {
			t.Error("the owner's channel lists the hidden video")
		}
	}

	page := decode[pageJSON[studioJSON]](t, e.req(alice, "GET", "/v1/studio/videos", ""))
	seen := map[string]*moderationJSON{}
	for _, it := range page.Items {
		seen[it.ID] = it.Moderation
	}
	if m := seen[hidden.ID.String()]; m == nil || m.State != "HIDDEN" || m.Reason == nil || *m.Reason != "spam" {
		t.Errorf("studio, hidden video: %+v", m)
	}
	if m := seen[shown.ID.String()]; m == nil || m.State != "VISIBLE" || m.Reason != nil {
		t.Errorf("studio, visible video: %+v", m)
	}

	e.req(mod, "PUT", moderationPathOf(hidden.ID.String()), visible)
	found := false
	for _, it := range decode[pageJSON[summaryJSON]](t, e.req(anon, "GET", "/v1/videos", "")).Items {
		found = found || it.ID == hidden.ID.String()
	}
	if !found {
		t.Error("a restored video is listed again")
	}
}

func TestModerationInvalidatesTheCache(t *testing.T) {
	e := newEnv(t, true)
	v := e.video(alice)
	vp := "/v1/videos/" + v.ID.String()
	if w := e.req(anon, "GET", vp, ""); w.Code != 200 { // fills the cache
		t.Fatal(w.Code)
	}
	if w := e.req(anon, "GET", vp, ""); w.Code != 200 || e.cache.hits == 0 {
		t.Fatalf("not cached: %d hits %d", w.Code, e.cache.hits)
	}
	before := e.cache.inval
	e.req(mod, "PUT", moderationPathOf(v.ID.String()), hide("spam"))
	if e.cache.inval != before+1 {
		t.Fatalf("the cache was not invalidated (%d -> %d)", before, e.cache.inval)
	}
	if w := e.req(anon, "GET", vp, ""); w.Code != 404 {
		t.Errorf("a cached copy of the video survived the hide: %d", w.Code)
	}
	// And a cached hidden video is still hidden from outsiders (visibility is applied after the cache).
	if w := e.req(alice, "GET", vp, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := e.req(bob, "GET", vp, ""); w.Code != 404 {
		t.Errorf("the owner's read filled the cache and leaked the video: %d", w.Code)
	}
}
