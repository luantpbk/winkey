package cache

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

func TestRecommendationCacheExpiryCorruptionAndOutage(t *testing.T) {
	mr := miniredis.RunT(t)
	client, err := NewClient("redis://" + mr.Addr())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	c := NewRecommended(client, quiet())
	ctx := context.Background()
	key := "reco:test-user:test-list"
	list := domain.RecommendationList{IDs: []uuid.UUID{uuid.New(), uuid.New()}, Mode: "personal"}
	c.SetRecommendation(ctx, key, list, 10*time.Minute)
	if got, ok := c.GetRecommendation(ctx, key); !ok || !reflect.DeepEqual(got, list) {
		t.Fatal("cache roundtrip differs")
	}
	if mr.TTL(key) != 10*time.Minute {
		t.Fatal("TTL differs")
	}
	mr.FastForward(10 * time.Minute)
	if _, ok := c.GetRecommendation(ctx, key); ok {
		t.Fatal("expired cache hit")
	}
	for _, bad := range []domain.RecommendationList{
		{IDs: []uuid.UUID{uuid.Nil}, Mode: "fallback"},
		{IDs: []uuid.UUID{list.IDs[0], list.IDs[0]}, Mode: "personal"},
		{IDs: list.IDs, Mode: "anonymous"},
		{IDs: make([]uuid.UUID, 201), Mode: "fallback"},
	} {
		raw, err := json.Marshal(bad)
		if err != nil {
			t.Fatal(err)
		}
		if err := mr.Set(key, string(raw)); err != nil {
			t.Fatal(err)
		}
		if _, ok := c.GetRecommendation(ctx, key); ok {
			t.Fatal("corrupted list accepted")
		}
	}
	if err := mr.Set(key, "not-json"); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.GetRecommendation(ctx, key); ok {
		t.Fatal("invalid JSON accepted")
	}
	mr.Close()
	if _, ok := c.GetRecommendation(ctx, key); ok {
		t.Fatal("cache outage was not a miss")
	}
	if !c.cache.open() {
		t.Fatal("cache outage did not open breaker")
	}
	c.SetRecommendation(ctx, key, list, 10*time.Minute) // fail open, never returns an error to the handler.
}
