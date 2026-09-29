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
	// HWAccelDecode: with NVENC, decode on the GPU (-hwaccel cuda, the default). Set
	// false to decode on the CPU and only encode on the GPU; measured ~2x faster
	// on gpu-01 while the GPU is shared with a miner (docs/INFRASTRUCTURE.md section 6).
	// Ignored by x264.
	HWAccelDecode bool `env:"HWACCEL_DECODE" default:"true"`

	ScratchDir string `env:"SCRATCH_DIR"` // default: <os temp dir>/winkey-scratch
	ArchiveDir string `env:"ARCHIVE_DIR"` // optional raw archive
	// Required: production never relies on ffmpeg being on PATH.
	FFmpegPath  string `env:"FFMPEG_PATH,required"`
	FFprobePath string `env:"FFPROBE_PATH,required"`

	UploadParallelism int           `env:"UPLOAD_PARALLELISM" default:"8"`
	ShutdownGrace     time.Duration `env:"SHUTDOWN_GRACE" default:"30s"`

	// Stuck-job reconciler (V3b): every worker sweeps RUNNING jobs whose
	// heartbeat is older than StaleJobAfter.
	ReconcileInterval time.Duration `env:"RECONCILE_INTERVAL" default:"60s"`
	StaleJobAfter     time.Duration `env:"STALE_JOB_AFTER" default:"10m"`
	MaxJobAttempts    int           `env:"MAX_JOB_ATTEMPTS" default:"3"`
}

// Load reads and validates the environment and fills path defaults.
func Load() (Config, error) { return LoadFrom(os.LookupEnv) }

// LoadFrom is Load with an explicit lookup function (used by tests).
func LoadFrom(lookup func(string) (string, bool)) (Config, error) {
	var c Config
	if err := libconfig.LoadFrom(&c, lookup); err != nil {
		return c, err
	}
	if c.ScratchDir == "" {
		c.ScratchDir = filepath.Join(os.TempDir(), "winkey-scratch")
	}
	return c, nil
}
