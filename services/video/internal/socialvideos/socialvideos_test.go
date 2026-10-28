package socialvideos

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

var (
	author = uuid.MustParse("0192f5e0-0000-7000-8000-0000000000a1")
	video  = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d")
	post   = uuid.MustParse("019a2f10-0000-7000-8000-0000000000d1")
)

type call struct {
	op            string
	video, author uuid.UUID
	bucket        string
}

type fakeStore struct {
	calls   []call
	found   bool
	err     error
	batches [][]uuid.UUID // returned by successive DeleteUnattachedSocialVideos calls
	limits  []int
}

func (s *fakeStore) AttachSocialVideo(_ context.Context, v, a uuid.UUID) (bool, error) {
	s.calls = append(s.calls, call{"attach", v, a, ""})
	return s.found, s.err
}

func (s *fakeStore) ReleaseSocialVideo(_ context.Context, v, a uuid.UUID, bucket string) (bool, error) {
	s.calls = append(s.calls, call{"release", v, a, bucket})
	return s.found, s.err
}

func (s *fakeStore) DeleteUnattachedSocialVideos(_ context.Context, olderThan time.Duration, limit int, _ string) ([]uuid.UUID, error) {
	if olderThan != 48*time.Hour {
		return nil, errors.New("unexpected max age " + olderThan.String())
	}
	s.limits = append(s.limits, limit)
	if s.err != nil {
		return nil, s.err
	}
	if len(s.batches) == 0 {
		return nil, nil
	}
	b := s.batches[0]
	s.batches = s.batches[1:]
	return b, nil
}

type fakeCache struct{ invalidated []uuid.UUID }

func (c *fakeCache) Get(context.Context, uuid.UUID) (domain.Video, bool) {
	return domain.Video{}, false
}
func (c *fakeCache) Set(context.Context, domain.Video) {}
func (c *fakeCache) Invalidate(_ context.Context, id uuid.UUID) {
	c.invalidated = append(c.invalidated, id)
}

var discard = slog.New(slog.NewJSONHandler(io.Discard, nil))

func event(typ string, version int, data string) []byte {
	return []byte(`{"event_id":"0192f5f0-6666-7000-8000-000000000007","type":"` + typ + `","version":` +
		strconv.Itoa(version) + `,"occurred_at":"2026-10-28T11:01:00Z","producer":"social-svc","data":` + data + `}`)
}

func data(v, a string) string {
	return `{"post_id":"` + post.String() + `","video_id":"` + v + `","author_id":"` + a + `"}`
}

func TestProcess(t *testing.T) {
	good := data(video.String(), author.String())
	for _, c := range []struct {
		name        string
		payload     []byte
		found       bool
		err         error
		want        Action
		wantCall    string
		invalidated bool
	}{
		{"attached", event(SubjectAttached, 1, good), true, nil, ActionAck, "attach", false},
		{"attached, no such video", event(SubjectAttached, 1, good), false, nil, ActionAck, "attach", false},
		{"released", event(SubjectReleased, 1, good), true, nil, ActionAck, "release", true},
		{"released again", event(SubjectReleased, 1, good), false, nil, ActionAck, "release", false},
		{"database down", event(SubjectReleased, 1, good), false, errors.New("db down"), ActionRetry, "release", false},
		{"unknown version", event(SubjectAttached, 2, good), false, nil, ActionAck, "", false},
		{"other subject", event("social.video.like_changed", 1, good), false, nil, ActionTerm, "", false},
		{"not json", []byte(`nope`), false, nil, ActionTerm, "", false},
		{"bad video id", event(SubjectAttached, 1, data("nope", author.String())), false, nil, ActionTerm, "", false},
		{"missing author", event(SubjectAttached, 1, `{"post_id":"`+post.String()+`","video_id":"`+video.String()+`"}`), false, nil, ActionTerm, "", false},
		{"data not an object", event(SubjectReleased, 1, `[1]`), false, nil, ActionTerm, "", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			st, cache := &fakeStore{found: c.found, err: c.err}, &fakeCache{}
			cons := &Consumer{Store: st, Cache: cache, MediaBucket: "winkey-media", Log: discard}
			if got := cons.Process(context.Background(), c.payload); got != c.want {
				t.Fatalf("action %v, want %v", got, c.want)
			}
			switch {
			case c.wantCall == "" && len(st.calls) != 0:
				t.Fatalf("store called: %+v", st.calls)
			case c.wantCall != "":
				want := call{c.wantCall, video, author, ""}
				if c.wantCall == "release" {
					want.bucket = "winkey-media"
				}
				if len(st.calls) != 1 || st.calls[0] != want {
					t.Fatalf("calls %+v, want %+v", st.calls, want)
				}
			}
			if got := len(cache.invalidated) == 1 && cache.invalidated[0] == video; got != c.invalidated {
				t.Fatalf("invalidated %v", cache.invalidated)
			}
		})
	}
}

func TestJanitorDrainsInBatches(t *testing.T) {
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	st, cache := &fakeStore{batches: [][]uuid.UUID{{a, b}, {c}}}, &fakeCache{}
	j := &Janitor{Store: st, Cache: cache, Log: discard, Batch: 2}
	n, err := j.RunOnce(context.Background())
	if err != nil || n != 3 {
		t.Fatalf("deleted %d, err %v", n, err)
	}
	if len(st.limits) != 2 || st.limits[0] != 2 { // a short batch ends the run
		t.Fatalf("calls with limits %v", st.limits)
	}
	if len(cache.invalidated) != 3 {
		t.Fatalf("invalidated %v", cache.invalidated)
	}

	st = &fakeStore{err: errors.New("db down")}
	if _, err := (&Janitor{Store: st, Log: discard}).RunOnce(context.Background()); err == nil || st.limits[0] != 100 {
		t.Fatalf("err %v, limits %v", err, st.limits)
	}
}
