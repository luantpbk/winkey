package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	promtest "github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/analytics"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Task R1 part A on real PostgreSQL 17: POST /v1/playback/heartbeats with the real visibility rules. The publisher is
// a capture in these tests; playback_nats_test.go publishes to a real JetStream. Every response is validated against
// video.v1.yaml and every event against analytics.playback.schema.json.

const itSalt = "integration-analytics-salt-0123456789abcdef"

type capture struct {
	mu   sync.Mutex
	msgs []analytics.Message
}

func (c *capture) Publish(_ context.Context, m analytics.Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.msgs = append(c.msgs, m)
	return nil
}

func (c *capture) sent() []analytics.Message {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]analytics.Message(nil), c.msgs...)
}

type playbackStack struct {
	t    *testing.T
	pg   *testkit.Postgres
	h    http.Handler
	spec *contract.Spec
	pub  analytics.Publisher
	cap  *capture
}

func startPlayback(t *testing.T, pub analytics.Publisher) *playbackStack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	cp := &capture{}
	if pub == nil {
		pub = cp
	}
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	h := &api.Handler{Store: &store.Postgres{Pool: pg.Pool}, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("integration-cursor-secret"), Log: log,
		Now:       func() time.Time { return time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC) },
		Analytics: pub, AnalyticsSalt: []byte(itSalt)}
	r := httpx.NewRouter("video-playback-it", log)
	h.Routes(r)
	return &playbackStack{t: t, pg: pg, h: r, spec: contract.Load(t), pub: pub, cap: cp}
}

func (s *playbackStack) post(a *actor, body string) (int, []byte) {
	s.t.Helper()
	req := httptest.NewRequest("POST", "/v1/playback/heartbeats", strings.NewReader(body))
	req.RemoteAddr = "198.51.100.10:4000"
	req.Header.Set("User-Agent", "integration-test/1")
	if a != nil {
		req.Header.Set("X-User-Id", a.id.String())
		req.Header.Set("X-User-Roles", a.roles)
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	s.spec.Check(s.t, "POST", "/v1/playback/heartbeats", w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w.Code, w.Body.Bytes()
}

func hbSample(pb, video uuid.UUID, kind string, seq int) map[string]any {
	m := map[string]any{"playback_id": pb.String(), "video_id": video.String(), "kind": kind, "seq": seq,
		"sent_at": "2026-10-01T11:59:58Z", "position_ms": 1000 * seq, "watched_ms": 30000, "rebuffer_ms": 0, "rebuffer_count": 0}
	if kind == "start" {
		m["startup_ms"] = 700
	}
	return m
}

func hbBatch(ss ...map[string]any) string {
	b, _ := json.Marshal(map[string]any{"samples": ss})
	return string(b)
}

var eventSchemaOnce *jsonschema.Schema

func analyticsEventSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	if eventSchemaOnce != nil {
		return eventSchemaOnce
	}
	dir := filepath.Join(testkit.RepoRoot(t), "contracts", "events")
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	for _, f := range []string{"envelope.schema.json", "analytics.playback.schema.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := c.AddResource("https://winkey.vn/contracts/events/"+f, doc); err != nil {
			t.Fatal(err)
		}
	}
	sc, err := c.Compile("https://winkey.vn/contracts/events/analytics.playback.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	eventSchemaOnce = sc
	return sc
}

func checkAnalyticsEvent(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if err := analyticsEventSchema(t).Validate(inst); err != nil {
		t.Fatalf("event violates its contract: %v\n%s", err, payload)
	}
	var env struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(payload, &env)
	return env.Data
}

func TestHeartbeatsOnPostgresKeepOnlyWhatTheCallerMayRead(t *testing.T) {
	s := startPlayback(t, nil)
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	ghost := testutil.SeedUser(t, s.pg.Pool, "ghost", nil, "SUSPENDED")
	owner := &actor{alice.ID, "viewer,creator"}
	bob := &actor{testutil.SeedUser(t, s.pg.Pool, "bobby", nil, "").ID, "viewer,creator"}
	mod := &actor{testutil.SeedUser(t, s.pg.Pool, "moddy", nil, "").ID, "viewer,moderator"}

	open := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID}).ID
	unlisted := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID, Visibility: "UNLISTED"}).ID
	private := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID, Visibility: "PRIVATE"}).ID
	hidden := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID, Hidden: true}).ID
	processing := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID, Status: "PROCESSING", Attempts: []float32{5}}).ID
	suspended := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: ghost.ID}).ID
	unknown := uuid.New()
	all := []uuid.UUID{open, unlisted, private, hidden, processing, suspended, unknown}
	batchOf := func() string {
		var ss []map[string]any
		for i, id := range all {
			ss = append(ss, hbSample(ids.New(), id, "heartbeat", i+1))
		}
		return hbBatch(ss...)
	}
	kept := func(a *actor) map[string]bool {
		before := len(s.cap.sent())
		code, body := s.post(a, batchOf())
		if code != 202 {
			t.Fatalf("%d %s", code, body)
		}
		out := map[string]bool{}
		fresh := s.cap.sent()[before:]
		if n := js[struct {
			Accepted int `json:"accepted"`
		}](t, body).Accepted; n != len(fresh) {
			t.Fatalf("accepted %d, published %d", n, len(fresh))
		}
		for _, m := range fresh {
			d := checkAnalyticsEvent(t, m.Payload)
			out[d["video_id"].(string)] = true
			if d["owner_id"] != alice.ID.String() && d["video_id"] != suspended.String() {
				t.Fatalf("owner_id %v", d["owner_id"]) // the channel of the video, not the caller's
			}
		}
		return out
	}
	want := func(ids ...uuid.UUID) map[string]bool {
		m := map[string]bool{}
		for _, id := range ids {
			m[id.String()] = true
		}
		return m
	}
	eq := func(name string, got, w map[string]bool) {
		t.Helper()
		if len(got) != len(w) {
			t.Fatalf("%s keeps %v, want %v", name, got, w)
		}
		for k := range w {
			if !got[k] {
				t.Fatalf("%s keeps %v, want %v", name, got, w)
			}
		}
	}
	eq("anonymous", kept(nil), want(open, unlisted))
	eq("another user", kept(bob), want(open, unlisted))
	eq("owner", kept(owner), want(open, unlisted, private, hidden)) // not the video of the suspended channel: it is not hers
	eq("moderator", kept(mod), want(open, unlisted, private, hidden, suspended))
}

func TestEventsCarryTheOwnerOfTheVideoAndNothingAboutTheClient(t *testing.T) {
	s := startPlayback(t, nil)
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	bobU := testutil.SeedUser(t, s.pg.Pool, "bobby", nil, "")
	bob := &actor{bobU.ID, "viewer"}
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID}).ID
	pb := ids.New()
	if code, body := s.post(bob, hbBatch(hbSample(pb, v, "start", 0), hbSample(pb, v, "heartbeat", 1), hbSample(pb, v, "end", 2))); code != 202 {
		t.Fatalf("%d %s", code, body)
	}
	msgs := s.cap.sent()
	if len(msgs) != 3 {
		t.Fatalf("%d events", len(msgs))
	}
	for i, m := range msgs {
		d := checkAnalyticsEvent(t, m.Payload)
		if d["owner_id"] != alice.ID.String() || d["authenticated"] != true || d["seq"] != float64(i) || m.ID != analytics.EventID(pb, i).String() {
			t.Fatalf("event %d: %v (%s)", i, d, m.ID)
		}
		if want := analytics.ViewerKey([]byte(itSalt), "u:"+bobU.ID.String()); d["viewer_key"] != want {
			t.Fatalf("viewer_key %v, want %s", d["viewer_key"], want)
		}
		for _, banned := range []string{"198.51.100.10", "integration-test", bobU.ID.String()} {
			if strings.Contains(string(m.Payload), banned) {
				t.Fatalf("%q in the event: %s", banned, m.Payload)
			}
		}
	}
}

// ---- a real JetStream ---------------------------------------------------------------------------------------------

func TestHeartbeatsReachTheAnalyticsStreamWithTheirMessageID(t *testing.T) {
	nt := testkit.StartNATS(t) // the contract streams, including ANALYTICS
	var refused sync.Map
	ajs, err := jetstream.New(nt.NC, analytics.JetStreamOptions(func(id string, err error) { refused.Store(id, err) })...)
	if err != nil {
		t.Fatal(err)
	}
	s := startPlayback(t, analytics.NewJetStreamPublisher(ajs))
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID}).ID
	pb := ids.New()

	body := hbBatch(hbSample(pb, v, "start", 0), hbSample(pb, v, "heartbeat", 1), hbSample(pb, v, "end", 2))
	if code, b := s.post(nil, body); code != 202 || js[struct {
		Accepted int `json:"accepted"`
	}](t, b).Accepted != 3 {
		t.Fatalf("%d %s", code, b)
	}
	// The client sends the same batch again (a retry): JetStream de-duplicates on Nats-Msg-Id, the stream holds 3.
	if code, _ := s.post(nil, body); code != 202 {
		t.Fatalf("%d", code)
	}
	select {
	case <-ajs.PublishAsyncComplete():
	case <-time.After(15 * time.Second):
		t.Fatal("publish acknowledgements did not arrive")
	}
	st, err := nt.JS.Stream(context.Background(), "ANALYTICS")
	if err != nil {
		t.Fatal(err)
	}
	info, err := st.Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.State.Msgs != 3 {
		t.Fatalf("%d messages in the stream, want 3 (the retry must be de-duplicated by Nats-Msg-Id)", info.State.Msgs)
	}
	cons, err := nt.JS.OrderedConsumer(context.Background(), "ANALYTICS", jetstream.OrderedConsumerConfig{FilterSubjects: []string{"analytics.playback"}})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		msg, err := cons.Next(jetstream.FetchMaxWait(10 * time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if msg.Subject() != "analytics.playback" || msg.Headers().Get(nats.MsgIdHdr) != analytics.EventID(pb, i).String() {
			t.Fatalf("message %d: %s %v", i, msg.Subject(), msg.Headers())
		}
		checkAnalyticsEvent(t, msg.Data())
	}
	n := 0
	refused.Range(func(_, _ any) bool { n++; return true })
	if n != 0 {
		t.Fatalf("%d messages refused by the stream", n)
	}
}

// No stream (the infrastructure is not there yet): the samples are dropped and counted, the player still gets a 202.
func TestHeartbeatsWithoutAStreamAreDroppedNotAnError(t *testing.T) {
	nt := testkit.StartNATS(t)
	if err := nt.JS.DeleteStream(context.Background(), "ANALYTICS"); err != nil {
		t.Fatal(err)
	}
	ajs, err := jetstream.New(nt.NC, analytics.JetStreamOptions(func(string, error) { analytics.CountPublishError() })...)
	if err != nil {
		t.Fatal(err)
	}
	s := startPlayback(t, analytics.NewJetStreamPublisher(ajs))
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID}).ID
	before := promtest.ToFloat64(analytics.SamplesTotal.WithLabelValues("publish_error"))
	code, body := s.post(nil, hbBatch(hbSample(ids.New(), v, "heartbeat", 1)))
	if code != http.StatusAccepted {
		t.Fatalf("%d %s", code, body)
	}
	deadline := time.Now().Add(15 * time.Second)
	for promtest.ToFloat64(analytics.SamplesTotal.WithLabelValues("publish_error")) <= before {
		if time.Now().After(deadline) {
			t.Fatal("the refused sample was not counted as publish_error")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
