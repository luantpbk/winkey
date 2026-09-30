package testkit

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// ClickHouseImage is the pinned ClickHouse of the analytics tests (ADR-022 verified the schema on 26.9).
// WINKEY_CLICKHOUSE_IMAGE overrides it (a mirror, or another version to try).
const ClickHouseImage = "clickhouse/clickhouse-server:26.9.6.6"

// ClickHouse is a single ClickHouse server in a container.
type ClickHouse struct {
	// Addr is host:port of the NATIVE protocol (what clickhouse-go connects to); the default user has no password.
	Addr      string
	Container testcontainers.Container
}

// StartClickHouse starts ClickHouse and waits until it answers /ping. The container is terminated when the test ends.
func StartClickHouse(t testing.TB) *ClickHouse {
	t.Helper()
	requireDocker(t)
	ctx := context.Background()
	image := ClickHouseImage
	if v := os.Getenv("WINKEY_CLICKHOUSE_IMAGE"); v != "" {
		image = v
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        image,
			ExposedPorts: []string{"9000/tcp", "8123/tcp"},
			// The default user without a password, reachable from outside the container (tests only).
			Env:        map[string]string{"CLICKHOUSE_SKIP_USER_SETUP": "1"},
			WaitingFor: wait.ForHTTP("/ping").WithPort("8123/tcp").WithStartupTimeout(3 * time.Minute),
		},
		Started: true,
	})
	if err != nil {
		t.Fatalf("testkit: start clickhouse: %v", err)
	}
	testcontainers.CleanupContainer(t, c)
	host, err := c.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := c.MappedPort(ctx, "9000/tcp")
	if err != nil {
		t.Fatal(err)
	}
	return &ClickHouse{Addr: host + ":" + port.Port(), Container: c}
}
