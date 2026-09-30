// Package config defines the analytics-worker configuration (environment only).
package config

import (
	"errors"
	"time"

	libconfig "github.com/luantpbk/winkey/libs/go/config"
)

// Config is loaded from the environment; see the README for the table.
type Config struct {
	HTTPAddr string `env:"HTTP_ADDR" default:":8081"`
	LogLevel string `env:"LOG_LEVEL" default:"info"`

	NATSURL string `env:"NATS_URL,required"`

	ClickHouseAddr     string `env:"CLICKHOUSE_ADDR" default:"localhost:9000"`
	ClickHouseUser     string `env:"CLICKHOUSE_USER" default:"default"`
	ClickHousePassword string `env:"CLICKHOUSE_PASSWORD"`
	// MigrationsDir holds db/clickhouse/*.sql (mounted read-only; never copied into the image).
	MigrationsDir string `env:"CLICKHOUSE_MIGRATIONS_DIR" default:"/migrations"`

	BatchMaxMessages int           `env:"BATCH_MAX_MESSAGES" default:"5000"`
	BatchMaxWait     time.Duration `env:"BATCH_MAX_WAIT" default:"2s"`
}

// Load reads and validates the environment.
func Load() (Config, error) {
	var c Config
	if err := libconfig.Load(&c); err != nil {
		return c, err
	}
	return c, c.Validate()
}

// Validate checks values the loader cannot.
func (c Config) Validate() error {
	if c.BatchMaxMessages < 1 || c.BatchMaxMessages > 20000 {
		return errors.New("BATCH_MAX_MESSAGES must be between 1 and 20000 (the durable allows 20000 unacknowledged messages)")
	}
	if c.BatchMaxWait < 100*time.Millisecond {
		return errors.New("BATCH_MAX_WAIT must be at least 100ms")
	}
	return nil
}
