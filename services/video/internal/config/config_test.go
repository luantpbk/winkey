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
		"MEDIA_LINK_SECRET":     "0123456789abcdef0123456789abcdef",
		"ANALYTICS_VIEWER_SALT": "0123456789abcdef0123456789abcdef",
		"S3_ENDPOINT":           "http://garage:3900", "S3_ACCESS_KEY_ID": "k", "S3_SECRET_ACCESS_KEY": "s",
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
	for _, name := range []string{"DATABASE_URL", "NATS_URL", "MEDIA_BASE_URL", "CURSOR_SECRET", "MEDIA_LINK_SECRET", "ANALYTICS_VIEWER_SALT", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"} {
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

func TestMediaLinkSecretNeedsAtLeast32BytesAndIsNeverEchoed(t *testing.T) {
	for _, n := range []int{1, 16, 31} {
		e := valid()
		e["MEDIA_LINK_SECRET"] = strings.Repeat("Q7", n)[:n]
		_, err := load(e)
		if err == nil || !strings.Contains(err.Error(), "MEDIA_LINK_SECRET") {
			t.Errorf("%d bytes accepted: %v", n, err)
		} else if strings.Contains(err.Error(), e["MEDIA_LINK_SECRET"]) {
			t.Errorf("the error repeats the secret: %v", err)
		}
	}
	e := valid()
	e["MEDIA_LINK_SECRET"] = strings.Repeat("s", 32)
	if c, err := load(e); err != nil || c.MediaLinkSecret != strings.Repeat("s", 32) {
		t.Fatalf("%v", err)
	}
}

func TestTrendingSettings(t *testing.T) {
	c, err := load(valid())
	if err != nil || !c.TrendingEnabled || c.TrendingInterval.String() != "10m0s" {
		t.Fatalf("%+v %v", c, err)
	}
	e := valid()
	e["TRENDING_ENABLED"], e["TRENDING_INTERVAL"] = "false", "0s" // an unused interval is not validated
	if c, err := load(e); err != nil || c.TrendingEnabled {
		t.Fatalf("%+v %v", c, err)
	}
	e["TRENDING_ENABLED"] = "true"
	if _, err := load(e); err == nil {
		t.Error("a zero interval with the job enabled must be refused")
	}
}

func TestAnalyticsSettings(t *testing.T) {
	c, err := load(valid())
	if err != nil || !c.AnalyticsEnabled || len(c.AnalyticsViewerSalt) != 32 {
		t.Fatalf("%+v %v", c, err)
	}
	for _, n := range []int{1, 16, 31} {
		e := valid()
		e["ANALYTICS_VIEWER_SALT"] = strings.Repeat("Q7", n)[:n]
		_, err := load(e)
		if err == nil || !strings.Contains(err.Error(), "ANALYTICS_VIEWER_SALT") {
			t.Errorf("%d bytes accepted: %v", n, err)
		} else if strings.Contains(err.Error(), e["ANALYTICS_VIEWER_SALT"]) {
			t.Errorf("the error repeats the salt: %v", err)
		}
	}
	e := valid()
	e["ANALYTICS_ENABLED"] = "false"
	if c, err := load(e); err != nil || c.AnalyticsEnabled {
		t.Fatalf("%+v %v", c, err)
	}
}

func TestRecoABSettings(t *testing.T) {
	c, err := load(valid())
	if err != nil || !c.RecoABEnabled || c.RecoABSeed != "r2ab-1" || c.RecoABTreatmentPercent != 50 {
		t.Fatalf("unexpected experiment defaults: %v", err)
	}
	for _, percent := range []string{"0", "100"} {
		e := valid()
		e["RECO_AB_ENABLED"], e["RECO_AB_SEED"], e["RECO_AB_TREATMENT_PERCENT"] = "false", "new-seed", percent
		if c, err := load(e); err != nil || c.RecoABEnabled || c.RecoABSeed != "new-seed" {
			t.Fatalf("valid experiment config rejected: %v", err)
		}
	}
	for key, values := range map[string][]string{
		"RECO_AB_TREATMENT_PERCENT": {"-1", "101", "half"},
		"RECO_AB_ENABLED":           {"maybe"},
		"RECO_AB_SEED":              {"  ", "\t"},
	} {
		for _, v := range values {
			e := valid()
			e[key] = v
			if _, err := load(e); err == nil || !strings.Contains(err.Error(), key) {
				t.Errorf("invalid %s accepted: %v", key, err)
			}
		}
	}
}
