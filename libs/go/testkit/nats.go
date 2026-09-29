package testkit

import (
	"context"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// NATS is a JetStream-enabled server with the streams of
// contracts/events/README.md.
type NATS struct {
	URL string
	NC  *nats.Conn
	JS  jetstream.JetStream
}

// Streams mirrors the stream table in contracts/events/README.md, with
// replicas 1 (single node) and a 2 minute duplicate window.
func Streams() []jetstream.StreamConfig {
	cfg := func(name, subjects string, maxAge time.Duration) jetstream.StreamConfig {
		return jetstream.StreamConfig{
			Name: name, Subjects: []string{subjects},
			Storage: jetstream.FileStorage, Replicas: 1,
			MaxAge: maxAge, Duplicates: 2 * time.Minute,
			Retention: jetstream.LimitsPolicy,
		}
	}
	return []jetstream.StreamConfig{
		cfg("VIDEO", "video.>", 7*24*time.Hour),
		cfg("USER", "user.>", 7*24*time.Hour),
		cfg("SOCIAL", "social.>", 7*24*time.Hour),
		cfg("DLQ", "dlq.>", 30*24*time.Hour),
	}
}

// StartNATS starts nats with JetStream and creates the contract streams.
func StartNATS(t testing.TB) *NATS {
	t.Helper()
	requireDocker(t)
	ctx := context.Background()

	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "nats:2.10-alpine",
			Cmd:          []string{"-js", "-sd", "/data"},
			ExposedPorts: []string{"4222/tcp"},
			WaitingFor:   wait.ForLog("Server is ready").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		t.Fatalf("testkit: start nats: %v", err)
	}
	testcontainers.CleanupContainer(t, c)

	host, err := c.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := c.MappedPort(ctx, "4222/tcp")
	if err != nil {
		t.Fatal(err)
	}
	url := "nats://" + host + ":" + port.Port()

	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("testkit: connect nats: %v", err)
	}
	t.Cleanup(nc.Close)
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	for _, sc := range Streams() {
		if _, err := js.CreateOrUpdateStream(ctx, sc); err != nil {
			t.Fatalf("testkit: create stream %s: %v", sc.Name, err)
		}
	}
	return &NATS{URL: url, NC: nc, JS: js}
}
