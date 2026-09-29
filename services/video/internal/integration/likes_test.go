package integration

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/cache"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/likes"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// These tests run the like consumer against real NATS JetStream (stream SOCIAL
// from the contract), real PostgreSQL and a Valkey-protocol cache (miniredis).

type likeStack struct {
	pg    *testkit.Postgres
	nats  *testkit.NATS
	cache *cache.Valkey
	mr    *miniredis.Miniredis
	stop  context.CancelFunc
}

func startLikes(t *testing.T, mutate func(*likes.Consumer)) *likeStack {
	t.Helper()
	s := &likeStack{pg: testkit.StartPostgres(t), nats: testkit.StartNATS(t), mr: miniredis.RunT(t)}
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	c, err := cache.New("redis://"+s.mr.Addr(), 30*time.Second, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	s.cache = c
	cons := &likes.Consumer{JS: s.nats.JS, Store: &store.Postgres{Pool: s.pg.Pool}, Cache: c, Log: log,
		RetryEvery: 100 * time.Millisecond, RetryDelay: 10 * time.Millisecond}
	if mutate != nil {
		mutate(cons)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.stop = cancel
	t.Cleanup(cancel)
	go func() { _ = cons.Run(ctx) }()
	return s
}

// publish sends a social.video.like_changed event built like social-svc would
// (envelope + data), after validating it against the contract schemas.
func (s *likeStack) publish(t *testing.T, video uuid.UUID, liked bool, count int64) {
	t.Helper()
	outbox.SetProducer("social-svc")
	_, payload, err := outbox.BuildEnvelope(context.Background(), likes.Subject, map[string]any{
		"video_id": video.String(), "user_id": ids.NewString(), "liked": liked, "like_count": count,
	})
	if err != nil {
		t.Fatal(err)
	}
	validateEvent(t, "social.video.like_changed", payload)
	if _, err := s.nats.JS.Publish(context.Background(), likes.Subject, payload); err != nil {
		t.Fatal(err)
	}
}

func (s *likeStack) likeCount(t *testing.T, id uuid.UUID) int64 {
	t.Helper()
	var n int64
	if err := s.pg.Pool.QueryRow(context.Background(), `SELECT like_count FROM media.videos WHERE id=$1`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func waitFor(t *testing.T, d time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *likeStack) consumerInfo(t *testing.T) *jetstream.ConsumerInfo {
	t.Helper()
	c, err := s.nats.JS.Consumer(context.Background(), likes.Stream, likes.Durable)
	if err != nil {
		t.Fatal(err)
	}
	info, err := c.Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func TestLikeCountFollowsEventsAndInvalidatesTheCache(t *testing.T) {
	s := startLikes(t, nil)
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID})
	other := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID})

	// Both videos are cached; only the liked one may lose its entry.
	ctx := context.Background()
	s.cache.Set(ctx, domain.Video{ID: v.ID, Title: "cached"})
	s.cache.Set(ctx, domain.Video{ID: other.ID, Title: "cached"})

	s.publish(t, v.ID, true, 5)
	waitFor(t, 15*time.Second, "like_count = 5", func() bool { return s.likeCount(t, v.ID) == 5 })
	if _, ok := s.cache.Get(ctx, v.ID); ok {
		t.Error("the cache entry of the liked video survived")
	}
	if _, ok := s.cache.Get(ctx, other.ID); !ok {
		t.Error("the cache entry of another video was invalidated")
	}

	// Absolute values: up, down (un-like), and the same event delivered twice.
	s.publish(t, v.ID, true, 9)
	s.publish(t, v.ID, false, 8)
	s.publish(t, v.ID, false, 8)
	waitFor(t, 15*time.Second, "like_count = 8", func() bool { return s.likeCount(t, v.ID) == 8 })
	waitFor(t, 15*time.Second, "all events acknowledged", func() bool {
		i := s.consumerInfo(t)
		return i.NumPending == 0 && i.NumAckPending == 0
	})
	if s.likeCount(t, v.ID) != 8 || s.likeCount(t, other.ID) != 0 {
		t.Fatalf("counts: %d / %d", s.likeCount(t, v.ID), s.likeCount(t, other.ID))
	}
	info := s.consumerInfo(t)
	if info.Config.Durable != "video-likes" || info.Config.FilterSubject != "social.video.like_changed" ||
		info.Config.AckPolicy != jetstream.AckExplicitPolicy || info.Config.AckWait != 30*time.Second || info.Config.MaxDeliver != 5 {
		t.Fatalf("consumer config: %+v", info.Config)
	}
}

// A burst of events for one video must be applied in order: the last one wins.
func TestBurstIsAppliedInOrder(t *testing.T) {
	s := startLikes(t, nil)
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID})
	const n = 150
	for i := 1; i <= n; i++ {
		s.publish(t, v.ID, true, int64(i))
	}
	waitFor(t, 30*time.Second, "like_count = 150", func() bool { return s.likeCount(t, v.ID) == n })
	waitFor(t, 15*time.Second, "all acknowledged", func() bool { return s.consumerInfo(t).NumAckPending == 0 && s.consumerInfo(t).NumPending == 0 })
	if got := s.likeCount(t, v.ID); got != n {
		t.Fatalf("final like_count %d, want %d (events applied out of order?)", got, n)
	}
}

func TestUnknownVideoAndPoisonMessagesDoNotBlockTheQueue(t *testing.T) {
	s := startLikes(t, nil)
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID})
	ctx := context.Background()

	s.publish(t, uuid.New(), true, 3) // a video that does not exist here
	for _, raw := range []string{
		`garbage`,
		`{"event_id":"x","type":"social.video.like_changed","version":1,"occurred_at":"2026-10-02T11:01:00Z","producer":"social-svc","data":{"video_id":"nope","user_id":"u","liked":true,"like_count":1}}`,
		`{"event_id":"x","type":"social.video.like_changed","version":1,"occurred_at":"2026-10-02T11:01:00Z","producer":"social-svc","data":{"video_id":"` + v.ID.String() + `","user_id":"u","liked":true,"like_count":-4}}`,
	} {
		if _, err := s.nats.JS.PublishMsg(ctx, &nats.Msg{Subject: likes.Subject, Data: []byte(raw)}); err != nil {
			t.Fatal(err)
		}
	}
	s.publish(t, v.ID, true, 11) // the message behind them must still be applied

	waitFor(t, 15*time.Second, "like_count = 11", func() bool { return s.likeCount(t, v.ID) == 11 })
	waitFor(t, 15*time.Second, "queue drained", func() bool {
		i := s.consumerInfo(t)
		return i.NumPending == 0 && i.NumAckPending == 0
	})
	// Poison messages are terminated, not redelivered.
	time.Sleep(time.Second)
	if info := s.consumerInfo(t); info.NumRedelivered != 0 || info.NumAckPending != 0 {
		t.Fatalf("poison messages were redelivered: %+v", info)
	}
	if s.likeCount(t, v.ID) != 11 {
		t.Fatal("a poison message changed the count")
	}
}

// video-svc must start (and keep serving) before social-svc exists: the SOCIAL
// stream may not be there yet, and the consumer picks it up once it is.
func TestConsumerWaitsForTheStream(t *testing.T) {
	s := startLikes(t, nil) // the testkit created SOCIAL; remove it to mimic "C1 not deployed"
	ctx := context.Background()
	if err := s.nats.JS.DeleteStream(ctx, likes.Stream); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond) // the consumer notices and starts retrying
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID})

	for _, sc := range testkit.Streams() {
		if sc.Name == likes.Stream {
			if _, err := s.nats.JS.CreateStream(ctx, sc); err != nil {
				t.Fatal(err)
			}
		}
	}
	s.publish(t, v.ID, true, 7)
	waitFor(t, 20*time.Second, "like_count = 7 after the stream appeared", func() bool { return s.likeCount(t, v.ID) == 7 })
}

// Database trouble must not lose or reorder a message: it is retried in-process,
// and after the attempts it is Nak'd and redelivered.
func TestDatabaseOutageIsRetried(t *testing.T) {
	s := startLikes(t, func(c *likes.Consumer) {
		c.Attempts = 2
		c.NakDelay = 500 * time.Millisecond
	})
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID})
	ctx := context.Background()

	// Make the update fail: a rejecting constraint on this column.
	if _, err := s.pg.Pool.Exec(ctx, `ALTER TABLE media.videos ADD CONSTRAINT like_count_frozen CHECK (like_count = 0) NOT VALID`); err != nil {
		t.Fatal(err)
	}
	s.publish(t, v.ID, true, 4)
	waitFor(t, 15*time.Second, "the message is being redelivered", func() bool { return s.consumerInfo(t).NumRedelivered > 0 })
	if s.likeCount(t, v.ID) != 0 {
		t.Fatal("applied despite the failure")
	}
	// The outage ends: the redelivery is applied.
	if _, err := s.pg.Pool.Exec(ctx, `ALTER TABLE media.videos DROP CONSTRAINT like_count_frozen`); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 30*time.Second, "like_count = 4 after recovery", func() bool { return s.likeCount(t, v.ID) == 4 })
}
