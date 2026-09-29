package config

import (
	"strings"
	"testing"
	"time"
)

type testCfg struct {
	DB     string        `env:"DATABASE_URL,required"`
	Addr   string        `env:"HTTP_ADDR" default:":8080"`
	N      int           `env:"WORKERS" default:"2"`
	Poll   time.Duration `env:"POLL" default:"500ms"`
	Debug  bool          `env:"DEBUG"`
	Hosts  []string      `env:"HOSTS"`
	Nested struct {
		Secret string `env:"SECRET,required"`
	}
}

func env(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestLoadDefaultsAndValues(t *testing.T) {
	var c testCfg
	err := LoadFrom(&c, env(map[string]string{
		"DATABASE_URL": "postgres://x", "SECRET": "s", "WORKERS": "4", "DEBUG": "true", "HOSTS": "a, b,,c",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":8080" || c.N != 4 || c.Poll != 500*time.Millisecond || !c.Debug || c.Nested.Secret != "s" {
		t.Fatalf("unexpected config: %+v", c)
	}
	if len(c.Hosts) != 3 || c.Hosts[2] != "c" {
		t.Fatalf("hosts: %v", c.Hosts)
	}
}

func TestLoadReportsAllProblemsWithoutValues(t *testing.T) {
	var c testCfg
	err := LoadFrom(&c, env(map[string]string{"WORKERS": "hunter2", "DATABASE_URL": ""}))
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	for _, want := range []string{"DATABASE_URL is required", "SECRET is required", "WORKERS: invalid integer"} {
		if !strings.Contains(msg, want) {
			t.Errorf("missing %q in %q", want, msg)
		}
	}
	if strings.Contains(msg, "hunter2") {
		t.Error("error leaks the value")
	}
}

func TestLoadRejectsNonPointer(t *testing.T) {
	if err := LoadFrom(testCfg{}, env(nil)); err == nil {
		t.Fatal("expected error")
	}
}
