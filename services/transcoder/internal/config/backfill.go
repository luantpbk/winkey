package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	libconfig "github.com/luantpbk/winkey/libs/go/config"
)

// Limits of the storyboard backfill CLI (task V5a-b).
const (
	BackfillMaxLimit       = 10_000
	BackfillMaxConcurrency = 4
)

// Backfill is the configuration of cmd/storyboard-backfill: the same database, object storage,
// scratch and ffmpeg variables as the worker, without NATS (the CLI publishes nothing), plus
// its own limits.
type Backfill struct {
	LogLevel string `env:"LOG_LEVEL" default:"info"`

	DatabaseURL string `env:"DATABASE_URL,required"`

	S3Endpoint    string `env:"S3_ENDPOINT,required"`
	S3Region      string `env:"S3_REGION" default:"garage"`
	S3AccessKeyID string `env:"S3_ACCESS_KEY_ID,required"`
	S3SecretKey   string `env:"S3_SECRET_ACCESS_KEY,required"`
	S3MediaBucket string `env:"S3_MEDIA_BUCKET" default:"winkey-media"`

	ScratchDir string `env:"SCRATCH_DIR"` // default: <os temp dir>/winkey-scratch
	FFmpegPath string `env:"FFMPEG_PATH,required"`

	Limit       int `env:"BACKFILL_LIMIT" default:"100"`
	Concurrency int `env:"BACKFILL_CONCURRENCY" default:"1"`
}

// LoadBackfill reads and validates the environment.
func LoadBackfill() (Backfill, error) { return LoadBackfillFrom(os.LookupEnv) }

// LoadBackfillFrom is LoadBackfill with an explicit lookup function (used by tests).
func LoadBackfillFrom(lookup func(string) (string, bool)) (Backfill, error) {
	var c Backfill
	if err := libconfig.LoadFrom(&c, lookup); err != nil {
		return c, err
	}
	var errs []error
	if c.Limit < 1 || c.Limit > BackfillMaxLimit {
		errs = append(errs, fmt.Errorf("BACKFILL_LIMIT must be between 1 and %d", BackfillMaxLimit))
	}
	if c.Concurrency < 1 || c.Concurrency > BackfillMaxConcurrency {
		errs = append(errs, fmt.Errorf("BACKFILL_CONCURRENCY must be between 1 and %d", BackfillMaxConcurrency))
	}
	if len(errs) > 0 {
		return c, errors.Join(errs...)
	}
	if c.ScratchDir == "" {
		c.ScratchDir = filepath.Join(os.TempDir(), "winkey-scratch")
	}
	return c, nil
}
