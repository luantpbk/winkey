package config

import (
	"strings"
	"testing"

	libconfig "github.com/luantpbk/winkey/libs/go/config"
)

func load(t *testing.T, extra map[string]string) (Config, error) {
	t.Helper()
	env := map[string]string{
		"DATABASE_URL": "postgres://u:p@localhost/db", "NATS_URL": "nats://localhost:4222",
		"S3_ENDPOINT": "http://localhost:3900", "S3_PUBLIC_ENDPOINT": "http://localhost:3900",
		"S3_ACCESS_KEY_ID": "k", "S3_SECRET_ACCESS_KEY": "s",
	}
	for k, v := range extra {
		env[k] = v
	}
	var c Config
	if err := libconfig.LoadFrom(&c, func(k string) (string, bool) { v, ok := env[k]; return v, ok }); err != nil {
		return c, err
	}
	return c, c.Validate()
}

func TestQuotaDefaults(t *testing.T) {
	c, err := load(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxConcurrent != 3 || c.DailyCount != 20 || c.DailyBytes != 53687091200 {
		t.Errorf("defaults: %d %d %d", c.MaxConcurrent, c.DailyCount, c.DailyBytes)
	}
}

func TestQuotaRanges(t *testing.T) {
	for name, tc := range map[string]struct {
		env  map[string]string
		want string // "" = valid
	}{
		"concurrent min":          {map[string]string{"UPLOAD_MAX_CONCURRENT": "1"}, ""},
		"concurrent max":          {map[string]string{"UPLOAD_MAX_CONCURRENT": "50"}, ""},
		"concurrent zero":         {map[string]string{"UPLOAD_MAX_CONCURRENT": "0"}, "UPLOAD_MAX_CONCURRENT"},
		"concurrent 51":           {map[string]string{"UPLOAD_MAX_CONCURRENT": "51"}, "UPLOAD_MAX_CONCURRENT"},
		"concurrent negative":     {map[string]string{"UPLOAD_MAX_CONCURRENT": "-1"}, "UPLOAD_MAX_CONCURRENT"},
		"concurrent not a number": {map[string]string{"UPLOAD_MAX_CONCURRENT": "many"}, "UPLOAD_MAX_CONCURRENT"},
		"count min":               {map[string]string{"UPLOAD_DAILY_COUNT": "1"}, ""},
		"count max":               {map[string]string{"UPLOAD_DAILY_COUNT": "10000"}, ""},
		"count zero":              {map[string]string{"UPLOAD_DAILY_COUNT": "0"}, "UPLOAD_DAILY_COUNT"},
		"count 10001":             {map[string]string{"UPLOAD_DAILY_COUNT": "10001"}, "UPLOAD_DAILY_COUNT"},
		"bytes exactly 20 GiB":    {map[string]string{"UPLOAD_DAILY_BYTES": "21474836480"}, ""},
		"bytes below 20 GiB":      {map[string]string{"UPLOAD_DAILY_BYTES": "21474836479"}, "UPLOAD_DAILY_BYTES"},
		"bytes zero":              {map[string]string{"UPLOAD_DAILY_BYTES": "0"}, "UPLOAD_DAILY_BYTES"},
		"bytes above 4 GiB int32": {map[string]string{"UPLOAD_DAILY_BYTES": "107374182400"}, ""},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := load(t, tc.env)
			switch {
			case tc.want == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)):
				t.Fatalf("error = %v, want one naming %s", err, tc.want)
			}
		})
	}
}

func TestAllBadQuotaVariablesAreReportedTogether(t *testing.T) {
	_, err := load(t, map[string]string{"UPLOAD_MAX_CONCURRENT": "0", "UPLOAD_DAILY_COUNT": "0", "UPLOAD_DAILY_BYTES": "1"})
	if err == nil {
		t.Fatal("accepted")
	}
	for _, v := range []string{"UPLOAD_MAX_CONCURRENT", "UPLOAD_DAILY_COUNT", "UPLOAD_DAILY_BYTES"} {
		if !strings.Contains(err.Error(), v) {
			t.Errorf("error does not name %s: %v", v, err)
		}
	}
}
