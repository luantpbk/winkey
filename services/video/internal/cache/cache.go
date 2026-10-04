// Package cache implements the optional Valkey read cache of GET /v1/videos/{id}.
//
// It stores the viewer-independent record; visibility is applied by the API
// after reading, so one cached entry serves every viewer. It fails open: any
// cache error is a miss, and a cache outage never breaks a request. Entries
// live for a short TTL (30 s) and are invalidated in-process on PATCH/DELETE;
// other replicas see the change when their entry expires.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// breakerFor is how long reads and writes skip the cache after an error, so an
// outage costs one short timeout per interval instead of one per request.
const breakerFor = 5 * time.Second

// Valkey is a domain.Cache on Valkey (Redis protocol).
type Valkey struct {
	client    *redis.Client
	ttl       time.Duration
	log       *slog.Logger
	downUntil atomic.Int64 // unix nanoseconds; Get/Set are skipped until then
}

// NewClient builds a Valkey client with the settings the service needs: short
// timeouts (a cache or counter must never make a request slower than the database)
// and no client-side retries (with the server down they multiply the latency).
// It connects lazily. Share one client between the cache and the view counter.
func NewClient(url string) (*redis.Client, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	opt.DialTimeout, opt.ReadTimeout, opt.WriteTimeout = 200*time.Millisecond, 200*time.Millisecond, 200*time.Millisecond
	opt.MaxRetries = -1
	return redis.NewClient(opt), nil
}

// New connects lazily to the server at url (redis://host:port/db) with its own client.
func New(url string, ttl time.Duration, log *slog.Logger) (*Valkey, error) {
	client, err := NewClient(url)
	if err != nil {
		return nil, err
	}
	return FromClient(client, ttl, log), nil
}

// FromClient wraps an existing client (see NewClient). Close closes it.
func FromClient(client *redis.Client, ttl time.Duration, log *slog.Logger) *Valkey {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &Valkey{client: client, ttl: ttl, log: log}
}

func key(id uuid.UUID) string { return "video:v1:" + id.String() }

// tripped records an error and opens the breaker.
func (c *Valkey) tripped(ctx context.Context, op string, err error) {
	if c.downUntil.Swap(time.Now().Add(breakerFor).UnixNano()) < time.Now().UnixNano() {
		c.log.WarnContext(ctx, "cache unavailable; bypassing it for a few seconds", "op", op, "error", err)
	}
}

func (c *Valkey) open() bool { return time.Now().UnixNano() < c.downUntil.Load() }

func (c *Valkey) Get(ctx context.Context, id uuid.UUID) (domain.Video, bool) {
	if c.open() {
		return domain.Video{}, false
	}
	raw, err := c.client.Get(ctx, key(id)).Bytes()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			c.tripped(ctx, "get", err)
		}
		return domain.Video{}, false
	}
	var v domain.Video
	if json.Unmarshal(raw, &v) != nil {
		return domain.Video{}, false
	}
	return v, true
}

func (c *Valkey) Set(ctx context.Context, v domain.Video) {
	if c.open() {
		return
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	if err := c.client.Set(ctx, key(v.ID), raw, c.ttl).Err(); err != nil {
		c.tripped(ctx, "set", err)
	}
}

// Invalidate always tries the server (it is rare: PATCH/DELETE) so an entry
// cannot outlive an edit longer than its TTL just because the breaker is open.
func (c *Valkey) Invalidate(ctx context.Context, id uuid.UUID) {
	if err := c.client.Del(ctx, key(id)).Err(); err != nil {
		c.log.WarnContext(ctx, "cache invalidate failed; the entry expires with its TTL", "error", err)
	}
}

// Ping is the readiness check.
func (c *Valkey) Ping(ctx context.Context) error { return c.client.Ping(ctx).Err() }

// Close releases the connection pool.
func (c *Valkey) Close() error { return c.client.Close() }

// Related caches the final JSON of GET /v1/videos/{id}/related (task R2-c). Same fail-open rules as Valkey.
type Related struct {
	client    *redis.Client
	log       *slog.Logger
	downUntil atomic.Int64
}

// NewRelated wraps a client (see NewClient).
func NewRelated(client *redis.Client, log *slog.Logger) *Related {
	return &Related{client: client, log: log}
}

func (c *Related) open() bool { return time.Now().UnixNano() < c.downUntil.Load() }

func (c *Related) tripped(ctx context.Context, op string, err error) {
	if c.downUntil.Swap(time.Now().Add(breakerFor).UnixNano()) < time.Now().UnixNano() {
		c.log.WarnContext(ctx, "related cache unavailable; bypassing it for a few seconds", "op", op, "error", err)
	}
}

// GetRelated returns the stored body; any error is a miss.
func (c *Related) GetRelated(ctx context.Context, key string) ([]byte, bool) {
	if c.open() {
		return nil, false
	}
	raw, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			c.tripped(ctx, "get", err)
		}
		return nil, false
	}
	return raw, true
}

// SetRelated stores the body for ttl; errors are ignored (the next request recomputes).
func (c *Related) SetRelated(ctx context.Context, key string, body []byte, ttl time.Duration) {
	if c.open() {
		return
	}
	if err := c.client.Set(ctx, key, body, ttl).Err(); err != nil {
		c.tripped(ctx, "set", err)
	}
}
