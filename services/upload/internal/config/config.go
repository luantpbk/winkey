// Package config defines the upload service configuration.
package config

import (
	"errors"
	"fmt"
	"time"

	libconfig "github.com/luantpbk/winkey/libs/go/config"
)

// Config is loaded from the environment; see the README for the table.
type Config struct {
	HTTPAddr    string `env:"HTTP_ADDR" default:":8080"`
	LogLevel    string `env:"LOG_LEVEL" default:"info"`
	DatabaseURL string `env:"DATABASE_URL,required"`
	NATSURL     string `env:"NATS_URL,required"`

	S3Endpoint       string `env:"S3_ENDPOINT,required"`
	S3PublicEndpoint string `env:"S3_PUBLIC_ENDPOINT,required"`
	S3Region         string `env:"S3_REGION" default:"garage"`
	S3AccessKeyID    string `env:"S3_ACCESS_KEY_ID,required"`
	S3SecretKey      string `env:"S3_SECRET_ACCESS_KEY,required"`
	S3RawBucket      string `env:"S3_RAW_BUCKET" default:"winkey-raw"`

	JanitorInterval time.Duration `env:"JANITOR_INTERVAL" default:"10m"`
	StaleAfter      time.Duration `env:"UPLOAD_STALE_AFTER" default:"24h"`

	// Upload quotas (UQ1, ADR-027), per owner; role admin is exempt.
	MaxConcurrent int   `env:"UPLOAD_MAX_CONCURRENT" default:"3"`        // 1..50
	DailyCount    int   `env:"UPLOAD_DAILY_COUNT" default:"20"`          // 1..10000
	DailyBytes    int64 `env:"UPLOAD_DAILY_BYTES" default:"53687091200"` // >= 20 GiB: one max-size file always fits
}

// Quota limits (inclusive ranges).
const (
	MaxConcurrentMax = 50
	DailyCountMax    = 10000
	DailyBytesMin    = 20 << 30 // partsize.MaxSize
)

// Load reads and validates the environment.
func Load() (Config, error) {
	var c Config
	if err := libconfig.Load(&c); err != nil {
		return c, err
	}
	return c, c.Validate()
}

// Validate checks the ranges that the env tags cannot express.
func (c Config) Validate() error {
	var errs []error
	if c.MaxConcurrent < 1 || c.MaxConcurrent > MaxConcurrentMax {
		errs = append(errs, fmt.Errorf("UPLOAD_MAX_CONCURRENT must be between 1 and %d", MaxConcurrentMax))
	}
	if c.DailyCount < 1 || c.DailyCount > DailyCountMax {
		errs = append(errs, fmt.Errorf("UPLOAD_DAILY_COUNT must be between 1 and %d", DailyCountMax))
	}
	if c.DailyBytes < DailyBytesMin {
		errs = append(errs, fmt.Errorf("UPLOAD_DAILY_BYTES must be at least %d (20 GiB, so one maximum-size file always fits)", int64(DailyBytesMin)))
	}
	return errors.Join(errs...)
}
