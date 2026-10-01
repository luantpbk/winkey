package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func backfillEnv(extra map[string]string) func(string) (string, bool) {
	env := map[string]string{
		"DATABASE_URL": "postgres://u:p@localhost/db", "S3_ENDPOINT": "http://localhost:3900",
		"S3_ACCESS_KEY_ID": "k", "S3_SECRET_ACCESS_KEY": "s", "FFMPEG_PATH": "/usr/local/bin/ffmpeg",
	}
	for k, v := range extra {
		env[k] = v
	}
	return func(k string) (string, bool) { v, ok := env[k]; return v, ok }
}

func TestLoadBackfillDefaults(t *testing.T) {
	c, err := LoadBackfillFrom(backfillEnv(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Limit != 100 || c.Concurrency != 1 || c.S3MediaBucket != "winkey-media" {
		t.Errorf("defaults: %+v", c)
	}
	if filepath.Base(c.ScratchDir) != "winkey-scratch" {
		t.Errorf("scratch dir %q", c.ScratchDir)
	}
}

func TestLoadBackfillLimits(t *testing.T) {
	for name, tc := range map[string]struct {
		env  map[string]string
		want string // "" = valid
	}{
		"max limit":        {map[string]string{"BACKFILL_LIMIT": "10000"}, ""},
		"limit too big":    {map[string]string{"BACKFILL_LIMIT": "10001"}, "BACKFILL_LIMIT"},
		"limit zero":       {map[string]string{"BACKFILL_LIMIT": "0"}, "BACKFILL_LIMIT"},
		"max concurrency":  {map[string]string{"BACKFILL_CONCURRENCY": "4"}, ""},
		"concurrency 5":    {map[string]string{"BACKFILL_CONCURRENCY": "5"}, "BACKFILL_CONCURRENCY"},
		"concurrency zero": {map[string]string{"BACKFILL_CONCURRENCY": "0"}, "BACKFILL_CONCURRENCY"},
		"not a number":     {map[string]string{"BACKFILL_LIMIT": "many"}, "BACKFILL_LIMIT"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := LoadBackfillFrom(backfillEnv(tc.env))
			switch {
			case tc.want == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)):
				t.Fatalf("error = %v, want one naming %s", err, tc.want)
			}
		})
	}
}

func TestLoadBackfillRequiresTheWorkerVariablesButNotNATS(t *testing.T) {
	_, err := LoadBackfillFrom(func(string) (string, bool) { return "", false })
	if err == nil {
		t.Fatal("empty environment accepted")
	}
	for _, v := range []string{"DATABASE_URL", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "FFMPEG_PATH"} {
		if !strings.Contains(err.Error(), v) {
			t.Errorf("error does not name %s: %v", v, err)
		}
	}
	if strings.Contains(err.Error(), "NATS_URL") || strings.Contains(err.Error(), "FFPROBE_PATH") {
		t.Errorf("the CLI needs neither NATS nor ffprobe: %v", err)
	}
}
