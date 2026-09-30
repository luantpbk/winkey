package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/analytics/internal/event"
)

// ---- fakes -------------------------------------------------------------------------------------------------------

type fakeMsg struct {
	data       []byte
	seq        uint64
	acked      atomic.Int32
	termed     atomic.Int32
	inProgress atomic.Int32
	insertedAt func() bool // set by tests: true when the message's batch was already written
	ackedEarly *atomic.Bool
}

func (m *fakeMsg) Data() []byte { return m.data }
func (m *fakeMsg) Seq() uint64  { return m.seq }
func (m *fakeMsg) Ack() error {
	if m.insertedAt != nil && !m.insertedAt() && m.ackedEarly != nil {
		m.ackedEarly.Store(true)
	}
	m.acked.Add(1)
	return nil
}
func (m *fakeMsg) Term() error       { m.termed.Add(1); return nil }
func (m *fakeMsg) InProgress() error { m.inProgress.Add(1); return nil }

// fakeCH emulates what matters of ClickHouse: a block with an insert_deduplication_token already seen is dropped by
// the base table AND by the dependent materialized view (deduplicate_blocks_in_dependent_materialized_views = 1),
// and the hourly view sums whatever reaches it. It can fail the first `failFirst` inserts, optionally AFTER the
// block was committed (a timeout on the answer).
type fakeCH struct {
	mu          sync.Mutex
	tokens      map[string]bool
	rows        []event.Row
	calls       []string // the token of every call, in order
	sizes       []int
	failFirst   int
	commitFirst bool // the failing calls commit first
	hourlySum   uint64
	hourlyCount uint64
}

func (c *fakeCH) InsertBatch(_ context.Context, rows []event.Row, token string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, token)
	c.sizes = append(c.sizes, len(rows))
	commit := func() {
		if c.tokens == nil {
			c.tokens = map[string]bool{}
		}
		if c.tokens[token] {
			return // deduplicated: base table and view both drop the block
		}
		c.tokens[token] = true
		c.rows = append(c.rows, rows...)
		for _, r := range rows {
			c.hourlySum += uint64(r.WatchedMs)
			c.hourlyCount++
		}
	}
	if c.failFirst > 0 {
		c.failFirst--
		if c.commitFirst {
			commit()
		}
		return errors.New("clickhouse: connection reset")
	}
	commit()
	return nil
}

func (c *fakeCH) rowCount() int { c.mu.Lock(); defer c.mu.Unlock(); return len(c.rows) }

type fakeSource struct {
	mu      sync.Mutex
	batches [][]Msg
	maxes   []int
	err     error
	cancel  context.CancelFunc // called when the batches run out
}

func (s *fakeSource) Fetch(ctx context.Context, max int, _ time.Duration) ([]Msg, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maxes = append(s.maxes, max)
	if s.err != nil {
		return nil, s.err
	}
	if len(s.batches) == 0 {
		if s.cancel != nil {
			s.cancel()
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	b := s.batches[0]
	s.batches = s.batches[1:]
	return b, nil
}

func quiet() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func payload(n int, over string) []byte {
	id := uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("ev-%d", n)))
	return []byte(fmt.Sprintf(`{"event_id":%q,"type":"analytics.playback","version":1,"occurred_at":"2026-10-02T11:05:30Z","producer":"video-svc",%s"data":{"playback_id":"0192f5f1-aaaa-7000-8000-000000000001","video_id":"0192f5e1-0000-7000-8000-000000000010","owner_id":"0192f5e0-0000-7000-8000-000000000001","viewer_key":"%s","authenticated":false,"kind":"heartbeat","seq":%d,"received_at":"2026-10-02T11:05:30Z","sent_at":"2026-10-02T11:05:29Z","position_ms":%d,"watched_ms":1000,"rebuffer_ms":0,"rebuffer_count":0,"startup_ms":null,"rendition":null,"bitrate_kbps":null,"error_code":null,"client":"web","country":null}}`,
		id, over, strings.Repeat("a", 64), n, n*1000))
}

func msgs(first uint64, n int) []*fakeMsg {
	var out []*fakeMsg
	for i := 0; i < n; i++ {
		out = append(out, &fakeMsg{data: payload(int(first)+i, ""), seq: first + uint64(i)})
	}
	return out
}

func asMsgs(ms []*fakeMsg) []Msg {
	out := make([]Msg, len(ms))
	for i, m := range ms {
		out[i] = m
	}
	return out
}

func worker(src Source, ch Inserter) *Worker {
	return &Worker{Source: src, Inserter: ch, Log: quiet(), MaxBatch: 5000, MaxWait: time.Second,
		Backoff: func(int) time.Duration { return time.Millisecond }, KeepAliveEvery: time.Millisecond}
}

func count(ms []*fakeMsg, f func(*fakeMsg) int32) int {
	n := 0
	for _, m := range ms {
		n += int(f(m))
	}
	return n
}

// ---- tests -------------------------------------------------------------------------------------------------------

func TestABatchIsOneInsertWithTheSequenceRangeAsTokenAndAcksAfterIt(t *testing.T) {
	ch := &fakeCH{}
	ms := msgs(100, 7)
	var early atomic.Bool
	for _, m := range ms {
		m.insertedAt = func() bool { return ch.rowCount() > 0 }
		m.ackedEarly = &early
	}
	w := worker(nil, ch)
	if err := w.ProcessBatch(context.Background(), asMsgs(ms)); err != nil {
		t.Fatal(err)
	}
	if len(ch.calls) != 1 || ch.calls[0] != "100-106" || ch.sizes[0] != 7 || ch.rowCount() != 7 {
		t.Fatalf("calls %v sizes %v rows %d", ch.calls, ch.sizes, ch.rowCount())
	}
	if early.Load() {
		t.Fatal("a message was acknowledged before its rows were written")
	}
	for i, m := range ms {
		if m.acked.Load() != 1 || m.termed.Load() != 0 || ch.rows[i].EventID != uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("ev-%d", 100+i))) {
			t.Fatalf("message %d: acked %d termed %d", i, m.acked.Load(), m.termed.Load())
		}
	}
}

func TestMalformedUnknownVersionAndDuplicatesAreHandledPerMessage(t *testing.T) {
	ch := &fakeCH{}
	good := msgs(10, 3)
	bad := &fakeMsg{data: []byte(`garbage`), seq: 13}
	v2 := &fakeMsg{data: []byte(strings.Replace(string(payload(99, "")), `"version":1`, `"version":2`, 1)), seq: 14}
	dup := &fakeMsg{data: payload(10, ""), seq: 15} // the same sample as seq 10
	batch := []Msg{good[0], bad, good[1], v2, good[2], dup}
	if err := worker(nil, ch).ProcessBatch(context.Background(), batch); err != nil {
		t.Fatal(err)
	}
	if ch.rowCount() != 3 || ch.calls[0] != "10-12" { // the token spans the rows written, not the terminated or duplicate messages
		t.Fatalf("rows %d token %v", ch.rowCount(), ch.calls)
	}
	if bad.termed.Load() != 1 || bad.acked.Load() != 0 || v2.termed.Load() != 1 || v2.acked.Load() != 0 {
		t.Fatalf("malformed/unknown: %d/%d %d/%d", bad.termed.Load(), bad.acked.Load(), v2.termed.Load(), v2.acked.Load())
	}
	// A duplicate inside the block is acknowledged, not written (the hourly view would sum it twice).
	if dup.acked.Load() != 1 || dup.termed.Load() != 0 {
		t.Fatalf("duplicate: acked %d termed %d", dup.acked.Load(), dup.termed.Load())
	}
	for _, m := range good {
		if m.acked.Load() != 1 {
			t.Fatal("a valid message was not acknowledged")
		}
	}
}

func TestABatchWithNothingValidWritesNothing(t *testing.T) {
	ch := &fakeCH{}
	a, b := &fakeMsg{data: []byte(`x`), seq: 1}, &fakeMsg{data: []byte(`{}`), seq: 2}
	if err := worker(nil, ch).ProcessBatch(context.Background(), []Msg{a, b}); err != nil {
		t.Fatal(err)
	}
	if len(ch.calls) != 0 || a.termed.Load() != 1 || b.termed.Load() != 1 || a.acked.Load() != 0 {
		t.Fatalf("calls %v", ch.calls)
	}
}

// ClickHouse is down: the SAME batch (same rows, same token) is retried until it is written, nothing is acknowledged
// or terminated meanwhile, and the messages are kept alive with InProgress.
func TestAFailingInsertIsRetriedWithTheSameBatchAndToken(t *testing.T) {
	ch := &fakeCH{failFirst: 4}
	ms := msgs(500, 50)
	w := worker(nil, ch)
	w.Backoff = func(int) time.Duration { return 15 * time.Millisecond }
	if err := w.ProcessBatch(context.Background(), asMsgs(ms)); err != nil {
		t.Fatal(err)
	}
	if len(ch.calls) != 5 {
		t.Fatalf("%d attempts", len(ch.calls))
	}
	for i, tok := range ch.calls {
		if tok != "500-549" || ch.sizes[i] != 50 {
			t.Fatalf("attempt %d: token %s, %d rows", i, tok, ch.sizes[i])
		}
	}
	if ch.rowCount() != 50 || count(ms, func(m *fakeMsg) int32 { return m.acked.Load() }) != 50 || count(ms, func(m *fakeMsg) int32 { return m.termed.Load() }) != 0 {
		t.Fatal("after the retries every message must be written and acknowledged once, none terminated")
	}
	if count(ms, func(m *fakeMsg) int32 { return m.inProgress.Load() }) == 0 {
		t.Fatal("the messages were not kept alive while waiting for the database")
	}
}

// The INSERT committed but the answer was lost: the retry has the same token, so ClickHouse drops it and the hourly
// sums count the batch once (the reason for the token and for deduplicate_blocks_in_dependent_materialized_views).
func TestARetryOfACommittedBatchCountsOnce(t *testing.T) {
	ch := &fakeCH{failFirst: 2, commitFirst: true}
	ms := msgs(1, 100)
	if err := worker(nil, ch).ProcessBatch(context.Background(), asMsgs(ms)); err != nil {
		t.Fatal(err)
	}
	if len(ch.calls) != 3 || ch.rowCount() != 100 || ch.hourlyCount != 100 || ch.hourlySum != 100*1000 {
		t.Fatalf("attempts %d, rows %d, hourly count %d sum %d", len(ch.calls), ch.rowCount(), ch.hourlyCount, ch.hourlySum)
	}
}

func TestShuttingDownAbandonsTheBatchWithoutAcking(t *testing.T) {
	ch := &fakeCH{failFirst: 1 << 30} // down for good
	ms := msgs(1, 20)
	ctx, cancel := context.WithCancel(context.Background())
	w := worker(nil, ch)
	w.Backoff = func(int) time.Duration { return time.Hour }
	done := make(chan error, 1)
	go func() { done <- w.ProcessBatch(ctx, asMsgs(ms)) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("%v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ProcessBatch did not return after the context was cancelled")
	}
	if count(ms, func(m *fakeMsg) int32 { return m.acked.Load() + m.termed.Load() }) != 0 {
		t.Fatal("an abandoned batch must be neither acknowledged nor terminated (JetStream redelivers it)")
	}
}

func TestRunProcessesBatchesInOrderUntilCancelled(t *testing.T) {
	ch := &fakeCH{}
	ctx, cancel := context.WithCancel(context.Background())
	first, second := msgs(1, 5), msgs(6, 3)
	src := &fakeSource{batches: [][]Msg{asMsgs(first), nil, asMsgs(second)}, cancel: cancel}
	w := worker(src, ch)
	w.MaxBatch, w.MaxWait = 1234, 77*time.Millisecond
	if err := w.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if strings.Join(ch.calls, ",") != "1-5,6-8" || ch.rowCount() != 8 {
		t.Fatalf("calls %v rows %d", ch.calls, ch.rowCount())
	}
	if src.maxes[0] != 1234 {
		t.Fatalf("Fetch max %d", src.maxes[0])
	}
	// A fetch error ends the run (the caller restarts it).
	w2 := worker(&fakeSource{err: errors.New("nats down")}, ch)
	if err := w2.Run(context.Background()); err == nil {
		t.Fatal("a fetch error must be returned")
	}
}

func TestDefaultsAndBackoff(t *testing.T) {
	for attempt, want := range map[int]time.Duration{1: 5 * time.Second, 2: 10 * time.Second, 5: 25 * time.Second, 12: time.Minute, 13: time.Minute, 100: time.Minute} {
		if got := DefaultBackoff(attempt); got != want {
			t.Errorf("attempt %d: %v, want %v", attempt, got, want)
		}
	}
	w := &Worker{}
	w.defaults()
	if w.MaxBatch != 5000 || w.MaxWait != 2*time.Second || w.KeepAliveEvery != 20*time.Second || w.Backoff == nil {
		t.Fatalf("%+v", w)
	}
	if MaxDeliver != -1 || MaxAckPending != 20000 || AckWait != time.Minute || Durable != "analytics-clickhouse" || Stream != "ANALYTICS" {
		t.Fatal("consumer parameters changed")
	}
}
