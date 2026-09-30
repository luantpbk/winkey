package integration

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// SEC1-a on real PostgreSQL 17: mediaAccess and the signed URLs over the whole matrix
// status x visibility x moderation x owner. Every response is checked against video.v1.yaml.

const (
	linkSecret = "integration-media-link-secret-0123456789"
	signedFrom = "/s/"
)

type mediaStack struct {
	t    *testing.T
	pg   *testkit.Postgres
	h    http.Handler
	spec *contract.Spec
	now  time.Time
}

func startMedia(t *testing.T) *mediaStack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	h := &api.Handler{Store: &store.Postgres{Pool: pg.Pool}, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("integration-cursor-secret"), Log: log,
		MediaLinkSecret: []byte(linkSecret), Now: func() time.Time { return now }}
	r := httpx.NewRouter("video-media-it", log)
	h.Routes(r)
	return &mediaStack{t: t, pg: pg, h: r, spec: contract.Load(t), now: now}
}

func (s *mediaStack) do(a *actor, path string) (int, http.Header, []byte) {
	s.t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	if a != nil {
		req.Header.Set("X-User-Id", a.id.String())
		req.Header.Set("X-User-Roles", a.roles)
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	p, _, _ := strings.Cut(path, "?")
	switch {
	case strings.HasPrefix(p, "/internal/media-access/"):
		p = "/internal/media-access/{video_id}"
	case strings.HasPrefix(p, "/v1/videos/"):
		p = "/v1/videos/{video_id}"
	}
	s.spec.Check(s.t, "GET", p, w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w.Code, w.Header(), w.Body.Bytes()
}

type mediaRow struct {
	id           string
	label        string
	status       string
	visibility   string
	hidden       bool
	ownerActive  bool
	owner        testutil.User
	publicMedia  bool // expected mediaAccess answer: written out, not derived from the code under test
	hasPlayback  bool
	signedNeeded bool
}

func TestMediaAccessAndSignedURLsOverTheWholeMatrix(t *testing.T) {
	s := startMedia(t)
	active := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	suspended := testutil.SeedUser(t, s.pg.Pool, "ghost", nil, "SUSPENDED")
	deleted := testutil.SeedUser(t, s.pg.Pool, "gone", nil, "DELETED")

	var rows []mediaRow
	for _, status := range []string{"READY", "PROCESSING"} {
		for _, vis := range []string{"PUBLIC", "UNLISTED", "PRIVATE"} {
			for _, hidden := range []bool{false, true} {
				for _, o := range []struct {
					u      testutil.User
					active bool
				}{{active, true}, {suspended, false}, {deleted, false}} {
					v := testutil.Video{Owner: o.u.ID, Status: status, Visibility: vis, Hidden: hidden, Storyboard: status == "READY"}
					if status == "PROCESSING" {
						v.Attempts = []float32{20}
					}
					r := mediaRow{
						status: status, visibility: vis, hidden: hidden, ownerActive: o.active, owner: o.u,
						label: fmt.Sprintf("%s/%s/hidden=%v/owner %s", status, vis, hidden, o.u.Status),
					}
					r.id = testutil.SeedVideo(t, s.pg.Pool, v).ID.String()
					r.publicMedia = status == "READY" && (vis == "PUBLIC" || vis == "UNLISTED") && !hidden && o.active
					r.hasPlayback = status == "READY"
					r.signedNeeded = r.hasPlayback && !r.publicMedia
					rows = append(rows, r)
				}
			}
		}
	}
	if len(rows) != 36 {
		t.Fatalf("matrix has %d rows", len(rows))
	}
	mod := &actor{testutil.SeedUser(t, s.pg.Pool, "moddy", nil, "").ID, "viewer,moderator"}
	admin := &actor{testutil.SeedUser(t, s.pg.Pool, "root", nil, "").ID, "admin"}
	owner := &actor{active.ID, "viewer,creator"}

	public, denied := 0, 0
	for _, r := range rows {
		// mediaAccess: 204 / 403, no body, cached 30 s; identity headers change nothing.
		for _, a := range []*actor{nil, owner, admin} {
			code, hdr, body := s.do(a, "/internal/media-access/"+r.id)
			want := http.StatusForbidden
			if r.publicMedia {
				want = http.StatusNoContent
			}
			if code != want || len(body) != 0 || hdr.Get("Cache-Control") != "max-age=30" {
				t.Errorf("%s: mediaAccess %d (want %d) body=%q cc=%q", r.label, code, want, body, hdr.Get("Cache-Control"))
			}
		}
		if r.publicMedia {
			public++
		} else {
			denied++
		}

		// GET /v1/videos/{id} as everybody allowed to see it: signed URLs exactly when not public.
		viewers := []*actor{mod, admin}
		if r.ownerActive {
			viewers = append(viewers, owner)
		}
		for _, a := range viewers {
			code, hdr, body := s.do(a, "/v1/videos/"+r.id)
			if code != 200 {
				t.Errorf("%s: GET by id %d %s", r.label, code, body)
				continue
			}
			v := js[struct {
				Playback *struct {
					HLSURL        string     `json:"hls_url"`
					ThumbnailURL  string     `json:"thumbnail_url"`
					StoryboardURL *string    `json:"storyboard_url"`
					ExpiresAt     *time.Time `json:"expires_at"`
				} `json:"playback"`
			}](t, body)
			if (v.Playback != nil) != r.hasPlayback {
				t.Errorf("%s: playback presence %v", r.label, v.Playback != nil)
				continue
			}
			if v.Playback == nil {
				continue
			}
			// V5a: the storyboard follows hls_url, plain or signed.
			if sb := v.Playback.StoryboardURL; sb == nil || strings.Contains(*sb, signedFrom) != r.signedNeeded ||
				!strings.HasSuffix(*sb, "/v/"+r.id+"/a1/storyboard/storyboard.vtt") {
				t.Errorf("%s / %s: storyboard_url %v, want signed=%v", r.label, a.roles, sb, r.signedNeeded)
			}
			signed := strings.Contains(v.Playback.HLSURL, signedFrom)
			if signed != r.signedNeeded || strings.Contains(v.Playback.ThumbnailURL, signedFrom) != r.signedNeeded || (v.Playback.ExpiresAt != nil) != r.signedNeeded {
				t.Errorf("%s / %s: signed=%v want %v (%+v)", r.label, a.roles, signed, r.signedNeeded, v.Playback)
			}
			if r.signedNeeded {
				if !v.Playback.ExpiresAt.Equal(s.now.Add(6 * time.Hour)) {
					t.Errorf("%s: expires_at %v", r.label, v.Playback.ExpiresAt)
				}
				if !strings.HasPrefix(v.Playback.HLSURL, mediaBase+"/s/") || !strings.Contains(v.Playback.HLSURL, "/v/"+r.id+"/") ||
					!strings.HasSuffix(v.Playback.HLSURL, "/master.m3u8") {
					t.Errorf("%s: %s", r.label, v.Playback.HLSURL)
				}
				if hdr.Get("Cache-Control") != "private, no-store" {
					t.Errorf("%s: Cache-Control %q on signed URLs", r.label, hdr.Get("Cache-Control"))
				}
			} else if !strings.HasPrefix(v.Playback.HLSURL, mediaBase+"/v/"+r.id+"/") {
				t.Errorf("%s: plain URL %s", r.label, v.Playback.HLSURL)
			}
		}
	}
	if public != 2 || denied != 34 { // only READY, PUBLIC or UNLISTED, VISIBLE, active owner: 2 of 36
		t.Errorf("public=%d denied=%d", public, denied)
	}

	// Unknown and malformed ids.
	if code, _, _ := s.do(nil, "/internal/media-access/00000000-0000-7000-8000-00000000dead"); code != 403 {
		t.Errorf("unknown id: %d", code)
	}
	if code, _, _ := s.do(nil, "/internal/media-access/nope"); code != 400 {
		t.Errorf("malformed id: %d", code)
	}

	// The studio (the owner's own list): thumbnails are signed exactly when not publicly watchable.
	seen := 0
	cursor := ""
	for {
		path := "/v1/studio/videos?limit=100"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		code, _, body := s.do(owner, path)
		if code != 200 {
			t.Fatalf("studio %d %s", code, body)
		}
		p := js[struct {
			Items []struct {
				ID           string  `json:"id"`
				ThumbnailURL *string `json:"thumbnail_url"`
			} `json:"items"`
			NextCursor *string `json:"next_cursor"`
		}](t, body)
		for _, it := range p.Items {
			for _, r := range rows {
				if r.id != it.ID {
					continue
				}
				seen++
				if r.hasPlayback != (it.ThumbnailURL != nil) {
					t.Errorf("studio %s: thumbnail %v", r.label, it.ThumbnailURL)
				} else if it.ThumbnailURL != nil && strings.Contains(*it.ThumbnailURL, signedFrom) != r.signedNeeded {
					t.Errorf("studio %s: signed=%v want %v", r.label, strings.Contains(*it.ThumbnailURL, signedFrom), r.signedNeeded)
				}
			}
		}
		if p.NextCursor == nil {
			break
		}
		cursor = *p.NextCursor
	}
	if seen != 12 { // the 12 rows owned by alice
		t.Errorf("studio listed %d of alice's 12 videos", seen)
	}
}
