// Package gpu01 only holds tests for the files in this directory (install.sh).
package gpu01

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// runScript runs install.sh with an isolated PREFIX and a fake `sudo` first in PATH.
// The fake sudo records any call and fails: the script must only PRINT root commands.
func runScript(t *testing.T, prefix, sudoMarker string, extraEnv []string, args ...string) (string, error) {
	t.Helper()
	fakeBin := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(fakeBin, 0o755); err != nil {
		t.Fatal(err)
	}
	sudo := "#!/bin/sh\necho \"$@\" >> '" + sudoMarker + "'\nexit 1\n"
	if err := os.WriteFile(filepath.Join(fakeBin, "sudo"), []byte(sudo), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", append([]string{"install.sh"}, args...)...)
	cmd.Env = append(os.Environ(), append([]string{
		"PATH=" + fakeBin + string(os.PathListSeparator) + os.Getenv("PATH"),
		"WINKEY_PREFIX=" + prefix,
		"ALLOW_DIRTY=1", // developers run this with uncommitted changes
	}, extraEnv...)...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestInstallScript(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("install.sh builds and smoke-tests a linux/amd64 binary: run on Linux")
	}
	if testing.Short() {
		t.Skip("builds the transcoder several times")
	}
	for _, bin := range []string{"bash", "go", "git", "find", "sort"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not found", bin)
		}
	}
	if runtime.GOARCH != "amd64" {
		t.Skip("the smoke test executes the linux/amd64 binary it builds")
	}

	prefix := filepath.Join(t.TempDir(), "opt", "winkey", "transcoder")
	marker := filepath.Join(t.TempDir(), "sudo-was-called")
	run := func(env []string, args ...string) string {
		t.Helper()
		out, err := runScript(t, prefix, marker, env, args...)
		if err != nil {
			t.Fatalf("install.sh %v: %v\n%s", args, err, out)
		}
		return out
	}
	link := func(name string) string {
		target, err := os.Readlink(filepath.Join(prefix, name))
		if err != nil {
			return ""
		}
		return target
	}

	// A missing PREFIX is not created behind the operator's back (that needs root): it is explained.
	out, err := runScript(t, prefix, marker, nil, "install")
	if err == nil || !strings.Contains(out, "does not exist") || !strings.Contains(out, "sudo install -d") {
		t.Fatalf("missing prefix: err=%v\n%s", err, out)
	}
	if err := os.MkdirAll(prefix, 0o755); err != nil {
		t.Fatal(err)
	}

	// install: builds, smoke-tests, links current, prints the root steps instead of running them.
	out = run([]string{"VERSION_ID=v1"}, "install")
	if link("current") != "v1" || link("previous") != "" {
		t.Fatalf("after install: current=%q previous=%q\n%s", link("current"), link("previous"), out)
	}
	for _, f := range []string{"transcoder", "replay-dlq", "VERSION"} {
		if _, err := os.Stat(filepath.Join(prefix, "v1", f)); err != nil {
			t.Errorf("v1/%s missing: %v", f, err)
		}
	}
	for _, want := range []string{"useradd --system", "--groups video,render,winkey", "winkey-transcoder",
		"install -m 0600 -o root -g root", "/etc/winkey/transcoder.env", "systemctl daemon-reload", "systemctl enable --now winkey-transcoder"} {
		if !strings.Contains(out, want) {
			t.Errorf("install output lacks %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "    sudo ") {
		t.Error("root steps must be printed as `sudo …` lines")
	}

	// upgrade to a new version: previous remembers the old one; the restart is printed, not run.
	out = run([]string{"VERSION_ID=v2"}, "upgrade")
	if link("current") != "v2" || link("previous") != "v1" || !strings.Contains(out, "sudo systemctl restart winkey-transcoder") {
		t.Fatalf("after upgrade: current=%q previous=%q\n%s", link("current"), link("previous"), out)
	}
	// Upgrading to the version that is already current is a no-op.
	run([]string{"VERSION_ID=v2"}, "upgrade")
	if link("current") != "v2" || link("previous") != "v1" {
		t.Fatalf("no-op upgrade changed the links: current=%q previous=%q", link("current"), link("previous"))
	}

	// rollback swaps current and previous (a second rollback toggles back).
	out = run(nil, "rollback")
	if link("current") != "v1" || link("previous") != "v2" || !strings.Contains(out, "sudo systemctl restart") {
		t.Fatalf("after rollback: current=%q previous=%q\n%s", link("current"), link("previous"), out)
	}
	run(nil, "rollback")
	if link("current") != "v2" || link("previous") != "v1" {
		t.Fatalf("second rollback: current=%q previous=%q", link("current"), link("previous"))
	}

	// status names the versions and marks current and previous.
	out = run(nil, "status")
	for _, want := range []string{"current:  v2", "previous: v1", "v2 <- current", "v1 <- previous", "env file:", "unit:"} {
		if !strings.Contains(out, want) {
			t.Errorf("status lacks %q:\n%s", want, out)
		}
	}

	// Old versions are pruned, but never current or previous.
	for _, id := range []string{"v3", "v4", "v5"} {
		run([]string{"VERSION_ID=" + id}, "upgrade")
	}
	run([]string{"VERSION_ID=v6", "KEEP=2"}, "upgrade")
	if link("current") != "v6" || link("previous") != "v5" {
		t.Fatalf("current=%q previous=%q", link("current"), link("previous"))
	}
	entries, _ := os.ReadDir(prefix)
	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	if len(dirs) != 2 { // KEEP=2: exactly the newest two, which are current and previous
		t.Fatalf("directories after prune with KEEP=2: %v", dirs)
	}

	// Rolling back with nothing to roll back to, and bad input, are refused clearly.
	fresh := filepath.Join(t.TempDir(), "fresh")
	_ = os.MkdirAll(fresh, 0o755)
	if out, err := runScript(t, fresh, marker, nil, "rollback"); err == nil || !strings.Contains(out, "no previous version") {
		t.Errorf("rollback with nothing installed: %v\n%s", err, out)
	}
	if out, err := runScript(t, fresh, marker, nil, "upgrade"); err == nil || !strings.Contains(out, "nothing is installed yet") {
		t.Errorf("upgrade before install: %v\n%s", err, out)
	}
	if out, err := runScript(t, fresh, marker, []string{"VERSION_ID=../evil"}, "install"); err == nil || !strings.Contains(out, "VERSION_ID may only contain") {
		t.Errorf("path traversal in VERSION_ID: %v\n%s", err, out)
	}
	if _, err := runScript(t, fresh, marker, nil, "bogus"); err == nil {
		t.Error("an unknown subcommand must fail")
	}

	// The script must never have invoked sudo itself.
	if b, err := os.ReadFile(marker); err == nil {
		t.Fatalf("install.sh called sudo: %s", b)
	}
}

// A dirty tree is refused unless the operator says otherwise, so a version name always means one commit.
func TestInstallScriptRefusesDirtyTreeUnlessAllowed(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux only")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	root, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skip("not a git checkout")
	}
	probe := filepath.Join(strings.TrimSpace(string(root)), "services", "transcoder", "zz-install-test-probe.txt")
	if err := os.WriteFile(probe, []byte("dirty"), 0o644); err != nil {
		t.Skip("cannot dirty the tree")
	}
	defer os.Remove(probe)

	prefix := filepath.Join(t.TempDir(), "p")
	_ = os.MkdirAll(prefix, 0o755)
	cmd := exec.Command("bash", "install.sh", "install")
	cmd.Env = append(os.Environ(), "WINKEY_PREFIX="+prefix, "ALLOW_DIRTY=0")
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "uncommitted changes") {
		t.Fatalf("a dirty tree was accepted: %v\n%s", err, out)
	}
	entries, _ := os.ReadDir(prefix)
	if len(entries) != 0 {
		t.Fatalf("something was installed despite the refusal: %v", entries)
	}
}
