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
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.BatchMaxMessages != 5000 || c.BatchMaxWait != 2*time.Second || c.MigrationsDir != "/migrations" || c.ClickHouseUser != "default" {
		t.Fatalf("%+v", c)
	}
}

func TestValidate(t *testing.T) {
	for name, c := range map[string]Config{
		"batch zero":     {BatchMaxMessages: 0, BatchMaxWait: time.Second},
		"batch too big":  {BatchMaxMessages: 20001, BatchMaxWait: time.Second},
		"wait too short": {BatchMaxMessages: 10, BatchMaxWait: time.Millisecond},
	} {
		if c.Validate() == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if err := (Config{BatchMaxMessages: 20000, BatchMaxWait: 100 * time.Millisecond}).Validate(); err != nil {
		t.Fatal(err)
	}
}
