package testkit

import (
	"context"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Valkey is a Valkey server (Redis protocol) in a container.
type Valkey struct {
	// URL is a redis:// URL for it, e.g. redis://localhost:32768/0.
	URL       string
	Container testcontainers.Container
}

// StartValkey starts valkey/valkey:8 on a random port.
func StartValkey(t testing.TB) *Valkey {
	t.Helper()
	requireDocker(t)
	ctx := context.Background()
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "valkey/valkey:8-alpine",
			ExposedPorts: []string{"6379/tcp"},
			WaitingFor:   wait.ForLog("Ready to accept connections").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		t.Fatalf("testkit: start valkey: %v", err)
	}
	testcontainers.CleanupContainer(t, c)
	return &Valkey{URL: valkeyURL(t, c), Container: c}
}

// Stop stops the server (the port stays allocated), to simulate an outage.
func (v *Valkey) Stop(t testing.TB) {
	t.Helper()
	timeout := 5 * time.Second
	if err := v.Container.Stop(context.Background(), &timeout); err != nil {
		t.Fatalf("testkit: stop valkey: %v", err)
	}
}

// Start restarts a stopped server. The mapped port may change, so URL is
// refreshed; clients must reconnect to the new URL.
func (v *Valkey) Start(t testing.TB) {
	t.Helper()
	ctx := context.Background()
	if err := v.Container.Start(ctx); err != nil {
		t.Fatalf("testkit: start valkey: %v", err)
	}
	v.URL = valkeyURL(t, v.Container)
}

func valkeyURL(t testing.TB, c testcontainers.Container) string {
	t.Helper()
	ctx := context.Background()
	host, err := c.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := c.MappedPort(ctx, "6379/tcp")
	if err != nil {
		t.Fatal(err)
	}
	return "redis://" + host + ":" + port.Port() + "/0"
}
