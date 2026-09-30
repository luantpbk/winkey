// Package config defines the video-svc configuration.
package config

import (
	"errors"
	"fmt"
	"time"

	libconfig "github.com/luantpbk/winkey/libs/go/config"
	"github.com/luantpbk/winkey/services/video/internal/views"
)

// Config is loaded from the environment; see the README for the table.
type Config struct {
	HTTPAddr string `env:"HTTP_ADDR" default:":8080"`
	LogLevel string `env:"LOG_LEVEL" default:"info"`

	DatabaseURL string `env:"DATABASE_URL,required"`
	NATSURL     string `env:"NATS_URL,required"`

	// MediaBaseURL prefixes object keys in playback, thumbnail and avatar URLs,
	// e.g. https://media.winkey.vn
	MediaBaseURL string `env:"MEDIA_BASE_URL,required"`
	MediaBucket  string `env:"S3_MEDIA_BUCKET" default:"winkey-media"` // named in video.deleted

	// MediaLinkSecret signs media URLs of videos the public cannot watch (ADR-017). It is
	// shared with the nginx of media.winkey.vn; at least 32 bytes; never logged.
	MediaLinkSecret string `env:"MEDIA_LINK_SECRET,required"`

	// Object storage (Garage, ADR-004): video-svc writes and deletes subtitle files (task V5b) in
	// S3_MEDIA_BUCKET. Server-side calls only, so there is no public endpoint.
	S3Endpoint        string `env:"S3_ENDPOINT,required"`
	S3Region          string `env:"S3_REGION" default:"garage"`
	S3AccessKeyID     string `env:"S3_ACCESS_KEY_ID,required"`
	S3SecretAccessKey string `env:"S3_SECRET_ACCESS_KEY,required"`

	// CursorSecret signs pagination cursors so tampering is detected (min 16 bytes).
	CursorSecret string `env:"CURSOR_SECRET,required"`

	// ValkeyURL enables the GET /v1/videos/{id} cache; empty = disabled.
	ValkeyURL string        `env:"VALKEY_URL"`
	CacheTTL  time.Duration `env:"CACHE_TTL" default:"30s"`

	// View counter (C3). Needs VALKEY_URL; without it views are not counted.
	TrustProxyCIDRs   []string      `env:"TRUST_PROXY_CIDRS" default:"10.42.0.0/16,127.0.0.1"`
	ViewFlushInterval time.Duration `env:"VIEW_FLUSH_INTERVAL" default:"30s"`
	ViewFlushLockTTL  time.Duration `env:"VIEW_FLUSH_LOCK_TTL" default:"2m"`
	ViewDedupTTL      time.Duration `env:"VIEW_DEDUP_TTL" default:"30m"`
	ViewRateLimit     int           `env:"VIEW_RATE_LIMIT" default:"60"`

	// Search (SR1): requests per client IP per minute. Needs VALKEY_URL.
	SearchRateLimit  int `env:"SEARCH_RATE_LIMIT" default:"60"`
	SuggestRateLimit int `env:"SUGGEST_RATE_LIMIT" default:"120"`
}

// Load reads and validates the environment.
func Load() (Config, error) {
	var c Config
	if err := libconfig.Load(&c); err != nil {
		return c, err
	}
	return c, c.Validate()
}

// Validate checks values that the loader cannot.
func (c Config) Validate() error {
	if len(c.CursorSecret) < 16 {
		return errors.New("CURSOR_SECRET must be at least 16 characters")
	}
	if len(c.MediaLinkSecret) < 32 {
		return errors.New("MEDIA_LINK_SECRET must be at least 32 bytes")
	}
	if _, err := views.ParseCIDRs(c.TrustProxyCIDRs); err != nil {
		return fmt.Errorf("TRUST_PROXY_CIDRS: %w", err)
	}
	if c.ViewFlushInterval <= 0 || c.ViewFlushLockTTL <= 0 || c.ViewDedupTTL <= 0 || c.ViewRateLimit <= 0 {
		return errors.New("VIEW_FLUSH_INTERVAL, VIEW_FLUSH_LOCK_TTL, VIEW_DEDUP_TTL and VIEW_RATE_LIMIT must be positive")
	}
	if c.SearchRateLimit <= 0 || c.SuggestRateLimit <= 0 {
		return errors.New("SEARCH_RATE_LIMIT and SUGGEST_RATE_LIMIT must be positive")
	}
	return nil
}
