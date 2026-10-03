// Package integration runs the analytics-worker against a real NATS JetStream and a real ClickHouse (testkit,
// containers). The tests skip without Docker and fail instead with WINKEY_REQUIRE_DOCKER=1.
package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	promtest "github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/analytics/internal/chdb"
	"github.com/luantpbk/winkey/services/analytics/internal/event"
	"github.com/luantpbk/winkey/services/analytics/internal/migrate"
	"github.com/luantpbk/winkey/services/analytics/internal/worker"
)

// proxy is a TCP relay in front of ClickHouse. Down() refuses new connections and cuts the open ones (what the
// worker sees when ClickHouse stops: an INSERT in flight fails, the next ones cannot connect); Up() lets it through
// again on the SAME address (a container that is stopped and started would get another port).
type proxy struct {
	target string
	addr   string
	mu     sync.Mutex
	ln     net.Listener
	conns  map[net.Conn]bool
}

func newProxy(t *testing.T, target string) *proxy {
	t.Helper()
	p := &proxy{target: target, conns: map[net.Conn]bool{}}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p.addr = ln.Addr().String()
	p.ln = ln
	go p.serve(ln)
	t.Cleanup(p.Down)
	return p
}

func (p *proxy) serve(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		up, err := net.DialTimeout("tcp", p.target, 5*time.Second)
		if err != nil {
			_ = c.Close()
			continue
		}
		p.mu.Lock()
		p.conns[c], p.conns[up] = true, true
		p.mu.Unlock()
		go func() { _, _ = io.Copy(up, c); _ = up.Close(); _ = c.Close() }()
		go func() { _, _ = io.Copy(c, up); _ = up.Close(); _ = c.Close() }()
	}
}

func (p *proxy) Down() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ln != nil {
		_ = p.ln.Close()
		p.ln = nil
	}
	for c := range p.conns {
		_ = c.Close()
	}
	p.conns = map[net.Conn]bool{}
}

func (p *proxy) Up(t *testing.T) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ln != nil {
		return
	}
	var err error
	for i := 0; i < 50; i++ { // the port may need a moment to be released
		var ln net.Listener
		if ln, err = net.Listen("tcp", p.addr); err == nil {
			p.ln = ln
			go p.serve(ln)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("proxy up: %v", err)
}

type stack struct {
	t     *testing.T
	nats  *testkit.NATS
	ch    *testkit.ClickHouse
	proxy *proxy
	conn  driver.Conn
	stop  context.CancelFunc
	done  chan struct{}
}

func migrationsDir(t *testing.T) string {
	return filepath.Join(testkit.RepoRoot(t), "db", "clickhouse")
}

func quiet() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func startStack(t *testing.T) *stack {
	t.Helper()
	s := &stack{t: t, nats: testkit.StartNATS(t), ch: testkit.StartClickHouse(t)}
	s.proxy = newProxy(t, s.ch.Addr)
	conn, err := chdb.Open(chdb.Options{Addr: s.proxy.addr, User: "default"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	s.conn = conn
	return s
}

func (s *stack) migrate() []string {
	s.t.Helper()
	applied, err := migrate.Apply(context.Background(), chdb.Migrations{Conn: s.conn}, migrationsDir(s.t), quiet())
	if err != nil {
		s.t.Fatal(err)
	}
	return applied
}

// startWorker runs a worker; it can be stopped with stopWorker and started again (a restart).
func (s *stack) startWorker() {
	s.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	s.stop, s.done = cancel, make(chan struct{})
	src := &worker.JetStreamSource{JS: s.nats.JS, Log: quiet(), RetryEvery: 100 * time.Millisecond}
	w := &worker.Worker{Source: src, Inserter: &chdb.Inserter{Conn: s.conn}, Log: quiet(), MaxBatch: 5000, MaxWait: 300 * time.Millisecond,
		Backoff: func(int) time.Duration { return 300 * time.Millisecond }, KeepAliveEvery: 5 * time.Second}
	go func() { defer close(s.done); _ = w.Run(ctx) }()
	s.t.Cleanup(s.stopWorker)
}

func (s *stack) stopWorker() {
	if s.stop != nil {
		s.stop()
		<-s.done
		s.stop = nil
	}
}

// ---- events ------------------------------------------------------------------------------------------------------

type sample struct {
	id                                        uuid.UUID
	video, playback, owner                    uuid.UUID
	viewer                                    string
	kind                                      string
	seq                                       int
	received                                  time.Time
	watched, rebuffer, rebufferCount, startup int
	hasStartup                                bool
	errCode                                   *string
}

func (sm sample) payload() []byte {
	d := map[string]any{
		"playback_id": sm.playback.String(), "video_id": sm.video.String(), "owner_id": sm.owner.String(), "viewer_key": sm.viewer,
		"authenticated": false, "kind": sm.kind, "seq": sm.seq, "received_at": sm.received.Format(time.RFC3339Nano),
		"sent_at": sm.received.Add(-time.Second).Format(time.RFC3339Nano), "position_ms": sm.seq * 1000, "watched_ms": sm.watched,
		"rebuffer_ms": sm.rebuffer, "rebuffer_count": sm.rebufferCount, "startup_ms": nil, "rendition": "720p", "bitrate_kbps": 2800,
		"error_code": sm.errCode, "client": "web", "country": nil,
	}
	if sm.hasStartup {
		d["startup_ms"] = sm.startup
	}
	b, _ := json.Marshal(map[string]any{"event_id": sm.id.String(), "type": "analytics.playback", "version": 1,
		"occurred_at": sm.received.Format(time.RFC3339), "producer": "video-svc", "data": d})
	return b
}

func viewerKey(i int) string { return fmt.Sprintf("%064x", i+1) }

// generate makes n samples over 4 videos, 3 hours and 40 viewers, deterministic for a seed.
func generate(n int, seed int64, first int) []sample {
	rnd := rand.New(rand.NewSource(seed))
	videos := make([]uuid.UUID, 4)
	owners := make([]uuid.UUID, 4)
	for i := range videos {
		videos[i] = uuid.NewSHA1(uuid.NameSpaceURL, []byte(fmt.Sprintf("video-%d", i)))
		owners[i] = uuid.NewSHA1(uuid.NameSpaceURL, []byte(fmt.Sprintf("owner-%d", i%2)))
	}
	base := time.Date(2026, 10, 1, 10, 7, 0, 0, time.UTC)
	out := make([]sample, n)
	for i := range out {
		vi := rnd.Intn(len(videos))
		sm := sample{
			video: videos[vi], owner: owners[vi], playback: uuid.NewSHA1(uuid.NameSpaceURL, []byte(fmt.Sprintf("pb-%d", (first+i)/5))),
			viewer: viewerKey(rnd.Intn(40)), seq: (first + i) % 5,
			received: base.Add(time.Duration(rnd.Intn(3*3600)) * time.Second).Truncate(time.Millisecond),
			watched:  rnd.Intn(30001), rebuffer: rnd.Intn(800), rebufferCount: rnd.Intn(3),
		}
		sm.id = uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("%s:%d:%d", sm.playback, sm.seq, first+i)))
		switch {
		case sm.seq == 0:
			sm.kind, sm.hasStartup, sm.startup = "start", true, 200+rnd.Intn(2000)
		case sm.seq == 4 && rnd.Intn(4) == 0:
			sm.kind = "end"
			e := "manifestLoadError"
			sm.errCode = &e
		case sm.seq == 4:
			sm.kind = "end"
		default:
			sm.kind = "heartbeat"
		}
		out[i] = sm
	}
	return out
}

func (s *stack) publish(samples []sample) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Bound the outstanding publishes below JetStream's default async limit (256). Otherwise a busy
	// Docker host can exhaust its 200 ms stall wait before the fixture has even reached the worker.
	const window = 128
	var pending []jetstream.PubAckFuture
	for i, sm := range samples {
		msg := &nats.Msg{Subject: "analytics.playback", Data: sm.payload(), Header: nats.Header{}}
		msg.Header.Set(nats.MsgIdHdr, sm.id.String())
		ack, err := s.nats.JS.PublishMsgAsync(msg)
		if err != nil {
			s.t.Fatal(err)
		}
		pending = append(pending, ack)
		if len(pending) < window && i != len(samples)-1 {
			continue
		}
		for _, ack := range pending {
			select {
			case <-ack.Ok():
			case err := <-ack.Err():
				s.t.Fatalf("publish failed: %v", err)
			case <-ctx.Done():
				s.t.Fatal("publish did not complete")
			}
		}
		pending = pending[:0]
	}
}

type hourKey struct {
	hour  uint32
	video uuid.UUID
}

type sums struct{ samples, starts, watched, rebuffer, rebufferCount, errors, viewers uint64 }

func expected(samples []sample) map[hourKey]sums {
	out := map[hourKey]sums{}
	viewers := map[hourKey]map[string]bool{}
	for _, sm := range samples {
		k := hourKey{uint32(sm.received.Truncate(time.Hour).Unix()), sm.video}
		v := out[k]
		v.samples++
		if sm.kind == "start" {
			v.starts++
		}
		v.watched += uint64(sm.watched)
		v.rebuffer += uint64(sm.rebuffer)
		v.rebufferCount += uint64(sm.rebufferCount)
		if sm.kind == "end" && sm.errCode != nil {
			v.errors++
		}
		if viewers[k] == nil {
			viewers[k] = map[string]bool{}
		}
		viewers[k][sm.viewer] = true
		v.viewers = uint64(len(viewers[k]))
		out[k] = v
	}
	return out
}

func (s *stack) hourly() map[hourKey]sums {
	s.t.Helper()
	rows, err := s.conn.Query(context.Background(), `
		SELECT toUnixTimestamp(hour), video_id, sum(samples), sum(starts), sum(watched_ms), sum(rebuffer_ms),
		       sum(rebuffer_count), sum(errors), uniqMerge(viewers)
		FROM winkey.video_qoe_hourly GROUP BY hour, video_id`)
	if err != nil {
		s.t.Fatal(err)
	}
	defer rows.Close()
	out := map[hourKey]sums{}
	for rows.Next() {
		var h uint32
		var v uuid.UUID
		var x sums
		if err := rows.Scan(&h, &v, &x.samples, &x.starts, &x.watched, &x.rebuffer, &x.rebufferCount, &x.errors, &x.viewers); err != nil {
			s.t.Fatal(err)
		}
		out[hourKey{h, v}] = x
	}
	return out
}

func (s *stack) count() uint64 {
	var n uint64
	if err := s.conn.QueryRow(context.Background(), `SELECT count() FROM winkey.playback_events`).Scan(&n); err != nil {
		return 0 // ClickHouse may be unreachable (the proxy is down)
	}
	return n
}

func waitFor(t *testing.T, d time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (s *stack) info() *jetstream.ConsumerInfo {
	s.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		c, err := s.nats.JS.Consumer(context.Background(), worker.Stream, worker.Durable)
		if err == nil {
			if info, err := c.Info(context.Background()); err == nil {
				return info
			}
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("the durable does not exist: %v", err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func assertSums(t *testing.T, got, want map[hourKey]sums) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%d hourly groups, want %d", len(got), len(want))
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("hour %d video %s:\n got %+v\nwant %+v", k.hour, k.video, got[k], w)
		}
	}
}

// ---- tests -------------------------------------------------------------------------------------------------------

func TestMigrationsAreAppliedOnceAndTheSchemaIsThere(t *testing.T) {
	s := startStack(t)
	if got := s.migrate(); len(got) != 1 || got[0] != "0001_playback.sql" {
		t.Fatalf("first start applied %v", got)
	}
	if got := s.migrate(); len(got) != 0 { // the second start is a no-op
		t.Fatalf("second start applied %v", got)
	}
	var n uint64
	if err := s.conn.QueryRow(context.Background(), `SELECT count() FROM winkey.schema_migrations`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("schema_migrations rows: %d %v", n, err)
	}
	for _, table := range []string{"playback_events", "video_qoe_hourly", "video_qoe_hourly_mv", "schema_migrations"} {
		var c uint64
		if err := s.conn.QueryRow(context.Background(), `SELECT count() FROM system.tables WHERE database = 'winkey' AND name = ?`, table).Scan(&c); err != nil || c != 1 {
			t.Fatalf("table %s: %d %v", table, c, err)
		}
	}
}

func TestTenThousandEventsGiveTenThousandRowsAndExactHourlySums(t *testing.T) {
	s := startStack(t)
	s.migrate()
	samples := generate(10000, 42, 0)
	s.publish(samples)
	s.startWorker()
	waitFor(t, 120*time.Second, "10 000 rows", func() bool { return s.count() == 10000 })
	waitFor(t, 30*time.Second, "all acknowledged", func() bool { i := s.info(); return i.NumPending == 0 && i.NumAckPending == 0 })
	if n := s.count(); n != 10000 {
		t.Fatalf("%d rows", n)
	}
	assertSums(t, s.hourly(), expected(samples))
	// A few raw columns, to catch a wrong column order.
	var kind, client, rendition string
	var startup *uint32
	var authenticated bool
	if err := s.conn.QueryRow(context.Background(), `SELECT kind, client, assumeNotNull(rendition), startup_ms, authenticated FROM winkey.playback_events WHERE kind = 'start' LIMIT 1`).Scan(&kind, &client, &rendition, &startup, &authenticated); err != nil {
		t.Fatal(err)
	}
	if kind != "start" || client != "web" || rendition != "720p" || startup == nil || authenticated {
		t.Fatalf("%s %s %s %v %v", kind, client, rendition, startup, authenticated)
	}
}

// ClickHouse goes away in the middle of the run: nothing is acknowledged that was not written, nothing is lost, and
// after it is back every row is there exactly once and the hourly sums are exact (the dedup token of a retried batch
// plus deduplicate_blocks_in_dependent_materialized_views).
func TestClickHouseDownMidRunLosesNothingAndSumsStayExact(t *testing.T) {
	s := startStack(t)
	s.migrate()
	first, second := generate(4000, 7, 0), generate(6000, 8, 4000)
	all := append(append([]sample{}, first...), second...)
	s.publish(first)
	s.startWorker()
	waitFor(t, 60*time.Second, "some rows before the outage", func() bool { return s.count() >= 1000 })

	s.proxy.Down()
	s.publish(second) // more arrives while ClickHouse is away
	time.Sleep(3 * time.Second)
	info := s.info()
	if info.NumPending == 0 && info.NumAckPending == 0 {
		t.Fatal("during the outage everything was acknowledged: the worker acknowledged rows it could not have written")
	}

	// Restart the worker while ClickHouse is still down: the unacknowledged messages are redelivered.
	s.stopWorker()
	s.startWorker()
	time.Sleep(2 * time.Second)
	s.proxy.Up(t)
	waitFor(t, 180*time.Second, "all 10 000 rows after the outage", func() bool { return s.count() == 10000 })
	waitFor(t, 30*time.Second, "all acknowledged", func() bool { i := s.info(); return i.NumPending == 0 && i.NumAckPending == 0 })
	if n := s.count(); n != 10000 {
		t.Fatalf("%d rows, want exactly 10000 (no loss, no duplicate)", n)
	}
	assertSums(t, s.hourly(), expected(all))
}

type lostInsertResponse struct {
	*chdb.Inserter
	cancel context.CancelFunc
}

func (i lostInsertResponse) InsertBatch(ctx context.Context, rows []event.Row, token string) error {
	if err := i.Inserter.InsertBatch(ctx, rows, token); err != nil {
		return err
	}
	i.cancel()
	return context.Canceled // the database committed, but the worker never received confirmation
}

func TestRedeliveryAfterAnUnconfirmedCommitKeepsExactSums(t *testing.T) {
	s := startStack(t)
	s.migrate()
	first, second := generate(100, 7, 0), generate(100, 8, 100)
	s.publish(first)
	src := &worker.JetStreamSource{JS: s.nats.JS, Log: quiet()}
	batch, err := src.Fetch(context.Background(), 5000, time.Second)
	if err != nil || len(batch) != len(first) {
		t.Fatalf("initial fetch: %d messages, %v", len(batch), err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inserter := &chdb.Inserter{Conn: s.conn}
	w := &worker.Worker{Inserter: lostInsertResponse{inserter, cancel}, Log: quiet()}
	if err := w.ProcessBatch(ctx, batch); !errors.Is(err, context.Canceled) {
		t.Fatalf("unconfirmed INSERT: %v", err)
	}
	if info := s.info(); s.count() != 100 || info.NumAckPending != 100 {
		t.Fatalf("committed rows %d, ACK pending %d: unconfirmed messages must not be acknowledged", s.count(), info.NumAckPending)
	}
	s.publish(second)
	restarted := &worker.JetStreamSource{JS: s.nats.JS, Log: quiet()}
	batch, err = restarted.Fetch(context.Background(), 5000, time.Second)
	if err != nil || len(batch) != 200 {
		t.Fatalf("mixed redelivery: %d messages, %v", len(batch), err)
	}
	redelivered := 0
	for _, m := range batch {
		if m.Redelivered() {
			redelivered++
		}
	}
	if redelivered != 100 {
		t.Fatalf("redelivered %d, want the 100 committed messages", redelivered)
	}
	w = &worker.Worker{Inserter: inserter, Log: quiet()}
	if err := w.ProcessBatch(context.Background(), batch); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 30*time.Second, "mixed batch acknowledged", func() bool { i := s.info(); return i.NumPending == 0 && i.NumAckPending == 0 })
	if n := s.count(); n != 200 {
		t.Fatalf("%d rows, want exactly 200 (no loss, no duplicate)", n)
	}
	assertSums(t, s.hourly(), expected(append(first, second...)))
}

func TestMalformedMessagesAreTerminatedAndTheRestIsInserted(t *testing.T) {
	s := startStack(t)
	s.migrate()
	samples := generate(300, 3, 0)
	ctx := context.Background()
	for i, sm := range samples {
		if i%50 == 0 { // poison in between
			if _, err := s.nats.JS.PublishMsg(ctx, &nats.Msg{Subject: "analytics.playback", Data: []byte(fmt.Sprintf(`{"not":"an event %d"}`, i))}); err != nil {
				t.Fatal(err)
			}
		}
		msg := &nats.Msg{Subject: "analytics.playback", Data: sm.payload(), Header: nats.Header{}}
		msg.Header.Set(nats.MsgIdHdr, sm.id.String())
		if _, err := s.nats.JS.PublishMsg(ctx, msg); err != nil {
			t.Fatal(err)
		}
	}
	before := promtest.ToFloat64(worker.MessagesMalformed())
	s.startWorker()
	waitFor(t, 60*time.Second, "300 rows", func() bool { return s.count() == 300 })
	waitFor(t, 30*time.Second, "queue drained", func() bool { i := s.info(); return i.NumPending == 0 && i.NumAckPending == 0 })
	time.Sleep(time.Second)
	if info := s.info(); info.NumRedelivered != 0 {
		t.Fatalf("poison messages were redelivered: %+v", info)
	}
	if got := promtest.ToFloat64(worker.MessagesMalformed()) - before; got != 6 {
		t.Fatalf("malformed metric +%v, want 6", got)
	}
	assertSums(t, s.hourly(), expected(samples))
}

// The same sample published twice: JetStream drops the second when the Nats-Msg-Id matches; when it does not (a resend
// after the 2 minute window) the worker counts it once.
func TestADuplicateSampleIsCountedOnce(t *testing.T) {
	s := startStack(t)
	s.migrate()
	samples := generate(200, 5, 0)
	s.publish(samples)
	s.publish(samples[:50])           // same Nats-Msg-Id: de-duplicated by the stream
	for _, sm := range samples[:30] { // another id for the same event_id: a resend the stream cannot recognise
		msg := &nats.Msg{Subject: "analytics.playback", Data: sm.payload(), Header: nats.Header{}}
		msg.Header.Set(nats.MsgIdHdr, uuid.NewString())
		if _, err := s.nats.JS.PublishMsg(context.Background(), msg); err != nil {
			t.Fatal(err)
		}
	}
	s.startWorker()
	waitFor(t, 60*time.Second, "the samples", func() bool { return s.count() >= 200 })
	waitFor(t, 30*time.Second, "queue drained", func() bool { i := s.info(); return i.NumPending == 0 && i.NumAckPending == 0 })
	time.Sleep(time.Second)
	if n := s.count(); n != 200 {
		t.Fatalf("%d rows for 200 distinct samples", n)
	}
	assertSums(t, s.hourly(), expected(samples))
}

func TestTheDurableMatchesTheContract(t *testing.T) {
	s := startStack(t)
	s.migrate()
	s.startWorker()
	c := s.info().Config
	if c.Durable != "analytics-clickhouse" || c.FilterSubject != "analytics.playback" || c.DeliverPolicy != jetstream.DeliverAllPolicy ||
		c.AckPolicy != jetstream.AckExplicitPolicy || c.AckWait != time.Minute || c.MaxDeliver != -1 || c.MaxAckPending != 20000 {
		t.Fatalf("%+v", c)
	}
}

// The worker starts before the stream exists and picks it up when it appears.
func TestWorkerWaitsForTheStream(t *testing.T) {
	s := startStack(t)
	s.migrate()
	if err := s.nats.JS.DeleteStream(context.Background(), worker.Stream); err != nil {
		t.Fatal(err)
	}
	s.startWorker()
	time.Sleep(time.Second)
	for _, sc := range testkit.Streams() {
		if sc.Name == worker.Stream {
			if _, err := s.nats.JS.CreateStream(context.Background(), sc); err != nil {
				t.Fatal(err)
			}
		}
	}
	samples := generate(100, 9, 0)
	s.publish(samples)
	waitFor(t, 90*time.Second, "the samples after the stream appeared", func() bool { return s.count() == 100 })
	assertSums(t, s.hourly(), expected(samples))
}
