package config

import (
	"testing"
)

// minimal is the smallest valid environment (everything marked required).
func minimal() map[string]string {
	return map[string]string{
		"DATABASE_URL": "postgres://x", "NATS_URL": "nats://x",
		"S3_ENDPOINT": "http://s3", "S3_ACCESS_KEY_ID": "k", "S3_SECRET_ACCESS_KEY": "s",
		"FFMPEG_PATH": "/opt/ffmpeg-7.1/bin/ffmpeg", "FFPROBE_PATH": "/opt/ffmpeg-7.1/bin/ffprobe",
	}
}

func load(t *testing.T, extra map[string]string) (Config, error) {
	t.Helper()
	env := minimal()
	for k, v := range extra {
		env[k] = v
	}
	return LoadFrom(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
}

func TestHWAccelDecodeDefaultsToTrue(t *testing.T) {
	c, err := load(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !c.HWAccelDecode {
		t.Fatal("HWACCEL_DECODE must default to true (current behaviour: -hwaccel cuda)")
	}
}

func TestHWAccelDecodeValues(t *testing.T) {
	for _, tc := range []struct {
		val  string
		want bool
	}{{"true", true}, {"1", true}, {"false", false}, {"0", false}, {"FALSE", false}} {
		c, err := load(t, map[string]string{"HWACCEL_DECODE": tc.val})
		if err != nil || c.HWAccelDecode != tc.want {
			t.Errorf("HWACCEL_DECODE=%q: got %v (err %v), want %v", tc.val, c.HWAccelDecode, err, tc.want)
		}
	}
	// An empty variable counts as unset, so it keeps the default.
	if c, err := load(t, map[string]string{"HWACCEL_DECODE": ""}); err != nil || !c.HWAccelDecode {
		t.Errorf("empty HWACCEL_DECODE: %v %v", c.HWAccelDecode, err)
	}
	if _, err := load(t, map[string]string{"HWACCEL_DECODE": "maybe"}); err == nil {
		t.Error("an invalid boolean must fail fast")
	}
}

func TestFFmpegPathsAreRequired(t *testing.T) {
	for _, name := range []string{"FFMPEG_PATH", "FFPROBE_PATH"} {
		env := minimal()
		delete(env, name)
		_, err := LoadFrom(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
		if err == nil {
			t.Errorf("%s missing must be an error: production never relies on PATH", name)
		}
	}
}

func TestDefaults(t *testing.T) {
	c, err := load(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.ScratchDir == "" || c.WorkerConcurrency != 0 || c.Encoder != "auto" || c.X264Preset != "veryfast" ||
		c.ReconcileInterval.String() != "1m0s" || c.MaxJobAttempts != 3 {
		t.Fatalf("%+v", c)
	}
}
