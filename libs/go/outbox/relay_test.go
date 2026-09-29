package outbox_test

import (
	"context"
	"testing"
	"time"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/testkit"
)

// The relay must wake up on the NOTIFY sent by Enqueue when its transaction
// commits (polling is set to an hour, so only NOTIFY can explain a prompt
// publish), publish nothing for rolled-back transactions, mark rows published,
// and delete published rows older than the retention.
func TestRelayWakesOnNotifyAndCleansUp(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()

	pub := &flaky{}
	relay := &outbox.Relay{
		Pool: pg.Pool, Publisher: pub, Schema: "media", Listen: true,
		PollInterval: time.Hour, CleanupInterval: 100 * time.Millisecond, Retention: 7 * 24 * time.Hour,
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { _ = relay.Run(rctx) }()
	time.Sleep(500 * time.Millisecond) // let LISTEN establish

	rolled, _ := pg.Pool.Begin(ctx)
	if err := outbox.Enqueue(ctx, rolled, "media", "video.uploaded", map[string]any{"n": 0}); err != nil {
		t.Fatal(err)
	}
	_ = rolled.Rollback(ctx)

	tx, _ := pg.Pool.Begin(ctx)
	if err := outbox.Enqueue(ctx, tx, "media", "video.uploaded", map[string]any{"n": 1}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	waitFor(t, 5*time.Second, "publish after commit", func() bool {
		pub.mu.Lock()
		defer pub.mu.Unlock()
		return len(pub.seen) == 1
	})
	waitFor(t, 5*time.Second, "published_at set", func() bool {
		var n int
		_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE published_at IS NOT NULL`).Scan(&n)
		return n == 1
	})

	// Old published rows are removed; recent ones stay.
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.outbox SET published_at = now() - interval '8 days'`); err != nil {
		t.Fatal(err)
	}
	tx, _ = pg.Pool.Begin(ctx)
	_ = outbox.Enqueue(ctx, tx, "media", "video.ready", map[string]any{"n": 2})
	_ = tx.Commit(ctx)
	waitFor(t, 5*time.Second, "old row cleaned, new row kept", func() bool {
		var old, total int
		_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE published_at < now() - interval '7 days'`).Scan(&old)
		_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox`).Scan(&total)
		return old == 0 && total == 1
	})
}

func waitFor(t *testing.T, d time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
