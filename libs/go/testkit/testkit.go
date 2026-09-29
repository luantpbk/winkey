// Package testkit starts real dependencies (PostgreSQL 17, NATS JetStream,
// Garage) in containers for integration tests. Every helper skips the test
// when no container runtime is reachable, so `go test ./...` stays green on
// machines without Docker; set WINKEY_REQUIRE_DOCKER=1 (CI) to fail instead.
package testkit

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/testcontainers/testcontainers-go"
)

// RepoRoot returns the repository root (the directory holding db/migrations).
func RepoRoot(t testing.TB) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("testkit: cannot locate source file")
	}
	dir := filepath.Dir(file)
	for i := 0; i < 8; i++ {
		if st, err := os.Stat(filepath.Join(dir, "db", "migrations")); err == nil && st.IsDir() {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("testkit: repository root (db/migrations) not found")
	return ""
}

// requireDocker skips (or fails, with WINKEY_REQUIRE_DOCKER=1) when Docker is
// unavailable.
func requireDocker(t testing.TB) {
	t.Helper()
	provider, err := testcontainers.NewDockerProvider()
	if err == nil {
		defer func() { _ = provider.Close() }()
		if err = provider.Health(context.Background()); err == nil {
			return
		}
	}
	if os.Getenv("WINKEY_REQUIRE_DOCKER") == "1" {
		t.Fatalf("testkit: docker required but unavailable: %v", err)
	}
	t.Skipf("testkit: docker unavailable: %v", err)
}
