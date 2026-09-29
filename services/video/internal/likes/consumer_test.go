package likes

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

type fakeStore struct {
	mu      sync.Mutex
	counts  map[uuid.UUID]int64
	calls   int
	failFor int // the first N calls fail
	err     error
}

func newStore(ids ...uuid.UUID) *fakeStore {
	s := &fakeStore{counts: map[uuid.UUID]int64{}, err: errors.New("db down")}
	for _, id := range ids {
		s.counts[id] = 0
	}
	return s
}

func (s *fakeStore) SetLikeCount(_ context.Context, id uuid.UUID, count int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.failFor > 0 {
		s.failFor--
		return false, s.err
	}
	cur, ok := s.counts[id]
	if !ok || cur == count {
		return false, nil
	}
	s.counts[id] = count
	return true, nil
}

type fakeCache struct {
	mu          sync.Mutex
	invalidated []uuid.UUID
}

func (c *fakeCache) Get(context.Context, uuid.UUID) (domain.Video, bool) {
	return domain.Video{}, false
}
func (c *fakeCache) Set(context.Context, domain.Video) {}
func (c *fakeCache) Invalidate(_ context.Context, id uuid.UUID) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.invalidated = append(c.invalidated, id)
}

func consumer(s Store, c domain.Cache) *Consumer {
	return &Consumer{Store: s, Cache: c, Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		Attempts: 3, RetryDelay: time.Millisecond}
}

var vid = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d")

func event(typ string, version int, data string) []byte {
	return []byte(`{"event_id":"0192f5f0-6666-7000-8000-000000000007","type":"` + typ + `","version":` +
		json.Number(itoa(version)).String() + `,"occurred_at":"2026-10-02T11:01:00Z","producer":"social-svc","data":` + data + `}`)
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func likeData(video string, liked string, count string) string {
	return `{"video_id":"` + video + `","user_id":"0192f5e0-0000-7000-8000-000000000002","liked":` + liked + `,"like_count":` + count + `}`
}

func TestAppliesAbsoluteCountAndInvalidatesTheCache(t *testing.T) {
	st, ca := newStore(vid), &fakeCache{}
	c := consumer(st, ca)

	if a := c.Process(context.Background(), event(Subject, 1, likeData(vid.String(), "true", "42"))); a != ActionAck {
		t.Fatalf("action %v", a)
	}
	if st.counts[vid] != 42 || len(ca.invalidated) != 1 || ca.invalidated[0] != vid {
		t.Fatalf("count=%d invalidated=%v", st.counts[vid], ca.invalidated)
	}
	// SET, not increment: a lower absolute count (an un-like) lowers the number.
	c.Process(context.Background(), event(Subject, 1, likeData(vid.String(), "false", "41")))
	if st.counts[vid] != 41 {
		t.Fatalf("count %d, want 41", st.counts[vid])
	}
	// The same event again (redelivery) changes nothing and does not touch the cache.
	inv := len(ca.invalidated)
	c.Process(context.Background(), event(Subject, 1, likeData(vid.String(), "false", "41")))
	if st.counts[vid] != 41 || len(ca.invalidated) != inv {
		t.Fatalf("redelivery: count=%d invalidations %d -> %d", st.counts[vid], inv, len(ca.invalidated))
	}
	// Zero and huge counts are valid.
	c.Process(context.Background(), event(Subject, 1, likeData(vid.String(), "false", "0")))
	c.Process(context.Background(), event(Subject, 1, likeData(vid.String(), "true", "9007199254740993")))
	if st.counts[vid] != 9007199254740993 {
		t.Fatalf("large count: %d", st.counts[vid])
	}
}

func TestUnknownVideoIsAckedWithoutCacheWork(t *testing.T) {
	st, ca := newStore(), &fakeCache{}
	if a := consumer(st, ca).Process(context.Background(), event(Subject, 1, likeData(vid.String(), "true", "3"))); a != ActionAck {
		t.Fatalf("action %v: an event for a deleted video must not be retried forever", a)
	}
	if len(ca.invalidated) != 0 {
		t.Fatal("invalidated the cache for a video that does not exist here")
	}
}

func TestPoisonMessagesAreTerminated(t *testing.T) {
	st := newStore(vid)
	c := consumer(st, nil)
	v := vid.String()
	cases := map[string][]byte{
		"not json":            []byte("nope"),
		"empty":               nil,
		"wrong type":          event("social.comment.created", 1, likeData(v, "true", "1")),
		"data not an object":  event(Subject, 1, `"x"`),
		"missing video_id":    event(Subject, 1, `{"user_id":"u","liked":true,"like_count":1}`),
		"video_id not uuid":   event(Subject, 1, likeData("not-a-uuid", "true", "1")),
		"video_id urn form":   event(Subject, 1, likeData("urn:uuid:"+v, "true", "1")),
		"video_id braces":     event(Subject, 1, likeData("{"+v+"}", "true", "1")),
		"missing like_count":  event(Subject, 1, `{"video_id":"`+v+`","user_id":"u","liked":true}`),
		"negative like_count": event(Subject, 1, likeData(v, "true", "-1")),
		"fractional count":    event(Subject, 1, likeData(v, "true", "1.5")),
		"string count":        event(Subject, 1, likeData(v, "true", `"5"`)),
		"missing liked":       event(Subject, 1, `{"video_id":"`+v+`","user_id":"u","like_count":1}`),
	}
	for name, payload := range cases {
		if a := c.Process(context.Background(), payload); a != ActionTerm {
			t.Errorf("%s: action %v, want Term", name, a)
		}
	}
	if st.calls != 0 || st.counts[vid] != 0 {
		t.Fatalf("poison messages reached the store (%d calls)", st.calls)
	}
}

func TestUnknownVersionIsIgnoredNotTerminated(t *testing.T) {
	st := newStore(vid)
	if a := consumer(st, nil).Process(context.Background(), event(Subject, 2, likeData(vid.String(), "true", "9"))); a != ActionAck {
		t.Fatalf("action %v", a)
	}
	if st.calls != 0 {
		t.Fatal("applied an event of a version this consumer does not know")
	}
}

func TestExtraFieldsAreTolerated(t *testing.T) {
	st := newStore(vid)
	data := `{"video_id":"` + vid.String() + `","user_id":"u","liked":true,"like_count":5,"future_field":{"a":1}}`
	if a := consumer(st, nil).Process(context.Background(), event(Subject, 1, data)); a != ActionAck || st.counts[vid] != 5 {
		t.Fatalf("action %v count %d", a, st.counts[vid])
	}
}

// Transient database errors are retried in-process so the message is not Nak'd
// (a Nak'd message is redelivered after newer ones, which could move the
// absolute count backwards).
func TestTransientErrorsAreRetriedInProcess(t *testing.T) {
	st, ca := newStore(vid), &fakeCache{}
	st.failFor = 2
	if a := consumer(st, ca).Process(context.Background(), event(Subject, 1, likeData(vid.String(), "true", "7"))); a != ActionAck {
		t.Fatalf("action %v", a)
	}
	if st.calls != 3 || st.counts[vid] != 7 || len(ca.invalidated) != 1 {
		t.Fatalf("calls=%d count=%d invalidated=%d", st.calls, st.counts[vid], len(ca.invalidated))
	}
}

func TestPersistentErrorAsksForARetryAndKeepsTheCache(t *testing.T) {
	st, ca := newStore(vid), &fakeCache{}
	st.failFor = 100
	if a := consumer(st, ca).Process(context.Background(), event(Subject, 1, likeData(vid.String(), "true", "7"))); a != ActionRetry {
		t.Fatalf("action %v", a)
	}
	if st.calls != 3 || len(ca.invalidated) != 0 || st.counts[vid] != 0 {
		t.Fatalf("calls=%d invalidated=%d count=%d", st.calls, len(ca.invalidated), st.counts[vid])
	}
}

func TestCancelledContextStopsRetrying(t *testing.T) {
	st := newStore(vid)
	st.failFor = 100
	c := consumer(st, nil)
	c.RetryDelay = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	done := make(chan Action, 1)
	go func() { done <- c.Process(ctx, event(Subject, 1, likeData(vid.String(), "true", "7"))) }()
	select {
	case a := <-done:
		if a != ActionRetry {
			t.Fatalf("action %v", a)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Process did not return after the context was cancelled")
	}
}

// The example in contracts/events/examples is the shape social-svc will send.
func TestContractExampleIsApplied(t *testing.T) {
	dir, _ := os.Getwd()
	var raw []byte
	for i := 0; i < 8; i++ {
		if b, err := os.ReadFile(filepath.Join(dir, "contracts", "events", "examples", "social.video.like_changed.json")); err == nil {
			raw = b
			break
		}
		dir = filepath.Dir(dir)
	}
	if raw == nil {
		t.Fatal("contract example not found")
	}
	var env struct {
		Data struct {
			VideoID   string `json:"video_id"`
			LikeCount int64  `json:"like_count"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &env)
	id := uuid.MustParse(env.Data.VideoID)
	st := newStore(id)
	if a := consumer(st, nil).Process(context.Background(), raw); a != ActionAck || st.counts[id] != env.Data.LikeCount || env.Data.LikeCount != 42 {
		t.Fatalf("action %v count %d", a, st.counts[id])
	}
}
