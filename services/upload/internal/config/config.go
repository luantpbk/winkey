// Package config defines the upload service configuration.
package config

import (
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
}

// Load reads and validates the environment.
func Load() (Config, error) {
	var c Config
	err := libconfig.Load(&c)
	return c, err
}
