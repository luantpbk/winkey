package outbox_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/testkit"
)

func TestEnqueueRelayEndToEnd(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ns := testkit.StartNATS(t)
	ctx := context.Background()
	outbox.SetProducer("upload-svc")

	relay := &outbox.Relay{
		Pool: pg.Pool, Publisher: outbox.JetStreamPublisher{JS: ns.JS}, Schema: "media",
		Listen: true, PollInterval: time.Hour, // only NOTIFY can wake it
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { _ = relay.Run(rctx) }()

	// A rolled-back transaction must publish nothing.
	tx, _ := pg.Pool.Begin(ctx)
	if err := outbox.Enqueue(ctx, tx, "media", "video.uploaded", map[string]any{"video_id": "rolled-back"}); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)

	tx, _ = pg.Pool.Begin(ctx)
	if err := outbox.Enqueue(ctx, tx, "media", "video.uploaded", map[string]any{"video_id": "v1"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	cons, err := ns.JS.CreateOrUpdateConsumer(ctx, "VIDEO", jetstream.ConsumerConfig{
		FilterSubject: "video.uploaded", AckPolicy: jetstream.AckExplicitPolicy,
	})
	if err != nil {
		t.Fatal(err)
	}
	msgs, err := cons.Fetch(1, jetstream.FetchMaxWait(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	var got *outbox.Envelope
	for m := range msgs.Messages() {
		got = &outbox.Envelope{}
		if err := json.Unmarshal(m.Data(), got); err != nil {
			t.Fatal(err)
		}
		_ = m.Ack()
	}
	if got == nil {
		t.Fatal("event not delivered after commit")
	}
	if got.Type != "video.uploaded" || got.Version != 1 || got.Producer != "upload-svc" ||
		string(got.Data) != `{"video_id":"v1"}` {
		t.Fatalf("bad envelope: %+v", got)
	}

	var pending int
	if err := pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE published_at IS NULL`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("%d rows still pending", pending)
	}

	// Cleanup removes published rows older than the retention (fresh relay:
	// the first one keeps running with its own settings).
	cancel()
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.outbox SET published_at = now() - interval '8 days'`); err != nil {
		t.Fatal(err)
	}
	cleaner := &outbox.Relay{
		Pool: pg.Pool, Publisher: outbox.JetStreamPublisher{JS: ns.JS}, Schema: "media",
		PollInterval: 50 * time.Millisecond, CleanupInterval: 50 * time.Millisecond, Retention: 7 * 24 * time.Hour,
	}
	cctx, ccancel := context.WithCancel(ctx)
	defer ccancel()
	go func() { _ = cleaner.Run(cctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var n int
		_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox`).Scan(&n)
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("old published rows not deleted")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

type flaky struct {
	mu   sync.Mutex
	seen []string
	fail string
}

func (f *flaky) Publish(_ context.Context, subject string, _ []byte, msgID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if subject == f.fail {
		return errors.New("nats down")
	}
	f.seen = append(f.seen, msgID)
	return nil
}

func TestPublishBatchKeepsUnpublishedOnFailure(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()

	tx, _ := pg.Pool.Begin(ctx)
	for _, subj := range []string{"video.uploaded", "video.failed", "video.uploaded"} {
		if err := outbox.Enqueue(ctx, tx, "media", subj, map[string]any{}); err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit(ctx)

	pub := &flaky{fail: "video.failed"}
	relay := &outbox.Relay{Pool: pg.Pool, Publisher: pub, Schema: "media"}
	n, err := relay.PublishBatch(ctx)
	if err == nil || n != 1 {
		t.Fatalf("n=%d err=%v; want 1 published then error", n, err)
	}
	var pending int
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE published_at IS NULL`).Scan(&pending)
	if pending != 2 {
		t.Fatalf("pending=%d want 2", pending)
	}

	pub.fail = ""
	if n, err = relay.PublishBatch(ctx); err != nil || n != 2 {
		t.Fatalf("retry n=%d err=%v", n, err)
	}
}

func TestEnqueueRejectsBadSchema(t *testing.T) {
	if err := outbox.Enqueue(context.Background(), nil, `media"; drop table x; --`, "video.uploaded", 1); err == nil {
		t.Fatal("schema name must be validated")
	}
}
