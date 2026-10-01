package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/analytics"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/views"
)

const testAnalyticsSalt = "test-analytics-salt-0123456789abcdef-xyz"

// fakePublisher records what would go to JetStream.
type fakePublisher struct {
	mu   sync.Mutex
	msgs []analytics.Message
	err  error
}

func (f *fakePublisher) Publish(_ context.Context, m analytics.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.msgs = append(f.msgs, m)
	return nil
}

func (f *fakePublisher) sent() []analytics.Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]analytics.Message(nil), f.msgs...)
}

type pbEnv struct {
	*env
	pub *fakePublisher
}

func newPlaybackEnv(t *testing.T, lim Limiter) *pbEnv {
	t.Helper()
	e := &env{t: t, store: newMemStore(), spec: contract.Load(t)}
	pub := &fakePublisher{}
	proxies, _ := views.ParseCIDRs([]string{"10.42.0.0/16"})
	h := &Handler{Store: e.store, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("test-cursor-secret-123456"), Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		Now: func() time.Time { return testNow }, Limiter: lim, TrustedProxies: proxies, HeartbeatRateLimit: 30,
		Analytics: pub, AnalyticsSalt: []byte(testAnalyticsSalt)}
	r := httpx.NewRouter("video-test", h.Log)
	h.Routes(r)
	e.h = r
	return &pbEnv{env: e, pub: pub}
}

// post sends a batch (raw JSON) and checks the response against the contract.
type postOpts struct {
	who    *who
	remote string
	ua     string
	xff    string
}

func (e *pbEnv) post(o postOpts, body string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest("POST", "/v1/playback/heartbeats", strings.NewReader(body))
	req.RemoteAddr = "198.51.100.10:4000"
	if o.remote != "" {
		req.RemoteAddr = o.remote
	}
	if o.ua != "" {
		req.Header.Set("User-Agent", o.ua)
	}
	if o.xff != "" {
		req.Header.Set("X-Forwarded-For", o.xff)
	}
	if o.who != nil {
		req.Header.Set("X-User-Id", o.who.id.String())
		req.Header.Set("X-User-Roles", o.who.roles)
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	e.spec.Check(e.t, "POST", "/v1/playback/heartbeats", w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	return w
}

func sampleJSON(playback, video uuid.UUID, kind string, seq int, over map[string]any) map[string]any {
	m := map[string]any{
		"playback_id": playback.String(), "video_id": video.String(), "kind": kind, "seq": seq,
		"sent_at": "2026-10-01T11:59:58Z", "position_ms": 1500 * seq, "watched_ms": 30000, "rebuffer_ms": 450, "rebuffer_count": 1,
	}
	if kind == "start" {
		m["startup_ms"] = 820
	}
	for k, v := range over {
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	return m
}

func batch(samples ...map[string]any) string {
	b, _ := json.Marshal(map[string]any{"samples": samples})
	return string(b)
}

func accepted(t *testing.T, w *httptest.ResponseRecorder) int {
	t.Helper()
	if w.Code != http.StatusAccepted {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	return decode[heartbeatResult](t, w).Accepted
}

// ---- schema check of the published events --------------------------------------------------------------------------

var analyticsSchema *jsonschema.Schema

func eventSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	if analyticsSchema != nil {
		return analyticsSchema
	}
	dir := ""
	wd, _ := os.Getwd()
	for i := 0; i < 8; i++ {
		if st, err := os.Stat(filepath.Join(wd, "contracts", "events")); err == nil && st.IsDir() {
			dir = filepath.Join(wd, "contracts", "events")
			break
		}
		wd = filepath.Dir(wd)
	}
	if dir == "" {
		t.Fatal("contracts/events not found")
	}
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
	s, err := c.Compile("https://winkey.vn/contracts/events/analytics.playback.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	analyticsSchema = s
	return s
}

func validateEvent(t *testing.T, payload []byte) {
	t.Helper()
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if err := eventSchema(t).Validate(inst); err != nil {
		t.Fatalf("the event violates analytics.playback.schema.json: %v\n%s", err, payload)
	}
}

func dataOf(t *testing.T, payload []byte) (map[string]any, string) {
	t.Helper()
	var env struct {
		EventID    string         `json:"event_id"`
		Type       string         `json:"type"`
		Version    int            `json:"version"`
		OccurredAt string         `json:"occurred_at"`
		Producer   string         `json:"producer"`
		Data       map[string]any `json:"data"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "analytics.playback" || env.Version != 1 || env.Producer != "video-svc" {
		t.Fatalf("envelope: %+v", env)
	}
	return env.Data, env.EventID
}

// ---- tests -----------------------------------------------------------------------------------------------------------

func TestHeartbeatsPublishOneEventPerAcceptedSample(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	v := e.video(alice)
	pb := ids.New()
	over := map[string]any{"rendition": "720p", "bitrate_kbps": 2800, "client": "ios"}
	w := e.post(postOpts{}, batch(
		sampleJSON(pb, v.ID, "start", 0, over),
		sampleJSON(pb, v.ID, "heartbeat", 1, over),
		sampleJSON(pb, v.ID, "end", 2, map[string]any{"error_code": "manifestLoadError"})))
	if n := accepted(t, w); n != 3 {
		t.Fatalf("accepted %d", n)
	}
	msgs := e.pub.sent()
	if len(msgs) != 3 {
		t.Fatalf("%d events", len(msgs))
	}
	for i, m := range msgs {
		validateEvent(t, m.Payload)
		d, eventID := dataOf(t, m.Payload)
		// Nats-Msg-Id == event_id == UUIDv5(playback_id:seq): a sample sent again is de-duplicated by JetStream.
		if want := analytics.EventID(pb, i).String(); m.ID != want || eventID != want {
			t.Fatalf("event %d: msg id %s, event_id %s, want %s", i, m.ID, eventID, want)
		}
		if d["playback_id"] != pb.String() || d["video_id"] != v.ID.String() || d["owner_id"] != alice.id.String() ||
			d["authenticated"] != false || d["seq"] != float64(i) || d["received_at"] != "2026-10-01T12:00:00Z" ||
			d["sent_at"] != "2026-10-01T11:59:58Z" || d["country"] != nil || d["watched_ms"] != float64(30000) {
			t.Fatalf("event %d data: %v", i, d)
		}
		if k, _ := d["viewer_key"].(string); !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(k) {
			t.Fatalf("viewer_key %v", d["viewer_key"])
		}
	}
	d0, _ := dataOf(t, msgs[0].Payload)
	d2, _ := dataOf(t, msgs[2].Payload)
	if d0["startup_ms"] != float64(820) || d0["rendition"] != "720p" || d0["bitrate_kbps"] != float64(2800) || d0["client"] != "ios" ||
		d2["startup_ms"] != nil || d2["error_code"] != "manifestLoadError" {
		t.Fatalf("optional fields: %v / %v", d0, d2)
	}
	// Defaults: no client → web; nulls stay null.
	e.pub.msgs = nil
	e.post(postOpts{}, batch(sampleJSON(ids.New(), v.ID, "heartbeat", 3, map[string]any{"rendition": nil})))
	dd, _ := dataOf(t, e.pub.sent()[0].Payload)
	if dd["client"] != "web" || dd["rendition"] != nil || dd["bitrate_kbps"] != nil || dd["error_code"] != nil || dd["startup_ms"] != nil {
		t.Fatalf("defaults: %v", dd)
	}
	validateEvent(t, e.pub.sent()[0].Payload)
}

func TestTheSameSampleAlwaysGetsTheSameEventID(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	v := e.video(alice)
	pb := ids.New()
	s := sampleJSON(pb, v.ID, "heartbeat", 4, nil)
	e.post(postOpts{}, batch(s))
	e.post(postOpts{who: bob}, batch(s)) // sent again, by anyone, later
	msgs := e.pub.sent()
	if len(msgs) != 2 || msgs[0].ID != msgs[1].ID || msgs[0].ID != analytics.EventID(pb, 4).String() {
		t.Fatalf("%+v", msgs)
	}
	if analytics.EventID(pb, 4) == analytics.EventID(pb, 5) || analytics.EventID(pb, 4) == analytics.EventID(ids.New(), 4) {
		t.Fatal("event ids must differ per (playback, seq)")
	}
	// Golden: the UUIDv5 of a fixed playback and seq (computed independently).
	if got := analytics.EventID(uuid.MustParse("0192f5f1-aaaa-7000-8000-000000000001"), 4).String(); got != "4937106c-ecd7-5857-9a4a-68c4d62fc0b6" {
		t.Fatalf("event id %s", got)
	}
}

func TestSamplesOfVideosTheCallerCannotReadAreDroppedSilently(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	open := e.video(alice)
	private := e.video(alice, visibility(domain.VisPrivate))
	hidden := e.video(alice, func(v *domain.Video) { v.ModerationState = domain.ModHidden })
	processing := e.video(alice, notReady(domain.StatusProcessing))
	ghost := e.video(alice, func(v *domain.Video) { v.Owner.Missing = true })
	unlisted := e.video(alice, visibility(domain.VisUnlisted))
	unknown := ids.New()
	all := func() string {
		var ss []map[string]any
		for i, id := range []uuid.UUID{open.ID, private.ID, hidden.ID, processing.ID, ghost.ID, unlisted.ID, unknown} {
			ss = append(ss, sampleJSON(ids.New(), id, "heartbeat", i+1, nil))
		}
		return batch(ss...)
	}
	countKept := func(o postOpts) []string {
		e.pub.msgs = nil
		if w := e.post(o, all()); w.Code != 202 {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		var owners []string
		for _, m := range e.pub.sent() {
			d, _ := dataOf(t, m.Payload)
			owners = append(owners, d["video_id"].(string))
		}
		return owners
	}
	contains := func(list []string, id uuid.UUID) bool {
		for _, s := range list {
			if s == id.String() {
				return true
			}
		}
		return false
	}
	// Anonymous and another user: only the public and unlisted READY videos of an active owner.
	for _, o := range []postOpts{{}, {who: bob}} {
		kept := countKept(o)
		if len(kept) != 2 || !contains(kept, open.ID) || !contains(kept, unlisted.ID) {
			t.Fatalf("outsider keeps %v", kept)
		}
	}
	// The owner reads her PRIVATE and hidden videos too (READY only: nothing is played before READY).
	if kept := countKept(postOpts{who: alice}); len(kept) != 5 || contains(kept, processing.ID) || contains(kept, unknown) {
		t.Fatalf("owner keeps %v", kept)
	}
	// A moderator reads hidden and private ones as well.
	if kept := countKept(postOpts{who: mod}); len(kept) != 5 || !contains(kept, hidden.ID) {
		t.Fatalf("moderator keeps %v", kept)
	}
	// Dropped samples are counted, and nothing is reported back but the number accepted.
	before := testutil.ToFloat64(analytics.SamplesTotal.WithLabelValues("dropped_invalid_video"))
	countKept(postOpts{})
	if got := testutil.ToFloat64(analytics.SamplesTotal.WithLabelValues("dropped_invalid_video")) - before; got != 5 {
		t.Fatalf("dropped_invalid_video +%v, want 5", got)
	}
}

func TestVideosOfABatchAreLookedUpWithOneQuery(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	a, b := e.video(alice), e.video(alice)
	var ss []map[string]any
	for i := 0; i < 12; i++ { // 12 samples, 2 distinct videos
		id := a.ID
		if i%3 == 0 {
			id = b.ID
		}
		ss = append(ss, sampleJSON(ids.New(), id, "heartbeat", i+1, nil))
	}
	if n := accepted(t, e.post(postOpts{}, batch(ss...))); n != 12 {
		t.Fatalf("accepted %d", n)
	}
	if got := e.store.playbackLookups; len(got) != 1 || got[0] != 2 {
		t.Fatalf("lookups (ids per call): %v", got)
	}
	// The cache is used first: videos it holds are not looked up.
	c := newEnvWithCache(t)
	v := c.video(alice)
	c.req(anon, "GET", "/v1/videos/"+v.ID.String(), "") // fills the cache
	c.post(postOpts{}, batch(sampleJSON(ids.New(), v.ID, "start", 0, nil)))
	if len(c.store.playbackLookups) != 0 {
		t.Fatalf("a cached video was looked up: %v", c.store.playbackLookups)
	}
	if n := len(c.pub.sent()); n != 1 {
		t.Fatalf("%d events", n)
	}
}

func newEnvWithCache(t *testing.T) *pbEnv {
	t.Helper()
	e := newPlaybackEnv(t, nil)
	e.cache = newMemCache()
	// rebuild the handler with the cache
	proxies, _ := views.ParseCIDRs([]string{"10.42.0.0/16"})
	h := &Handler{Store: e.store, Cache: e.cache, MediaBaseURL: mediaBase, MediaBucket: "winkey-media",
		CursorSecret: []byte("test-cursor-secret-123456"), Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		Now: func() time.Time { return testNow }, TrustedProxies: proxies,
		Analytics: e.pub, AnalyticsSalt: []byte(testAnalyticsSalt), MediaLinkSecret: []byte(testLinkSecret)}
	r := httpx.NewRouter("video-test", h.Log)
	h.Routes(r)
	e.h = r
	return e
}

func TestHeartbeatValidation(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	v := e.video(alice)
	ok := func() map[string]any { return sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil) }
	with := func(over map[string]any) string { return batch(sampleWith(ok(), over)) }
	tooMany := func(n int) string {
		var ss []map[string]any
		for i := 0; i < n; i++ {
			ss = append(ss, sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil))
		}
		return batch(ss...)
	}
	cases := map[string]string{
		"not json":                `hello`,
		"empty body":              ``,
		"array":                   `[]`,
		"trailing data":           batch(ok()) + ` {}`,
		"unknown batch field":     `{"samples":[` + string(mustJSON(ok())) + `],"extra":1}`,
		"unknown sample field":    with(map[string]any{"ip": "203.0.113.5"}),
		"no samples key":          `{}`,
		"samples null":            `{"samples":null}`,
		"empty samples":           `{"samples":[]}`,
		"21 samples":              tooMany(21),
		"sample not an object":    `{"samples":["x"]}`,
		"playback_id missing":     with(map[string]any{"playback_id": nil}),
		"playback_id not uuid":    with(map[string]any{"playback_id": "nope"}),
		"playback_id no dashes":   with(map[string]any{"playback_id": strings.ReplaceAll(ids.NewString(), "-", "")}),
		"video_id missing":        with(map[string]any{"video_id": nil}),
		"video_id number":         with(map[string]any{"video_id": 5}),
		"kind missing":            with(map[string]any{"kind": nil}),
		"kind unknown":            with(map[string]any{"kind": "pause"}),
		"kind upper case":         with(map[string]any{"kind": "START"}),
		"seq missing":             with(map[string]any{"seq": nil}),
		"seq negative":            with(map[string]any{"seq": -1}),
		"seq 100001":              with(map[string]any{"seq": 100001}),
		"seq fractional":          with(map[string]any{"seq": 1.5}),
		"seq string":              with(map[string]any{"seq": "1"}),
		"sent_at missing":         with(map[string]any{"sent_at": nil}),
		"sent_at not a date":      with(map[string]any{"sent_at": "yesterday"}),
		"sent_at date only":       with(map[string]any{"sent_at": "2026-10-01"}),
		"position negative":       with(map[string]any{"position_ms": -1}),
		"position over a day":     with(map[string]any{"position_ms": 86_400_001}),
		"watched negative":        with(map[string]any{"watched_ms": -5}),
		"watched over 10 min":     with(map[string]any{"watched_ms": 600_001}),
		"watched missing":         with(map[string]any{"watched_ms": nil}),
		"rebuffer_ms over":        with(map[string]any{"rebuffer_ms": 600_001}),
		"rebuffer_ms missing":     with(map[string]any{"rebuffer_ms": nil}),
		"rebuffer_count over":     with(map[string]any{"rebuffer_count": 1001}),
		"rebuffer_count missing":  with(map[string]any{"rebuffer_count": nil}),
		"startup_ms over":         with(map[string]any{"startup_ms": 600_001}),
		"startup_ms negative":     with(map[string]any{"startup_ms": -1}),
		"rendition too long":      with(map[string]any{"rendition": strings.Repeat("x", 17)}),
		"rendition a number":      with(map[string]any{"rendition": 720}),
		"bitrate over":            with(map[string]any{"bitrate_kbps": 200_001}),
		"bitrate negative":        with(map[string]any{"bitrate_kbps": -1}),
		"error_code too long":     with(map[string]any{"error_code": strings.Repeat("e", 65)}),
		"client unknown":          with(map[string]any{"client": "smart-tv"}),
		"one bad sample of three": batch(ok(), sampleWith(ok(), map[string]any{"seq": -1}), ok()),
	}
	for name, body := range cases {
		w := e.post(postOpts{}, body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, w.Code, truncate(w.Body.String()))
			continue
		}
		if c := problemCode(t, w); c != "VALIDATION_ERROR" && c != "INVALID_JSON" {
			t.Errorf("%s: code %s", name, c)
		}
	}
	// A schema error refuses the WHOLE batch: the valid samples next to it are not published either.
	if len(e.pub.sent()) != 0 || len(e.store.playbackLookups) != 0 {
		t.Fatalf("an invalid request reached the stream or the database: %d events, %v lookups", len(e.pub.sent()), e.store.playbackLookups)
	}
	// The limits themselves are valid.
	edge := sampleWith(ok(), map[string]any{"seq": 100000, "position_ms": 86_400_000, "watched_ms": 600_000, "rebuffer_ms": 600_000,
		"rebuffer_count": 1000, "startup_ms": 600_000, "bitrate_kbps": 200_000, "rendition": strings.Repeat("x", 16),
		"error_code": strings.Repeat("e", 64), "client": "android", "sent_at": "2026-10-01T12:00:00.123+07:00"})
	if n := accepted(t, e.post(postOpts{}, batch(edge))); n != 1 {
		t.Fatalf("edge values: accepted %d", n)
	}
	var twenty []map[string]any
	for i := 0; i < 20; i++ {
		twenty = append(twenty, ok())
	}
	if n := accepted(t, e.post(postOpts{}, batch(twenty...))); n != 20 {
		t.Fatalf("20 samples: accepted %d", n)
	}
	validateEvent(t, e.pub.sent()[0].Payload)
}

func sampleWith(m map[string]any, over map[string]any) map[string]any {
	for k, v := range over {
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	return m
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestHeartbeatBodyOver16KiBIs413(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	v := e.video(alice)
	pad := strings.Repeat("a", 17<<10)
	w := e.post(postOpts{}, `{"samples":[`+string(mustJSON(sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil)))+`],"pad":"`+pad+`"}`)
	if w.Code != http.StatusRequestEntityTooLarge || problemCode(t, w) != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("%d %s", w.Code, truncate(w.Body.String()))
	}
	// Just under the limit is judged on its content.
	var body strings.Builder
	body.WriteString(`{"samples":[`)
	for i := 0; i < 20; i++ {
		if i > 0 {
			body.WriteString(",")
		}
		body.Write(mustJSON(sampleJSON(ids.New(), v.ID, "heartbeat", 1, map[string]any{"error_code": strings.Repeat("e", 64)})))
	}
	body.WriteString(`]}`)
	if body.Len() > 16<<10 {
		t.Fatalf("test bug: %d bytes", body.Len())
	}
	if n := accepted(t, e.post(postOpts{}, body.String())); n != 20 {
		t.Fatalf("accepted %d", n)
	}
	if len(e.pub.sent()) != 20 {
		t.Fatal("the 413 request published something")
	}
}

func TestHeartbeatRateLimit(t *testing.T) {
	lim := &fakeLimiter{allow: 2}
	e := newPlaybackEnv(t, lim)
	v := e.video(alice)
	one := batch(sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil))
	for i := 0; i < 2; i++ {
		if n := accepted(t, e.post(postOpts{remote: "203.0.113.50:1"}, one)); n != 1 {
			t.Fatalf("request %d: %d", i, n)
		}
	}
	w := e.post(postOpts{remote: "203.0.113.50:1"}, one)
	if w.Code != http.StatusTooManyRequests || problemCode(t, w) != "RATE_LIMITED" || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body)
	}
	if len(e.pub.sent()) != 2 {
		t.Fatal("a limited request published")
	}
	if got := lim.calls[0]; got != "heartbeat|203.0.113.50|30" {
		t.Fatalf("limiter call %q (want scope heartbeat, the client IP, 30 per minute)", got)
	}
	// The limit is checked before the body is read: an invalid body is limited too.
	if w := e.post(postOpts{remote: "203.0.113.50:1"}, `garbage`); w.Code != http.StatusTooManyRequests {
		t.Fatalf("%d", w.Code)
	}
}

func TestViewerKeyIsAnHMACOfTheViewerNeverOfTheIP(t *testing.T) {
	// Golden: HMAC-SHA256(salt, "u:<id>"), hex (computed independently).
	if got := analytics.ViewerKey([]byte(testAnalyticsSalt), "u:0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d"); got != "d28a3b889f8bcb2ae342b05f60b82cd7608103882b43a9b7a8ba48d6be147a85" {
		t.Fatalf("viewer key %s", got)
	}
	e := newPlaybackEnv(t, nil)
	v := e.video(alice)
	keyOf := func(o postOpts) string {
		e.pub.msgs = nil
		accepted(t, e.post(o, batch(sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil))))
		d, _ := dataOf(t, e.pub.sent()[0].Payload)
		return d["viewer_key"].(string)
	}
	anon1 := keyOf(postOpts{remote: "203.0.113.7:1", ua: "Browser/1"})
	if again := keyOf(postOpts{remote: "203.0.113.7:2", ua: "Browser/1"}); again != anon1 { // another port, same client
		t.Fatal("an anonymous viewer's key is not stable")
	}
	if keyOf(postOpts{remote: "203.0.113.8:1", ua: "Browser/1"}) == anon1 || keyOf(postOpts{remote: "203.0.113.7:1", ua: "Browser/2"}) == anon1 {
		t.Fatal("another IP or user agent must be another anonymous viewer")
	}
	// Behind the trusted proxy the client address counts, not the proxy's.
	if keyOf(postOpts{remote: "10.42.0.5:1", xff: "203.0.113.7", ua: "Browser/1"}) != anon1 {
		t.Fatal("the key of a viewer behind the proxy differs from the direct one")
	}
	// An authenticated viewer: the key of the user id, the same on every device, different from any anonymous one.
	bobKey := keyOf(postOpts{who: bob, remote: "203.0.113.7:1", ua: "Browser/1"})
	if bobKey == anon1 || bobKey != keyOf(postOpts{who: bob, remote: "192.0.2.99:1", ua: "Other/9"}) {
		t.Fatal("the key of an authenticated viewer must not depend on IP or user agent, nor equal the anonymous one")
	}
	if want := analytics.ViewerKey([]byte(testAnalyticsSalt), "u:"+bob.id.String()); bobKey != want {
		t.Fatalf("authenticated key %s, want %s", bobKey, want)
	}
	// A different salt gives different keys (the salt is what keeps the ids private).
	if analytics.ViewerKey([]byte(testAnalyticsSalt+"x"), "u:"+bob.id.String()) == bobKey {
		t.Fatal("the salt does not matter")
	}
	// authenticated flag.
	e.pub.msgs = nil
	accepted(t, e.post(postOpts{who: bob}, batch(sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil))))
	if d, _ := dataOf(t, e.pub.sent()[0].Payload); d["authenticated"] != true {
		t.Fatalf("%v", d)
	}
}

func TestNoIPOrUserAgentEverReachesTheEvent(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	v := e.video(alice)
	const ip, ua = "203.0.113.77", "Mozilla/5.0 (SecretDevice 42) SecretAgent/9.9"
	pb := ids.New()
	accepted(t, e.post(postOpts{remote: ip + ":5555", ua: ua, xff: "198.51.100.200, " + ip},
		batch(sampleJSON(pb, v.ID, "start", 0, nil), sampleJSON(pb, v.ID, "end", 1, nil))))
	accepted(t, e.post(postOpts{who: bob, remote: "10.42.0.9:1", ua: ua, xff: ip}, batch(sampleJSON(pb, v.ID, "heartbeat", 2, nil))))
	if len(e.pub.sent()) != 3 {
		t.Fatal("no events")
	}
	for _, m := range e.pub.sent() {
		for _, banned := range []string{ip, "198.51.100.200", "SecretAgent", "SecretDevice", "Mozilla", "user_agent", "user-agent", "\"ip\"", "remote"} {
			if strings.Contains(string(m.Payload), banned) || strings.Contains(m.ID, banned) {
				t.Fatalf("%q is in the event:\n%s", banned, m.Payload)
			}
		}
		validateEvent(t, m.Payload) // and the schema forbids any other field
	}
}

func TestPublishFailureDropsTheSampleAndIsNeverA5xx(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	v := e.video(alice)
	e.pub.err = errors.New("nats: no responders")
	before := testutil.ToFloat64(analytics.SamplesTotal.WithLabelValues("publish_error"))
	w := e.post(postOpts{}, batch(sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil), sampleJSON(ids.New(), v.ID, "heartbeat", 2, nil)))
	if n := accepted(t, w); n != 0 {
		t.Fatalf("accepted %d", n)
	}
	if got := testutil.ToFloat64(analytics.SamplesTotal.WithLabelValues("publish_error")) - before; got != 2 {
		t.Fatalf("publish_error +%v, want 2", got)
	}
	// The window full is the same: dropped, counted.
	e.pub.err = analytics.ErrDropped
	if n := accepted(t, e.post(postOpts{}, batch(sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil)))); n != 0 {
		t.Fatalf("accepted %d", n)
	}
	// A partial failure counts what got through.
	e.pub.err = nil
	published := testutil.ToFloat64(analytics.SamplesTotal.WithLabelValues("published"))
	if n := accepted(t, e.post(postOpts{}, batch(sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil)))); n != 1 {
		t.Fatal("recovered publisher not used")
	}
	if got := testutil.ToFloat64(analytics.SamplesTotal.WithLabelValues("published")) - published; got != 1 {
		t.Fatalf("published +%v", got)
	}
}

func TestLookupFailureDropsTheBatchWithoutAnError(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	v := e.video(alice)
	e.store.playbackErr = errors.New("database is on fire")
	if n := accepted(t, e.post(postOpts{}, batch(sampleJSON(ids.New(), v.ID, "heartbeat", 1, nil)))); n != 0 || len(e.pub.sent()) != 0 {
		t.Fatalf("accepted %d, published %d", n, len(e.pub.sent()))
	}
}

// With ANALYTICS_ENABLED=false (no publisher): 202 {accepted: 0}, nothing looked up, nothing published.
func TestHeartbeatsWhenAnalyticsIsDisabled(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	h := &Handler{Store: e.store, MediaBaseURL: mediaBase, CursorSecret: []byte("test-cursor-secret-123456"),
		Log: slog.New(slog.NewJSONHandler(io.Discard, nil)), Now: func() time.Time { return testNow }}
	r := httpx.NewRouter("video-test", h.Log)
	h.Routes(r)
	e.h = r
	v := e.video(alice)
	w := e.post(postOpts{}, batch(sampleJSON(ids.New(), v.ID, "start", 0, nil)))
	if n := accepted(t, w); n != 0 || len(e.store.playbackLookups) != 0 || len(e.pub.sent()) != 0 {
		t.Fatalf("accepted %d, lookups %v, events %d", n, e.store.playbackLookups, len(e.pub.sent()))
	}
	// Still validated: a bad body is a 400 whether the feature is on or not.
	if w := e.post(postOpts{}, `{"samples":[]}`); w.Code != http.StatusBadRequest {
		t.Fatalf("%d", w.Code)
	}
}

func TestHeartbeatsNeverChangeTheViewCount(t *testing.T) {
	e := newPlaybackEnv(t, nil)
	v := e.video(alice)
	before := e.store.videos[v.ID].ViewCount
	accepted(t, e.post(postOpts{}, batch(sampleJSON(ids.New(), v.ID, "start", 0, nil), sampleJSON(ids.New(), v.ID, "end", 9, nil))))
	if e.store.videos[v.ID].ViewCount != before {
		t.Fatal("view_count changed")
	}
}
