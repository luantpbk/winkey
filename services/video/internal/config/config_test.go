package config

import (
	"strings"
	"testing"

	libconfig "github.com/luantpbk/winkey/libs/go/config"
)

func load(env map[string]string) (Config, error) {
	var c Config
	if err := libconfig.LoadFrom(&c, func(k string) (string, bool) { v, ok := env[k]; return v, ok }); err != nil {
		return c, err
	}
	return c, c.Validate()
}

func valid() map[string]string {
	return map[string]string{
		"DATABASE_URL": "postgres://x", "NATS_URL": "nats://x",
		"MEDIA_BASE_URL": "https://media.winkey.vn", "CURSOR_SECRET": "0123456789abcdef",
	}
}

func TestDefaults(t *testing.T) {
	c, err := load(valid())
	if err != nil {
		t.Fatal(err)
	}
	if c.HTTPAddr != ":8080" || c.MediaBucket != "winkey-media" || c.ValkeyURL != "" || c.CacheTTL.String() != "30s" {
		t.Fatalf("%+v", c)
	}
}

func TestRequiredAndSecretLength(t *testing.T) {
	for _, name := range []string{"DATABASE_URL", "NATS_URL", "MEDIA_BASE_URL", "CURSOR_SECRET"} {
		env := valid()
		delete(env, name)
		if _, err := load(env); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("missing %s: %v", name, err)
		}
	}
	env := valid()
	env["CURSOR_SECRET"] = "short"
	if _, err := load(env); err == nil {
		t.Error("a short CURSOR_SECRET must be rejected")
	}
	env["VALKEY_URL"] = "redis://valkey:6379/0"
	env["CURSOR_SECRET"] = strings.Repeat("s", 32)
	if c, err := load(env); err != nil || c.ValkeyURL == "" {
		t.Errorf("%+v %v", c, err)
	}
}

func TestViewCounterSettings(t *testing.T) {
	c, err := load(valid())
	if err != nil {
		t.Fatal(err)
	}
	if len(c.TrustProxyCIDRs) != 2 || c.TrustProxyCIDRs[0] != "10.42.0.0/16" || c.TrustProxyCIDRs[1] != "127.0.0.1" ||
		c.ViewFlushInterval.String() != "30s" || c.ViewDedupTTL.String() != "30m0s" || c.ViewRateLimit != 60 || c.ViewFlushLockTTL.String() != "2m0s" {
		t.Fatalf("%+v", c)
	}
	for name, env := range map[string]map[string]string{
		"bad CIDR":        {"TRUST_PROXY_CIDRS": "10.0.0.0/33"},
		"garbage CIDR":    {"TRUST_PROXY_CIDRS": "gateway"},
		"zero flush":      {"VIEW_FLUSH_INTERVAL": "0s"},
		"zero rate limit": {"VIEW_RATE_LIMIT": "0"},
		"negative dedup":  {"VIEW_DEDUP_TTL": "-1m"},
	} {
		e := valid()
		for k, v := range env {
			e[k] = v
		}
		if _, err := load(e); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestSearchRateLimits(t *testing.T) {
	c, err := load(valid())
	if err != nil || c.SearchRateLimit != 60 || c.SuggestRateLimit != 120 {
		t.Fatalf("%+v %v", c, err)
	}
	for _, name := range []string{"SEARCH_RATE_LIMIT", "SUGGEST_RATE_LIMIT"} {
		for _, bad := range []string{"0", "-5"} {
			e := valid()
			e[name] = bad
			if _, err := load(e); err == nil {
				t.Errorf("%s=%s accepted", name, bad)
			}
		}
	}
}
