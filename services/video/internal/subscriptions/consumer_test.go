package subscriptions

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	subA = "0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d"
	subB = "0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0e"
	evID = "0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0f"
)

func event(data string) []byte { return eventWith(`"version":1`, data) }

func eventWith(version, data string) []byte {
	return []byte(fmt.Sprintf(`{"event_id":%q,"type":"social.subscription.changed",%s,"occurred_at":"2026-10-02T11:01:00.123Z","producer":"social-svc","data":%s}`, evID, version, data))
}

func subChange(sub, ch string, subscribed string) string {
	return fmt.Sprintf(`{"subscriber_id":%q,"channel_id":%q,"subscribed":%s,"subscriber_count":3}`, sub, ch, subscribed)
}

type call struct {
	subscribe bool
	sub, ch   uuid.UUID
	at        time.Time
}

type fakeStore struct {
	mu      sync.Mutex
	calls   []call
	failFor int // the next n calls fail
	state   map[[2]uuid.UUID]time.Time
}

func newFakeStore() *fakeStore { return &fakeStore{state: map[[2]uuid.UUID]time.Time{}} }

func (f *fakeStore) Subscribe(_ context.Context, s, c uuid.UUID, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failFor > 0 {
		f.failFor--
		return errors.New("database unavailable")
	}
	f.calls = append(f.calls, call{true, s, c, at})
	if _, ok := f.state[[2]uuid.UUID{s, c}]; !ok { // ON CONFLICT DO NOTHING
		f.state[[2]uuid.UUID{s, c}] = at
	}
	return nil
}

func (f *fakeStore) Unsubscribe(_ context.Context, s, c uuid.UUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failFor > 0 {
		f.failFor--
		return errors.New("database unavailable")
	}
	f.calls = append(f.calls, call{false, s, c, time.Time{}})
	delete(f.state, [2]uuid.UUID{s, c})
	return nil
}

func consumer(st Store) *Consumer {
	return &Consumer{Store: st, Log: slog.New(slog.NewJSONHandler(io.Discard, nil)), RetryDelay: time.Millisecond}
}

func TestProcessMapsEventsToActions(t *testing.T) {
	a, b := uuid.MustParse(subA), uuid.MustParse(subB)
	st := newFakeStore()
	c := consumer(st)
	if act := c.Process(context.Background(), event(subChange(subA, subB, "true"))); act != ActionAck {
		t.Fatalf("subscribe: %v", act)
	}
	at := time.Date(2026, 10, 2, 11, 1, 0, 123_000_000, time.UTC)
	if len(st.calls) != 1 || !st.calls[0].subscribe || st.calls[0].sub != a || st.calls[0].ch != b || !st.calls[0].at.Equal(at) {
		t.Fatalf("calls %+v", st.calls)
	}
	if act := c.Process(context.Background(), event(subChange(subA, subB, "false"))); act != ActionAck {
		t.Fatalf("unsubscribe: %v", act)
	}
	if len(st.calls) != 2 || st.calls[1].subscribe || len(st.state) != 0 {
		t.Fatalf("calls %+v state %v", st.calls, st.state)
	}
	// An event of a version this code does not know is skipped, not applied.
	if act := c.Process(context.Background(), eventWith(`"version":2`, `{"anything":1}`)); act != ActionAck || len(st.calls) != 2 {
		t.Fatalf("version 2: %v %d", act, len(st.calls))
	}
}

func TestReplayingEventsLeavesTheSameState(t *testing.T) {
	st := newFakeStore()
	c := consumer(st)
	seq := [][]byte{
		event(subChange(subA, subB, "true")),
		event(subChange(subB, subA, "true")),
		event(subChange(subA, subB, "false")),
		event(subChange(subA, subB, "true")),
	}
	run := func() {
		for _, e := range seq {
			if act := c.Process(context.Background(), e); act != ActionAck {
				t.Fatalf("%v", act)
			}
		}
	}
	run()
	first := fmt.Sprint(len(st.state), st.state)
	run() // the whole stream again, as after the backfill
	if got := fmt.Sprint(len(st.state), st.state); got != first || len(st.state) != 2 {
		t.Fatalf("state changed by the replay: %s vs %s", first, got)
	}
}

func TestTransientErrorsAreRetriedInProcessAndInOrder(t *testing.T) {
	st := newFakeStore()
	st.failFor = 2 // fails twice, the third attempt (Attempts default 3) applies it
	c := consumer(st)
	if act := c.Process(context.Background(), event(subChange(subA, subB, "true"))); act != ActionAck || len(st.calls) != 1 {
		t.Fatalf("%v %+v", act, st.calls)
	}
	st.failFor = 5 // more failures than attempts: hand the message back
	if act := c.Process(context.Background(), event(subChange(subA, subB, "false"))); act != ActionRetry {
		t.Fatalf("%v", act)
	}
	if len(st.state) != 1 {
		t.Fatal("applied although every attempt failed")
	}
}

func TestCancelledContextStopsRetrying(t *testing.T) {
	st := newFakeStore()
	st.failFor = 100
	c := consumer(st)
	c.RetryDelay = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	done := make(chan Action, 1)
	go func() { done <- c.Process(ctx, event(subChange(subA, subB, "true"))) }()
	select {
	case a := <-done:
		if a != ActionRetry {
			t.Fatalf("%v", a)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Process did not return after the context was cancelled")
	}
}

// Every malformed event is terminated and never reaches the store.
func TestPoisonEventsAreTerminated(t *testing.T) {
	good := subChange(subA, subB, "true")
	for name, payload := range map[string][]byte{
		"not json":            []byte(`garbage`),
		"empty":               []byte(``),
		"wrong type":          []byte(strings.Replace(string(event(good)), "social.subscription.changed", "social.video.like_changed", 1)),
		"no event_id":         []byte(strings.Replace(string(event(good)), `"event_id":"`+evID+`",`, "", 1)),
		"event_id not a uuid": []byte(strings.Replace(string(event(good)), evID, "nope", 1)),
		"no occurred_at":      []byte(strings.Replace(string(event(good)), `"occurred_at":"2026-10-02T11:01:00.123Z",`, "", 1)),
		"bad occurred_at":     []byte(strings.Replace(string(event(good)), "2026-10-02T11:01:00.123Z", "yesterday", 1)),
		"no producer":         []byte(strings.Replace(string(event(good)), `,"producer":"social-svc"`, "", 1)),
		"no version":          []byte(strings.Replace(string(event(good)), `"version":1,`, "", 1)),
		"version 0":           eventWith(`"version":0`, good),
		"extra envelope key":  []byte(strings.Replace(string(event(good)), `"producer"`, `"extra":1,"producer"`, 1)),
		"data not an object":  event(`"x"`),
		"no data":             []byte(fmt.Sprintf(`{"event_id":%q,"type":"social.subscription.changed","version":1,"occurred_at":"2026-10-02T11:01:00Z","producer":"p"}`, evID)),
		"extra data key":      event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":true,"subscriber_count":3,"x":1}`),
		"no subscriber_id":    event(`{"channel_id":"` + subB + `","subscribed":true,"subscriber_count":3}`),
		"no channel_id":       event(`{"subscriber_id":"` + subA + `","subscribed":true,"subscriber_count":3}`),
		"no subscribed":       event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscriber_count":3}`),
		"no subscriber_count": event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":true}`),
		"negative count":      event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":true,"subscriber_count":-1}`),
		"subscribed a string": event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":"true","subscriber_count":3}`),
		"subscriber not uuid": event(subChange("nope", subB, "true")),
		"channel not uuid":    event(subChange(subA, "nope", "true")),
		"uuid without dashes": event(subChange(strings.ReplaceAll(subA, "-", ""), subB, "true")),
		"uuid in braces":      event(subChange("{"+subA+"}", subB, "true")),
		"self subscription":   event(subChange(subA, subA, "true")),
		"trailing data":       append(event(good), []byte(` {}`)...),
	} {
		st := newFakeStore()
		if act := consumer(st).Process(context.Background(), payload); act != ActionTerm || len(st.calls) != 0 {
			t.Errorf("%s: action %v, %d store calls", name, act, len(st.calls))
		}
	}
}

// The hand-written validation agrees with the JSON Schemas of the contract: a message the schema rejects is
// terminated, one it accepts is applied, on the contract example and a set of variations. Two documented
// differences: version 2 is ignored (the schema pins version 1 for this type, but consumers must skip versions
// they do not know), and a subscription to oneself is refused although the schema cannot express it.
func TestValidationAgreesWithTheContractSchemas(t *testing.T) {
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
	comp := jsonschema.NewCompiler()
	comp.DefaultDraft(jsonschema.Draft2020)
	comp.AssertFormat()
	for _, f := range []string{"envelope.schema.json", "social.subscription.changed.schema.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := comp.AddResource("https://winkey.vn/contracts/events/"+f, doc); err != nil {
			t.Fatal(err)
		}
	}
	schema, err := comp.Compile("https://winkey.vn/contracts/events/social.subscription.changed.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	example, err := os.ReadFile(filepath.Join(dir, "examples", "social.subscription.changed.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, ignore := Decode(example); !ok || ignore {
		t.Fatalf("the contract example is not accepted: %s", example)
	}

	good := subChange(subA, subB, "true")
	cases := map[string][]byte{
		"example":              example,
		"subscribe":            event(good),
		"unsubscribe":          event(subChange(subA, subB, "false")),
		"count zero":           event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":false,"subscriber_count":0}`),
		"traceparent":          []byte(strings.Replace(string(event(good)), `"producer"`, `"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","producer"`, 1)),
		"extra envelope key":   []byte(strings.Replace(string(event(good)), `"producer"`, `"extra":1,"producer"`, 1)),
		"extra data key":       event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":true,"subscriber_count":3,"x":1}`),
		"no subscriber_count":  event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":true}`),
		"negative count":       event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":true,"subscriber_count":-1}`),
		"fractional count":     event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":true,"subscriber_count":1.5}`),
		"bad uuid":             event(subChange("nope", subB, "true")),
		"bad occurred_at":      []byte(strings.Replace(string(event(good)), "2026-10-02T11:01:00.123Z", "yesterday", 1)),
		"wrong type":           []byte(strings.Replace(string(event(good)), "social.subscription.changed", "social.video.like_changed", 1)),
		"no producer":          []byte(strings.Replace(string(event(good)), `,"producer":"social-svc"`, "", 1)),
		"version 0":            eventWith(`"version":0`, good),
		"subscribed as string": event(`{"subscriber_id":"` + subA + `","channel_id":"` + subB + `","subscribed":"yes","subscriber_count":3}`),
	}
	for name, payload := range cases {
		inst, uerr := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
		schemaOK := uerr == nil && schema.Validate(inst) == nil
		_, ok, _ := Decode(payload)
		if ok != schemaOK {
			t.Errorf("%s: schema says valid=%v, Decode says %v\n%s", name, schemaOK, ok, payload)
		}
	}
	// The two documented differences.
	inst, _ := jsonschema.UnmarshalJSON(bytes.NewReader(eventWith(`"version":2`, good)))
	if _, ok, ignore := Decode(eventWith(`"version":2`, good)); schema.Validate(inst) == nil || ok || !ignore {
		t.Error("version 2: the schema pins version 1 and the consumer must skip it")
	}
	self := event(subChange(subA, subA, "true"))
	inst, _ = jsonschema.UnmarshalJSON(bytes.NewReader(self))
	if _, ok, _ := Decode(self); schema.Validate(inst) != nil || ok {
		t.Error("a self subscription passes the schema but not the consumer")
	}
}
