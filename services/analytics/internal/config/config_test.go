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
	if !c.RecoEnabled || c.RecoEvery != 30*time.Minute || c.RecoWindow != 30 || c.RecoMinWatch != 20000 || c.RecoNeighbors != 30 || c.RecoHistory != 50 || c.RecoCoviewMax != 200 {
		t.Fatal("recommendation defaults differ from ADR-028")
	}
}

func TestRecoValidation(t *testing.T) {
	ok := Config{BatchMaxMessages: 10, BatchMaxWait: time.Second, InsertTimeout: time.Second,
		RecoEnabled: true, PostgresURL: "postgres://x", RecoEvery: 30 * time.Minute, RecoWindow: 30,
		RecoMinWatch: 20000, RecoNeighbors: 30, RecoHistory: 50, RecoCoviewMax: 200}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mod := range map[string]func(*Config){
		"postgres":      func(c *Config) { c.PostgresURL = "" },
		"interval low":  func(c *Config) { c.RecoEvery = 5*time.Minute - time.Second },
		"interval high": func(c *Config) { c.RecoEvery = 6*time.Hour + time.Second },
		"window low":    func(c *Config) { c.RecoWindow = 0 }, "window high": func(c *Config) { c.RecoWindow = 91 },
		"watch low": func(c *Config) { c.RecoMinWatch = 999 }, "watch high": func(c *Config) { c.RecoMinWatch = 600001 },
		"neighbors low": func(c *Config) { c.RecoNeighbors = 0 }, "neighbors high": func(c *Config) { c.RecoNeighbors = 101 },
		"history low": func(c *Config) { c.RecoHistory = 0 }, "history high": func(c *Config) { c.RecoHistory = 201 },
		"coview cap low": func(c *Config) { c.RecoCoviewMax = 9 }, "coview cap high": func(c *Config) { c.RecoCoviewMax = 5001 },
	} {
		c := ok
		mod(&c)
		if c.Validate() == nil {
			t.Errorf("%s accepted", name)
		}
	}
	for _, upper := range []bool{false, true} {
		c := ok
		c.RecoEvery = 5 * time.Minute
		c.RecoWindow = 1
		c.RecoMinWatch = 1000
		c.RecoNeighbors = 1
		c.RecoHistory = 1
		c.RecoCoviewMax = 10
		if upper {
			c.RecoEvery = 6 * time.Hour
			c.RecoWindow = 90
			c.RecoMinWatch = 600000
			c.RecoNeighbors = 100
			c.RecoHistory = 200
			c.RecoCoviewMax = 5000
		}
		if err := c.Validate(); err != nil {
			t.Fatal(err)
		}
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
