package integration

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Task PL1-v on real PostgreSQL 17: GET /v1/videos/batch with the real visibility rules; every response is
// validated against video.v1.yaml (batchGetVideos / VideoBatch).

type batchItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func batchGet(t *testing.T, s *stack, a *actor, vids ...uuid.UUID) (int, string, []string) {
	t.Helper()
	var q []string
	for _, v := range vids {
		q = append(q, v.String())
	}
	code, h, b := s.do(a, "GET", "/v1/videos/batch?ids="+strings.Join(q, ","), "")
	if code != 200 {
		return code, h.Get("Cache-Control"), nil
	}
	out := []string{}
	for _, it := range js[struct {
		Items []batchItem `json:"items"`
	}](t, b).Items {
		out = append(out, it.ID)
	}
	return code, h.Get("Cache-Control"), out
}

func TestBatchOnPostgresKeepsOrderAndAppliesVisibility(t *testing.T) {
	s := start(t)
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	bob := testutil.SeedUser(t, s.pg.Pool, "bob", nil, "")
	ghost := testutil.SeedUser(t, s.pg.Pool, "ghost", nil, "SUSPENDED")
	pub := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID}).ID
	pub2 := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: bob.ID}).ID
	unlisted := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID, Visibility: "UNLISTED"}).ID
	private := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID, Visibility: "PRIVATE"}).ID
	hidden := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID, Hidden: true}).ID
	proc := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID, Status: "PROCESSING", Attempts: []float32{5}}).ID
	orphan := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: ghost.ID}).ID
	unknown := ids.New()
	ask := []uuid.UUID{pub2, private, unknown, pub, hidden, proc, orphan, unlisted}

	aliceA := &actor{alice.ID, "viewer,creator"}
	bobA := &actor{bob.ID, "viewer,creator"}
	admin := &actor{ids.New(), "admin"}
	for name, c := range map[string]struct {
		a    *actor
		want []uuid.UUID
		cc   string
	}{
		"anonymous": {nil, []uuid.UUID{pub2, pub, unlisted}, "public, max-age=30"},
		"other":     {bobA, []uuid.UUID{pub2, pub, unlisted}, "private, no-store"},
		"owner":     {aliceA, []uuid.UUID{pub2, private, pub, hidden, unlisted}, "private, no-store"},
		"admin":     {admin, []uuid.UUID{pub2, private, pub, hidden, orphan, unlisted}, "private, no-store"},
	} {
		code, cc, got := batchGet(t, s, c.a, ask...)
		var want []string
		for _, w := range c.want {
			want = append(want, w.String())
		}
		if code != 200 || cc != c.cc || strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s: %d %q\n got %v\nwant %v", name, code, cc, got, want)
		}
	}
	// getVideo and the batch agree on every id, for the owner and for the anonymous caller.
	for _, a := range []*actor{nil, aliceA} {
		_, _, in := batchGet(t, s, a, ask...)
		seen := map[string]bool{}
		for _, id := range in {
			seen[id] = true
		}
		for _, id := range ask {
			code, _, _ := s.do(a, "GET", "/v1/videos/"+id.String(), "")
			want := code == 200 && id != proc // getVideo also shows the owner their PROCESSING video; the batch is READY only
			if want != seen[id.String()] {
				t.Errorf("video %s: getVideo %d, in batch %v", id, code, seen[id.String()])
			}
		}
	}
	if code, _, _ := batchGet(t, s, nil, pub, pub); code != 400 {
		t.Fatalf("duplicate ids: %d", code)
	}
}
