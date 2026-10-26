package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	libconfig "github.com/luantpbk/winkey/libs/go/config"
)

// Limits of the av1-upgrade CLI (task ENC2 phase 2, ADR-041).
const AV1UpgradeMaxLimit = 1_000

// AV1Upgrade is the configuration of cmd/av1-upgrade: the database, both buckets, scratch, an FFmpeg 8 with a
// working av1_nvenc (AV1_FFMPEG_PATH; the worker's FFMPEG_PATH stays 7.1) and the selection thresholds. No
// NATS: the CLI publishes nothing.
type AV1Upgrade struct {
	LogLevel string `env:"LOG_LEVEL" default:"info"`

	DatabaseURL string `env:"DATABASE_URL,required"`

	S3Endpoint    string `env:"S3_ENDPOINT,required"`
	S3Region      string `env:"S3_REGION" default:"garage"`
	S3AccessKeyID string `env:"S3_ACCESS_KEY_ID,required"`
	S3SecretKey   string `env:"S3_SECRET_ACCESS_KEY,required"`
	S3MediaBucket string `env:"S3_MEDIA_BUCKET" default:"winkey-media"`

	ScratchDir    string `env:"SCRATCH_DIR"` // default: <os temp dir>/winkey-scratch
	AV1FFmpegPath string `env:"AV1_FFMPEG_PATH,required"`
	FFprobePath   string `env:"FFPROBE_PATH,required"`
	// HWAccelDecode as in the worker: false decodes on the CPU (faster while the GPU is shared).
	HWAccelDecode bool `env:"HWACCEL_DECODE" default:"true"`

	MinStarts7d int64 `env:"AV1_MIN_STARTS_7D" default:"50"`
	Limit       int   `env:"AV1_UPGRADE_LIMIT" default:"20"`
	CQ          int   `env:"AV1_CQ"`          // 0: media.DefaultAV1CQ (35)
	MaxratePct  int   `env:"AV1_MAXRATE_PCT"` // 0: media.DefaultAV1MaxratePct (85)
	// AV1 policy (AV1POL, ADR-048): "all" (default, every video over AV1_MIN_STARTS_7D, nothing dropped) or N,
	// the number of most watched READY videos that keep an AV1 set. AV1_KEEP_TOP is the rank beyond which a set
	// is dropped (0: max(2N, N+5)); it must be >= N.
	TopN    string `env:"AV1_TOP_N" default:"all"`
	KeepTop int    `env:"AV1_KEEP_TOP"`
}

// LoadAV1Upgrade reads and validates the environment.
func LoadAV1Upgrade() (AV1Upgrade, error) { return LoadAV1UpgradeFrom(os.LookupEnv) }

// LoadAV1UpgradeFrom is LoadAV1Upgrade with an explicit lookup function (used by tests).
func LoadAV1UpgradeFrom(lookup func(string) (string, bool)) (AV1Upgrade, error) {
	var c AV1Upgrade
	if err := libconfig.LoadFrom(&c, lookup); err != nil {
		return c, err
	}
	var errs []error
	if c.MinStarts7d < 0 {
		errs = append(errs, errors.New("AV1_MIN_STARTS_7D must be 0 (every video) or more"))
	}
	if c.Limit < 1 || c.Limit > AV1UpgradeMaxLimit {
		errs = append(errs, fmt.Errorf("AV1_UPGRADE_LIMIT must be between 1 and %d", AV1UpgradeMaxLimit))
	}
	if c.CQ != 0 && (c.CQ < 1 || c.CQ > 63) {
		errs = append(errs, errors.New("AV1_CQ must be in 1..63"))
	}
	if c.KeepTop < 0 {
		errs = append(errs, errors.New("AV1_KEEP_TOP must be 0 (automatic) or more"))
	}
	if c.MaxratePct != 0 && (c.MaxratePct < 10 || c.MaxratePct > 100) {
		errs = append(errs, errors.New("AV1_MAXRATE_PCT must be in 10..100"))
	}
	if len(errs) > 0 {
		return c, errors.Join(errs...)
	}
	if c.ScratchDir == "" {
		c.ScratchDir = filepath.Join(os.TempDir(), "winkey-scratch")
	}
	return c, nil
}
