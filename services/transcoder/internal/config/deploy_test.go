package config

import (
	"bufio"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// These tests keep the deployment files under deploy/gpu-01 and the dev
// .env.example honest against the Config struct: a variable added to (or removed
// from) config.go without touching the example files fails here.

const (
	gpuEnvExample = "../../deploy/gpu-01/transcoder.env.example"
	devEnvExample = "../../.env.example"
	unitFile      = "../../deploy/gpu-01/winkey-transcoder.service"
)

// extraKnown are variables read outside the Config struct (libs/go/obs); an
// example may set them, but does not have to.
var extraKnown = map[string]bool{"OTEL_EXPORTER_OTLP_ENDPOINT": true}

// configKeys returns the env variable name of every field of Config, and which
// of them are required.
func configKeys(t *testing.T) (all []string, required map[string]bool) {
	t.Helper()
	required = map[string]bool{}
	typ := reflect.TypeOf(Config{})
	for i := 0; i < typ.NumField(); i++ {
		tag, ok := typ.Field(i).Tag.Lookup("env")
		if !ok {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		all = append(all, name)
		if opts == "required" {
			required[name] = true
		}
	}
	sort.Strings(all)
	return all, required
}

// parseEnvFile reads KEY=value lines the way systemd's EnvironmentFile does (no
// export, no expansion, `#` starts a comment only at the start of a line).
func parseEnvFile(t *testing.T, path string) map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || k != strings.TrimSpace(k) || strings.ContainsAny(k, " \t") || strings.HasPrefix(k, "export") {
			t.Fatalf("%s:%d: not a plain KEY=value line: %q", path, n, line)
		}
		if _, dup := out[k]; dup {
			t.Fatalf("%s:%d: %s is set twice", path, n, k)
		}
		out[k] = v
	}
	return out
}

func TestEnvExamplesMatchTheConfigStruct(t *testing.T) {
	all, _ := configKeys(t)
	for _, path := range []string{gpuEnvExample, devEnvExample} {
		env := parseEnvFile(t, path)
		var missing, extra []string
		for _, k := range all {
			if _, ok := env[k]; !ok {
				missing = append(missing, k)
			}
		}
		known := map[string]bool{}
		for _, k := range all {
			known[k] = true
		}
		for k := range env {
			if !known[k] && !extraKnown[k] {
				extra = append(extra, k)
			}
		}
		sort.Strings(extra)
		if len(missing) > 0 {
			t.Errorf("%s lacks keys that config.go reads: %v", path, missing)
		}
		if len(extra) > 0 {
			t.Errorf("%s has keys that config.go does not read: %v", path, extra)
		}
	}
}

// The examples are complete, valid configurations (all required variables set,
// every value parses), so copying one and filling in the secrets works.
func TestEnvExamplesLoadAsValidConfigurations(t *testing.T) {
	for _, path := range []string{gpuEnvExample, devEnvExample} {
		env := parseEnvFile(t, path)
		if _, err := LoadFrom(func(k string) (string, bool) { v, ok := env[k]; return v, ok }); err != nil {
			t.Errorf("%s does not load: %v", path, err)
		}
	}
}

func TestGPU01ExampleValues(t *testing.T) {
	env := parseEnvFile(t, gpuEnvExample)
	cfg, err := LoadFrom(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}

	// Shared GPU: CPU decode, one job, NVENC (docs/INFRASTRUCTURE.md section 6).
	if cfg.Encoder != "nvenc" || cfg.HWAccelDecode || cfg.WorkerConcurrency != 1 {
		t.Errorf("encoder=%q hwaccel_decode=%v concurrency=%d", cfg.Encoder, cfg.HWAccelDecode, cfg.WorkerConcurrency)
	}
	// FFmpeg by absolute path (never PATH).
	for name, p := range map[string]string{"FFMPEG_PATH": cfg.FFmpegPath, "FFPROBE_PATH": cfg.FFprobePath} {
		if !strings.HasPrefix(p, "/opt/ffmpeg-7.1/bin/") {
			t.Errorf("%s = %q, want a path under /opt/ffmpeg-7.1/bin/", name, p)
		}
	}
	// The health/metrics listener must name a host that is not "all interfaces".
	host, _, err := net.SplitHostPort(cfg.HTTPAddr)
	if err != nil || host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		t.Errorf("HTTP_ADDR = %q binds every interface (bare :port, 0.0.0.0 or ::)", cfg.HTTPAddr)
	}
	// edge-1 over Tailscale: the fixed NodePorts of ADR-015, never the host PostgreSQL on 5432.
	for key, port := range map[string]string{"DATABASE_URL": ":30432/", "NATS_URL": ":30422", "S3_ENDPOINT": ":30900"} {
		if !strings.Contains(env[key], port) {
			t.Errorf("%s = %q: expected the edge-1 NodePort %s", key, env[key], port)
		}
	}
	if strings.Contains(env["DATABASE_URL"], ":5432") {
		t.Error("DATABASE_URL points at the host PostgreSQL (5432), which is not reachable for tag:gpu")
	}
	// No secret may be committed: credentials are placeholders.
	for _, key := range []string{"S3_SECRET_ACCESS_KEY"} {
		if env[key] != "CHANGE_ME" {
			t.Errorf("%s must be the placeholder CHANGE_ME", key)
		}
	}
	if !strings.Contains(env["DATABASE_URL"], ":CHANGE_ME@") {
		t.Error("DATABASE_URL must carry the placeholder password CHANGE_ME")
	}
	// The stock timings the unit relies on.
	if cfg.ShutdownGrace != 30*time.Second {
		t.Errorf("SHUTDOWN_GRACE = %v; the unit's TimeoutStopSec assumes 30s", cfg.ShutdownGrace)
	}
	if cfg.ScratchDir == "" || cfg.ArchiveDir == "" {
		t.Error("SCRATCH_DIR and ARCHIVE_DIR are set on gpu-01")
	}
}

// --- the systemd unit -------------------------------------------------------------

// parseUnit returns section -> key -> values (a key may repeat, e.g. ReadWritePaths).
func parseUnit(t *testing.T, path string) map[string]map[string][]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	out := map[string]map[string][]string{}
	section := ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = line[1 : len(line)-1]
			out[section] = map[string][]string{}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || section == "" {
			t.Fatalf("%s: unexpected line %q", path, line)
		}
		out[section][k] = append(out[section][k], v)
	}
	return out
}

func first(u map[string]map[string][]string, section, key string) string {
	if v := u[section][key]; len(v) > 0 {
		return v[0]
	}
	return ""
}

func TestUnitAgreesWithTheEnvExample(t *testing.T) {
	u := parseUnit(t, unitFile)
	env := parseEnvFile(t, gpuEnvExample)
	cfg, err := LoadFrom(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	svc := func(k string) string { return first(u, "Service", k) }

	// Stop: SIGTERM to the worker only; the timeout leaves room for the grace period + 30 s.
	if svc("KillSignal") != "SIGTERM" || svc("KillMode") != "mixed" {
		t.Errorf("KillSignal=%q KillMode=%q, want SIGTERM and mixed (SIGTERM must reach only the worker, which gives jobs their grace period)",
			svc("KillSignal"), svc("KillMode"))
	}
	want := cfg.ShutdownGrace + 30*time.Second
	got, err := time.ParseDuration(svc("TimeoutStopSec") + "s")
	if err != nil || got != want {
		t.Errorf("TimeoutStopSec=%q, want %v (SHUTDOWN_GRACE %v + 30s)", svc("TimeoutStopSec"), want, cfg.ShutdownGrace)
	}
	// The default in config.go must not silently drift from what the unit assumes either.
	def, _ := reflect.TypeOf(Config{}).FieldByName("ShutdownGrace")
	if d, _ := time.ParseDuration(def.Tag.Get("default")); d+30*time.Second != want {
		t.Errorf("config default SHUTDOWN_GRACE is %v, the unit assumes %v", d, cfg.ShutdownGrace)
	}

	// Identity, environment, binary, restart policy.
	if svc("User") != "winkey-transcoder" || svc("EnvironmentFile") != "/etc/winkey/transcoder.env" ||
		svc("ExecStart") != "/opt/winkey/transcoder/current/transcoder" {
		t.Errorf("User=%q EnvironmentFile=%q ExecStart=%q", svc("User"), svc("EnvironmentFile"), svc("ExecStart"))
	}
	if svc("Restart") != "on-failure" || svc("RestartSec") != "5" || svc("RestartPreventExitStatus") != "2" {
		t.Errorf("Restart=%q RestartSec=%q RestartPreventExitStatus=%q", svc("Restart"), svc("RestartSec"), svc("RestartPreventExitStatus"))
	}
	unit := u["Unit"]
	for _, dep := range []string{"network-online.target", "tailscaled.service"} {
		if !strings.Contains(strings.Join(unit["After"], " "), dep) || !strings.Contains(strings.Join(unit["Wants"], " "), dep) {
			t.Errorf("After=/Wants= must both name %s", dep)
		}
	}

	// Yield to the miner and ComfyUI.
	for k, v := range map[string]string{"Nice": "10", "CPUWeight": "50", "IOWeight": "50"} {
		if svc(k) != v {
			t.Errorf("%s=%q, want %s", k, svc(k), v)
		}
	}
	if svc("MemoryMax") == "" {
		t.Error("MemoryMax is not set")
	}

	// Hardening on, and the settings that would break NVENC absent.
	for _, k := range []string{"NoNewPrivileges", "ProtectHome", "PrivateTmp"} {
		if svc(k) != "yes" {
			t.Errorf("%s=%q, want yes", k, svc(k))
		}
	}
	if svc("ProtectSystem") != "strict" {
		t.Errorf("ProtectSystem=%q, want strict", svc("ProtectSystem"))
	}
	for _, k := range []string{"PrivateDevices", "MemoryDenyWriteExecute", "ProcSubset", "SystemCallFilter", "DeviceAllow", "DevicePolicy"} {
		if _, set := u["Service"][k]; set {
			t.Errorf("%s must not be set: it can hide /dev/nvidia* or break the NVIDIA libraries", k)
		}
	}

	// The only writable paths are exactly SCRATCH_DIR and ARCHIVE_DIR.
	rw := map[string]bool{}
	for _, p := range u["Service"]["ReadWritePaths"] {
		rw[strings.TrimPrefix(p, "-")] = true
	}
	if len(rw) != 2 || !rw[filepath.ToSlash(cfg.ScratchDir)] || !rw[filepath.ToSlash(cfg.ArchiveDir)] {
		t.Errorf("ReadWritePaths=%v must be exactly SCRATCH_DIR (%s) and ARCHIVE_DIR (%s)", u["Service"]["ReadWritePaths"], cfg.ScratchDir, cfg.ArchiveDir)
	}
	for _, p := range u["Service"]["ReadWritePaths"] {
		if p == cfg.ScratchDir && strings.HasPrefix(p, "-") {
			t.Error("the scratch directory is required, only the archive is optional")
		}
	}
}
