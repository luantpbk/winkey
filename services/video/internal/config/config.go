// Package config defines the video-svc configuration.
package config

import (
	"errors"
	"time"

	libconfig "github.com/luantpbk/winkey/libs/go/config"
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

	// CursorSecret signs pagination cursors so tampering is detected (min 16 bytes).
	CursorSecret string `env:"CURSOR_SECRET,required"`

	// ValkeyURL enables the GET /v1/videos/{id} cache; empty = disabled.
	ValkeyURL string        `env:"VALKEY_URL"`
	CacheTTL  time.Duration `env:"CACHE_TTL" default:"30s"`
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
	return nil
}
