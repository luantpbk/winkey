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
	// InsertTimeout bounds one INSERT attempt; the durable's ack_wait is 60 s, so it must stay below 30 s.
	InsertTimeout time.Duration `env:"CLICKHOUSE_INSERT_TIMEOUT" default:"30s"`

	// Rollup of video_qoe_hourly into analytics.video_daily in PostgreSQL (task R1-b).
	RollupEnabled  bool          `env:"ROLLUP_ENABLED" default:"true"`
	PostgresURL    string        `env:"POSTGRES_URL"` // required when ROLLUP_ENABLED
	RollupEvery    time.Duration `env:"ROLLUP_INTERVAL" default:"10m"`
	RollupWindow   int           `env:"ROLLUP_WINDOW_DAYS" default:"3"`
	RollupBackfill int           `env:"ROLLUP_BACKFILL_DAYS" default:"8"`
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
	if c.InsertTimeout < time.Second || c.InsertTimeout > 30*time.Second {
		return errors.New("CLICKHOUSE_INSERT_TIMEOUT must be between 1s and 30s (half of the 60s ack_wait)")
	}
	if c.RollupEnabled {
		if c.PostgresURL == "" {
			return errors.New("POSTGRES_URL is required when ROLLUP_ENABLED=true")
		}
		if c.RollupEvery < time.Minute || c.RollupEvery > time.Hour {
			return errors.New("ROLLUP_INTERVAL must be between 1m and 1h")
		}
		if c.RollupWindow < 1 || c.RollupWindow > 8 {
			return errors.New("ROLLUP_WINDOW_DAYS must be between 1 and 8")
		}
		if c.RollupBackfill < 1 || c.RollupBackfill > 30 {
			return errors.New("ROLLUP_BACKFILL_DAYS must be between 1 and 30")
		}
	}
	return nil
}
