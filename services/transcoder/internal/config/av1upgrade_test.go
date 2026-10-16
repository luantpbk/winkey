package config

import (
	"strings"
	"testing"
)

func av1Env(extra map[string]string) func(string) (string, bool) {
	env := map[string]string{
		"DATABASE_URL": "postgres://u:p@localhost/db", "S3_ENDPOINT": "http://localhost:3900",
		"S3_ACCESS_KEY_ID": "k", "S3_SECRET_ACCESS_KEY": "s",
		"AV1_FFMPEG_PATH": "/opt/ffmpeg-8/bin/ffmpeg", "FFPROBE_PATH": "/usr/bin/ffprobe",
	}
	for k, v := range extra {
		env[k] = v
	}
	return func(k string) (string, bool) { v, ok := env[k]; return v, ok }
}

func TestLoadAV1UpgradeDefaults(t *testing.T) {
	c, err := LoadAV1UpgradeFrom(av1Env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.MinStarts7d != 50 || c.Limit != 20 || c.CQ != 0 || c.MaxratePct != 0 || !c.HWAccelDecode ||
		c.S3MediaBucket != "winkey-media" || c.ScratchDir == "" {
		t.Errorf("defaults: %+v", c)
	}
}

func TestLoadAV1UpgradeValidation(t *testing.T) {
	for name, tc := range map[string]struct {
		env  map[string]string
		want string // "" = valid
	}{
		"overrides":        {map[string]string{"AV1_CQ": "30", "AV1_MAXRATE_PCT": "70", "AV1_UPGRADE_LIMIT": "1000"}, ""},
		"no ffmpeg 8":      {map[string]string{"AV1_FFMPEG_PATH": ""}, "AV1_FFMPEG_PATH"},
		"zero threshold":   {map[string]string{"AV1_MIN_STARTS_7D": "0"}, "AV1_MIN_STARTS_7D"},
		"limit too big":    {map[string]string{"AV1_UPGRADE_LIMIT": "1001"}, "AV1_UPGRADE_LIMIT"},
		"cq out of range":  {map[string]string{"AV1_CQ": "64"}, "AV1_CQ"},
		"ceiling too high": {map[string]string{"AV1_MAXRATE_PCT": "101"}, "AV1_MAXRATE_PCT"},
		"ceiling too low":  {map[string]string{"AV1_MAXRATE_PCT": "5"}, "AV1_MAXRATE_PCT"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := LoadAV1UpgradeFrom(av1Env(tc.env))
			if tc.want == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Fatalf("want error about %s, got %v", tc.want, err)
			}
		})
	}
}
