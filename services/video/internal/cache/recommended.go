package cache

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/redis/go-redis/v9"
)

// Recommended shares the short deadlines and fail-open breaker of Related without sharing keys.
type Recommended struct{ cache *Related }

func NewRecommended(client *redis.Client, log *slog.Logger) *Recommended {
	return &Recommended{cache: NewRelated(client, log)}
}

func (c *Recommended) GetRecommendation(ctx context.Context, key string) (domain.RecommendationList, bool) {
	raw, ok := c.cache.GetRelated(ctx, key)
	var list domain.RecommendationList
	if !ok || json.Unmarshal(raw, &list) != nil || len(list.IDs) > 200 || (list.Mode != "personal" && list.Mode != "fallback") {
		return domain.RecommendationList{}, false
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range list.IDs {
		if id == uuid.Nil || seen[id] {
			return domain.RecommendationList{}, false
		}
		seen[id] = true
	}
	return list, true
}

func (c *Recommended) SetRecommendation(ctx context.Context, key string, list domain.RecommendationList, ttl time.Duration) {
	raw, err := json.Marshal(list)
	if err == nil {
		c.cache.SetRelated(ctx, key, raw, ttl)
	}
}
