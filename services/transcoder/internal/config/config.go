// Package config defines the transcoder configuration.
package config

import (
	"os"
	"path/filepath"
	"time"

	libconfig "github.com/luantpbk/winkey/libs/go/config"
)

// Config is loaded from the environment; see the README for the table.
type Config struct {
	HTTPAddr string `env:"HTTP_ADDR" default:":8081"`
	LogLevel string `env:"LOG_LEVEL" default:"info"`

	DatabaseURL string `env:"DATABASE_URL,required"`
	NATSURL     string `env:"NATS_URL,required"`

	S3Endpoint    string `env:"S3_ENDPOINT,required"`
	S3Region      string `env:"S3_REGION" default:"garage"`
	S3AccessKeyID string `env:"S3_ACCESS_KEY_ID,required"`
	S3SecretKey   string `env:"S3_SECRET_ACCESS_KEY,required"`
	S3RawBucket   string `env:"S3_RAW_BUCKET" default:"winkey-raw"`
	S3MediaBucket string `env:"S3_MEDIA_BUCKET" default:"winkey-media"`

	// WorkerConcurrency 0 means automatic: 2 for nvenc (GeForce allows about 8
	// NVENC sessions and each job uses 3), 1 for x264 (it already uses every core).
	WorkerConcurrency int    `env:"WORKER_CONCURRENCY"`
	Encoder           string `env:"ENCODER" default:"auto"` // auto | nvenc | x264
	X264Preset        string `env:"X264_PRESET" default:"veryfast"`

	ScratchDir  string `env:"SCRATCH_DIR"` // default: <os temp dir>/winkey-scratch
	ArchiveDir  string `env:"ARCHIVE_DIR"` // optional raw archive
	FFmpegPath  string `env:"FFMPEG_PATH" default:"ffmpeg"`
	FFprobePath string `env:"FFPROBE_PATH" default:"ffprobe"`

	UploadParallelism int           `env:"UPLOAD_PARALLELISM" default:"8"`
	ShutdownGrace     time.Duration `env:"SHUTDOWN_GRACE" default:"30s"`
}

// Load reads and validates the environment and fills path defaults.
func Load() (Config, error) {
	var c Config
	if err := libconfig.Load(&c); err != nil {
		return c, err
	}
	if c.ScratchDir == "" {
		c.ScratchDir = filepath.Join(os.TempDir(), "winkey-scratch")
	}
	return c, nil
}
