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
	// The payload goes through a jsonb column, which normalises whitespace, so
	// compare the data structurally.
	var data map[string]any
	if err := json.Unmarshal(got.Data, &data); err != nil {
		t.Fatal(err)
	}
	if got.Type != "video.uploaded" || got.Version != 1 || got.Producer != "upload-svc" ||
		len(data) != 1 || data["video_id"] != "v1" {
		t.Fatalf("bad envelope: %+v", got)
	}

	// published_at is committed just after the message is published.
	waitFor(t, 5*time.Second, "row marked published", func() bool {
		var pending int
		_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE published_at IS NULL`).Scan(&pending)
		return pending == 0
	})

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

// Production incident 2026-10-28: upload-svc, video-svc and the transcoder share media.outbox, and each NATS
// user may publish only its own subjects. A relay without Subjects took the transcoder's video.ready, was
// refused, and (a batch stops at the first failure) left every row behind it unpublished. With Subjects each
// relay publishes only its own rows, so a row it may not publish can neither fail nor block it.
func TestRelaySubjectsShareOneOutbox(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()

	tx, _ := pg.Pool.Begin(ctx)
	for _, subj := range []string{"video.ready", "video.audio_ready", "video.uploaded", "video.deleted"} {
		if err := outbox.Enqueue(ctx, tx, "media", subj, map[string]any{}); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// permits stands in for one NATS user's publish permissions.
	relay := func(subjects ...string) (*outbox.Relay, *permits) {
		p := &permits{allow: map[string]bool{}}
		for _, s := range subjects {
			p.allow[s] = true
		}
		return &outbox.Relay{Pool: pg.Pool, Publisher: p, Schema: "media", Subjects: subjects}, p
	}

	// Without a filter the upload relay is refused on the first foreign row and publishes nothing.
	unfiltered := &outbox.Relay{Pool: pg.Pool, Publisher: &permits{allow: map[string]bool{"video.uploaded": true}}, Schema: "media"}
	if n, err := unfiltered.PublishBatch(ctx); err == nil || n != 0 {
		t.Fatalf("unfiltered relay: n=%d err=%v; want a refusal on video.ready and nothing published", n, err)
	}

	upload, up := relay("video.uploaded", "video.audio_uploaded", "media.image_uploaded")
	if n, err := upload.PublishBatch(ctx); err != nil || n != 1 || len(up.seen) != 1 || up.seen[0] != "video.uploaded" {
		t.Fatalf("upload relay: n=%d err=%v seen=%v; want only video.uploaded", n, err, up.seen)
	}
	transcoder, tr := relay("video.ready", "video.failed", "video.uploaded", "video.audio_ready", "video.audio_failed")
	if n, err := transcoder.PublishBatch(ctx); err != nil || n != 2 {
		t.Fatalf("transcoder relay: n=%d err=%v seen=%v; want video.ready and video.audio_ready", n, err, tr.seen)
	}
	video, vd := relay("video.deleted", "video.moderated", "video.visibility_changed")
	if n, err := video.PublishBatch(ctx); err != nil || n != 1 || vd.seen[0] != "video.deleted" {
		t.Fatalf("video relay: n=%d err=%v seen=%v; want video.deleted", n, err, vd.seen)
	}
	var pending int
	if err := pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE published_at IS NULL`).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("%d rows left unpublished (%v)", pending, err)
	}
}

type permits struct {
	mu    sync.Mutex
	allow map[string]bool
	seen  []string
}

func (p *permits) Publish(_ context.Context, subject string, _ []byte, _ string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.allow[subject] {
		return errors.New("nats: permissions violation for publish to " + subject)
	}
	p.seen = append(p.seen, subject)
	return nil
}
