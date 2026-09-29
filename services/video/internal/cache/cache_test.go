package cache

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

func quiet() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func sample() domain.Video {
	dur := 1000
	pub := time.Date(2026, 10, 1, 8, 0, 0, 123456000, time.UTC)
	key := "v/x/a1/hls/master.m3u8"
	return domain.Video{
		ID: uuid.New(), OwnerID: uuid.New(), Title: "t", Visibility: domain.VisPublic, Status: domain.StatusReady,
		DurationMs: &dur, PublishedAt: &pub, CreatedAt: pub, HLSMasterKey: &key, ThumbnailKey: &key,
		Owner:      domain.Profile{Handle: "alice", DisplayName: "Alice"},
		Renditions: []domain.Rendition{{Name: "720p", Width: 1280, Height: 720, BitrateKbps: 2800}},
	}
}

func TestRoundTripSetGetInvalidate(t *testing.T) {
	mr := miniredis.RunT(t)
	c, err := New("redis://"+mr.Addr(), 30*time.Second, quiet())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx := context.Background()
	v := sample()

	if _, ok := c.Get(ctx, v.ID); ok {
		t.Fatal("hit on an empty cache")
	}
	c.Set(ctx, v)
	got, ok := c.Get(ctx, v.ID)
	if !ok || got.ID != v.ID || got.Title != "t" || !got.PublishedAt.Equal(*v.PublishedAt) ||
		len(got.Renditions) != 1 || got.Owner.Handle != "alice" || *got.HLSMasterKey != *v.HLSMasterKey {
		t.Fatalf("round trip: %+v ok=%v", got, ok)
	}
	if ttl := mr.TTL("video:v1:" + v.ID.String()); ttl <= 0 || ttl > 30*time.Second {
		t.Fatalf("ttl %v", ttl)
	}
	c.Invalidate(ctx, v.ID)
	if _, ok := c.Get(ctx, v.ID); ok {
		t.Fatal("entry survived Invalidate")
	}
}

func TestEntriesExpire(t *testing.T) {
	mr := miniredis.RunT(t)
	c, _ := New("redis://"+mr.Addr(), 30*time.Second, quiet())
	defer c.Close()
	v := sample()
	c.Set(context.Background(), v)
	mr.FastForward(31 * time.Second)
	if _, ok := c.Get(context.Background(), v.ID); ok {
		t.Fatal("entry did not expire after the TTL")
	}
}

// A cache outage must never break a request nor slow it down: after the first
// failure the cache is bypassed for a few seconds.
func TestFailsOpenAndFastWhenValkeyIsDown(t *testing.T) {
	mr := miniredis.RunT(t)
	c, _ := New("redis://"+mr.Addr(), 30*time.Second, quiet())
	defer c.Close()
	mr.Close()
	ctx := context.Background()
	v := sample()

	if _, ok := c.Get(ctx, v.ID); ok { // first failure opens the breaker (bounded by the 200ms timeouts)
		t.Fatal("hit while down")
	}
	start := time.Now()
	for i := 0; i < 200; i++ { // 200 more requests while the breaker is open
		c.Set(ctx, v)
		if _, ok := c.Get(ctx, v.ID); ok {
			t.Fatal("hit while down")
		}
	}
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Fatalf("200 requests took %v with the cache down; the breaker is not working", d)
	}
	if err := c.Ping(ctx); err == nil {
		t.Fatal("Ping must report the outage")
	}
}

func TestFirstFailureIsBounded(t *testing.T) {
	mr := miniredis.RunT(t)
	c, _ := New("redis://"+mr.Addr(), 30*time.Second, quiet())
	defer c.Close()
	mr.Close()
	start := time.Now()
	c.Get(context.Background(), uuid.New())
	c.Invalidate(context.Background(), uuid.New())
	if d := time.Since(start); d > time.Second {
		t.Fatalf("one Get + one Invalidate on a dead server took %v (no client retries expected)", d)
	}
}

func TestRecoversAfterTheBreakerCloses(t *testing.T) {
	mr := miniredis.RunT(t)
	c, _ := New("redis://"+mr.Addr(), 30*time.Second, quiet())
	defer c.Close()
	ctx := context.Background()
	v := sample()
	c.downUntil.Store(time.Now().Add(-time.Second).UnixNano()) // breaker already expired
	c.Set(ctx, v)
	if _, ok := c.Get(ctx, v.ID); !ok {
		t.Fatal("cache does not work after the breaker interval")
	}
}

func TestCorruptEntryIsAMiss(t *testing.T) {
	mr := miniredis.RunT(t)
	c, _ := New("redis://"+mr.Addr(), 30*time.Second, quiet())
	defer c.Close()
	id := uuid.New()
	if err := mr.Set("video:v1:"+id.String(), "{not json"); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Get(context.Background(), id); ok {
		t.Fatal("corrupt entry treated as a hit")
	}
}

func TestBadURL(t *testing.T) {
	if _, err := New("not a url", time.Second, quiet()); err == nil {
		t.Fatal("expected an error")
	}
}
