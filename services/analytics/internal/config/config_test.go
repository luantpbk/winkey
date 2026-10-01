package config

import (
	"testing"
	"time"
)

func TestLoadDefaultsAndRequired(t *testing.T) {
	t.Setenv("NATS_URL", "")
	if _, err := Load(); err == nil {
		t.Fatal("NATS_URL is required")
	}
	t.Setenv("NATS_URL", "nats://x:4222")
	t.Setenv("POSTGRES_URL", "postgres://u:p@h/db")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.BatchMaxMessages != 5000 || c.BatchMaxWait != 2*time.Second || c.MigrationsDir != "/migrations" || c.ClickHouseUser != "default" || c.InsertTimeout != 30*time.Second {
		t.Fatalf("%+v", c)
	}
}

func TestValidate(t *testing.T) {
	for name, c := range map[string]Config{
		"batch zero":       {BatchMaxMessages: 0, BatchMaxWait: time.Second, InsertTimeout: 10 * time.Second},
		"batch too big":    {BatchMaxMessages: 20001, BatchMaxWait: time.Second, InsertTimeout: 10 * time.Second},
		"timeout too long": {BatchMaxMessages: 10, BatchMaxWait: time.Second, InsertTimeout: 31 * time.Second},
		"timeout zero":     {BatchMaxMessages: 10, BatchMaxWait: time.Second},
		"wait too short":   {BatchMaxMessages: 10, BatchMaxWait: time.Millisecond, InsertTimeout: 10 * time.Second},
	} {
		if c.Validate() == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if err := (Config{BatchMaxMessages: 20000, BatchMaxWait: 100 * time.Millisecond, InsertTimeout: 30 * time.Second}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestRollupValidation(t *testing.T) {
	ok := Config{BatchMaxMessages: 10, BatchMaxWait: time.Second, InsertTimeout: 10 * time.Second,
		RollupEnabled: true, PostgresURL: "postgres://x", RollupEvery: 10 * time.Minute, RollupWindow: 3, RollupBackfill: 8}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mod := range map[string]func(*Config){
		"no postgres url":    func(c *Config) { c.PostgresURL = "" },
		"interval too short": func(c *Config) { c.RollupEvery = 59 * time.Second },
		"interval too long":  func(c *Config) { c.RollupEvery = time.Hour + time.Second },
		"window zero":        func(c *Config) { c.RollupWindow = 0 },
		"window too big":     func(c *Config) { c.RollupWindow = 9 },
		"backfill zero":      func(c *Config) { c.RollupBackfill = 0 },
		"backfill too big":   func(c *Config) { c.RollupBackfill = 31 },
	} {
		c := ok
		mod(&c)
		if c.Validate() == nil {
			t.Errorf("%s accepted", name)
		}
	}
	// Disabled: nothing about the rollup is checked and POSTGRES_URL is not needed.
	off := Config{BatchMaxMessages: 10, BatchMaxWait: time.Second, InsertTimeout: 10 * time.Second}
	if err := off.Validate(); err != nil {
		t.Fatal(err)
	}
}
