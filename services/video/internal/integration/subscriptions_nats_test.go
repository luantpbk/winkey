package integration

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/subscriptions"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Task R2-b: the consumer video-subscriptions on a real JetStream (stream SOCIAL from testkit) feeding
// media.subscriptions on real PostgreSQL 17. Needs Docker (skipped without it, failing with WINKEY_REQUIRE_DOCKER=1).

type subNats struct {
	feed *feedStack
	nats *testkit.NATS
	cons *subscriptions.Consumer
	stop context.CancelFunc
}

// startSubs boots PostgreSQL, NATS (with the contract streams) and the consumer. lateStart delays the consumer, so
// events can be published before it exists.
func startSubs(t *testing.T, mutate func(*subscriptions.Consumer)) *subNats {
	t.Helper()
	s := &subNats{feed: startFeed(t), nats: testkit.StartNATS(t)}
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	s.cons = &subscriptions.Consumer{JS: s.nats.JS, Store: &store.Postgres{Pool: s.feed.pg.Pool}, Log: log,
		RetryEvery: 100 * time.Millisecond, RetryDelay: 10 * time.Millisecond}
	if mutate != nil {
		mutate(s.cons)
	}
	return s
}

func (s *subNats) run(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	s.stop = cancel
	t.Cleanup(cancel)
	go func() { _ = s.cons.Run(ctx) }()
}

var eventSchema *jsonschema.Schema

func compileSubscriptionSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	if eventSchema != nil {
		return eventSchema
	}
	dir := filepath.Join(testkit.RepoRoot(t), "contracts", "events")
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	for _, f := range []string{"envelope.schema.json", "social.subscription.changed.schema.json"} {
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
	sc, err := c.Compile("https://winkey.vn/contracts/events/social.subscription.changed.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	eventSchema = sc
	return sc
}

// publish sends a social.subscription.changed event built like social-svc would (envelope + data), after checking it
// against the contract schemas.
func (s *subNats) publish(t *testing.T, sub, ch uuid.UUID, subscribed bool) {
	t.Helper()
	outbox.SetProducer("social-svc")
	_, payload, err := outbox.BuildEnvelope(context.Background(), subscriptions.Subject, map[string]any{
		"subscriber_id": sub.String(), "channel_id": ch.String(), "subscribed": subscribed, "subscriber_count": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if err := compileSubscriptionSchema(t).Validate(inst); err != nil {
		t.Fatalf("test event violates its contract: %v\n%s", err, payload)
	}
	if _, err := s.nats.JS.PublishMsg(context.Background(), &nats.Msg{Subject: subscriptions.Subject, Data: payload}); err != nil {
		t.Fatal(err)
	}
}

func (s *subNats) publishRaw(t *testing.T, raw string) {
	t.Helper()
	if _, err := s.nats.JS.PublishMsg(context.Background(), &nats.Msg{Subject: subscriptions.Subject, Data: []byte(raw)}); err != nil {
		t.Fatal(err)
	}
}

func (s *subNats) pairs(t *testing.T) []string {
	t.Helper()
	rows, err := s.feed.pg.Pool.Query(context.Background(), `SELECT subscriber_id::text || '>' || channel_id::text FROM media.subscriptions`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// info returns the state of the durable, waiting (up to 30 s) for the consumer goroutine to have created it.
func (s *subNats) info(t *testing.T) *jetstream.ConsumerInfo {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		c, err := s.nats.JS.Consumer(context.Background(), subscriptions.Stream, subscriptions.Durable)
		if err == nil {
			if info, err := c.Info(context.Background()); err == nil {
				return info
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the durable %s does not exist: %v", subscriptions.Durable, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *subNats) drained(t *testing.T) func() bool {
	return func() bool {
		i := s.info(t)
		return i.NumPending == 0 && i.NumAckPending == 0
	}
}

func TestSubscribeAndUnsubscribeReachTheFeedThroughNATS(t *testing.T) {
	s := startSubs(t, nil)
	s.run(t)
	pg := s.feed.pg.Pool
	me := testutil.SeedUser(t, pg, "meuser", nil, "")
	ch := testutil.SeedUser(t, pg, "chanel", nil, "")
	other := testutil.SeedUser(t, pg, "another", nil, "")
	meA := &actor{me.ID, "viewer"}
	var vids []string
	for i := 0; i < 5; i++ { // two pages of 3 + 2
		vids = append([]string{testutil.SeedVideo(t, pg, testutil.Video{Owner: ch.ID, Published: time.Now().UTC().Add(-time.Duration(i) * time.Hour).Truncate(time.Microsecond)}).ID.String()}, vids...)
	}
	testutil.SeedVideo(t, pg, testutil.Video{Owner: other.ID}) // not followed
	// vids is newest last after the prepend above: reverse it to newest first
	for i, j := 0, len(vids)-1; i < j; i, j = i+1, j-1 {
		vids[i], vids[j] = vids[j], vids[i]
	}

	if got := s.feed.feed(meA, 3); len(got) != 0 {
		t.Fatalf("before subscribing: %v", got)
	}
	s.publish(t, me.ID, ch.ID, true)
	waitFor(t, 20*time.Second, "the subscription reaches the feed", func() bool { return len(s.feed.feed(meA, 3)) == 5 })
	got := s.feed.feed(meA, 3) // paging across two pages
	for i := range vids {
		if got[i] != vids[i] {
			t.Fatalf("item %d is %s, want %s", i, got[i], vids[i])
		}
	}
	s.publish(t, me.ID, ch.ID, false)
	waitFor(t, 20*time.Second, "the unsubscribe reaches the feed", func() bool { return len(s.feed.feed(meA, 3)) == 0 })
}

// The whole stream can be replayed (after the backfill, or a re-created durable): the same events applied again
// leave the same rows.
func TestReplayingTheSameEventsTwiceLeavesTheSameState(t *testing.T) {
	s := startSubs(t, nil)
	pg := s.feed.pg.Pool
	users := make([]uuid.UUID, 4)
	for i := range users {
		users[i] = testutil.SeedUser(t, pg, fmt.Sprintf("usr%c", 'a'+i), nil, "").ID
	}
	seq := []struct {
		sub, ch int
		on      bool
	}{{0, 1, true}, {0, 2, true}, {1, 2, true}, {0, 1, false}, {2, 3, true}, {0, 1, true}, {1, 2, false}, {3, 0, true}, {3, 0, true}}
	for pass := 0; pass < 2; pass++ {
		for _, e := range seq {
			s.publish(t, users[e.sub], users[e.ch], e.on)
		}
	}
	s.run(t) // deliver_policy all: events published BEFORE the consumer existed are applied
	waitFor(t, 30*time.Second, "all events applied", func() bool {
		return s.info(t).NumPending == 0 && s.info(t).NumAckPending == 0 && s.info(t).Delivered.Stream >= 18
	})

	want := []string{
		users[0].String() + ">" + users[1].String(),
		users[0].String() + ">" + users[2].String(),
		users[2].String() + ">" + users[3].String(),
		users[3].String() + ">" + users[0].String(),
	}
	sort.Strings(want)
	if got := s.pairs(t); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("state\n got %v\nwant %v", got, want)
	}
	// Stop the consumer, delete the durable and start a new one: it replays all 18 events again, same state.
	s.stop()
	if err := s.nats.JS.DeleteConsumer(context.Background(), subscriptions.Stream, subscriptions.Durable); err != nil {
		t.Fatal(err)
	}
	s.run(t)
	waitFor(t, 30*time.Second, "the replay was applied", func() bool { return s.info(t).Delivered.Stream >= 18 && s.info(t).NumAckPending == 0 })
	if got := s.pairs(t); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("state after the replay\n got %v\nwant %v", got, want)
	}
}

func TestPoisonMessagesAreTerminatedAndDoNotBlockTheQueue(t *testing.T) {
	s := startSubs(t, nil)
	s.run(t)
	pg := s.feed.pg.Pool
	me := testutil.SeedUser(t, pg, "meuser", nil, "")
	ch := testutil.SeedUser(t, pg, "chanel", nil, "")
	for _, raw := range []string{
		`garbage`,
		`{"event_id":"x","type":"social.subscription.changed","version":1,"occurred_at":"2026-10-02T11:01:00Z","producer":"social-svc","data":{"subscriber_id":"nope","channel_id":"` + ch.ID.String() + `","subscribed":true,"subscriber_count":1}}`,
		fmt.Sprintf(`{"event_id":%q,"type":"social.subscription.changed","version":1,"occurred_at":"2026-10-02T11:01:00Z","producer":"social-svc","data":{"subscriber_id":%q,"channel_id":%q,"subscribed":true,"subscriber_count":-3}}`, ids.NewString(), me.ID, ch.ID),
		fmt.Sprintf(`{"event_id":%q,"type":"social.subscription.changed","version":1,"occurred_at":"2026-10-02T11:01:00Z","producer":"social-svc","data":{"subscriber_id":%q,"channel_id":%q,"subscribed":true,"subscriber_count":1}}`, ids.NewString(), me.ID, me.ID),
	} {
		s.publishRaw(t, raw)
	}
	s.publish(t, me.ID, ch.ID, true) // the message behind them must still be applied

	waitFor(t, 20*time.Second, "the valid subscription is applied", func() bool { return len(s.pairs(t)) == 1 })
	waitFor(t, 20*time.Second, "queue drained", s.drained(t))
	time.Sleep(time.Second) // poison messages are terminated, not redelivered
	if info := s.info(t); info.NumRedelivered != 0 || info.NumAckPending != 0 {
		t.Fatalf("poison messages were redelivered: %+v", info)
	}
	if got := s.pairs(t); len(got) != 1 || got[0] != me.ID.String()+">"+ch.ID.String() {
		t.Fatalf("state %v", got)
	}
}

// video-svc starts before social-svc exists: the SOCIAL stream is not there, and the consumer picks it up once it is.
func TestConsumerCreatedBeforeTheStreamCatchesUp(t *testing.T) {
	s := startSubs(t, nil)
	ctx := context.Background()
	if err := s.nats.JS.DeleteStream(ctx, subscriptions.Stream); err != nil {
		t.Fatal(err)
	}
	s.run(t) // the stream does not exist
	time.Sleep(500 * time.Millisecond)
	pg := s.feed.pg.Pool
	me := testutil.SeedUser(t, pg, "meuser", nil, "")
	ch := testutil.SeedUser(t, pg, "chanel", nil, "")
	for _, sc := range testkit.Streams() {
		if sc.Name == subscriptions.Stream {
			if _, err := s.nats.JS.CreateStream(ctx, sc); err != nil {
				t.Fatal(err)
			}
		}
	}
	s.publish(t, me.ID, ch.ID, true)
	// The consumer may be inside a 5 s pull and backs off 1 s, so give it a generous budget and say what it looked like.
	deadline := time.Now().Add(60 * time.Second)
	for len(s.pairs(t)) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("the consumer did not catch up after the stream appeared")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// The durable is what the contract says, and starting the consumer again updates it instead of creating another one.
func TestTheDurableMatchesTheContract(t *testing.T) {
	s := startSubs(t, nil)
	s.run(t)
	waitFor(t, 20*time.Second, "the durable exists", func() bool {
		_, err := s.nats.JS.Consumer(context.Background(), subscriptions.Stream, subscriptions.Durable)
		return err == nil
	})
	i := s.info(t)
	c := i.Config
	if c.Durable != "video-subscriptions" || c.FilterSubject != "social.subscription.changed" || c.DeliverPolicy != jetstream.DeliverAllPolicy ||
		c.AckPolicy != jetstream.AckExplicitPolicy || c.AckWait != 30*time.Second || c.MaxDeliver != 5 {
		t.Fatalf("%+v", c)
	}
	// A second start (a restart or another replica) reuses the same durable.
	s.cons.Log = slog.New(slog.NewJSONHandler(io.Discard, nil))
	second := *s.cons
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = second.Run(ctx) }()
	time.Sleep(time.Second)
	var names []string
	lister := s.nats.JS
	st, err := lister.Stream(context.Background(), subscriptions.Stream)
	if err != nil {
		t.Fatal(err)
	}
	for n := range st.ListConsumers(context.Background()).Info() {
		names = append(names, n.Name)
	}
	count := 0
	for _, n := range names {
		if n == subscriptions.Durable {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("consumers on SOCIAL: %v", names)
	}
}

// A database that is down for a moment must not reorder events: subscribe then unsubscribe still ends unsubscribed.
func TestTransientDatabaseTroubleKeepsTheOrder(t *testing.T) {
	s := startSubs(t, func(c *subscriptions.Consumer) { c.Attempts = 12; c.RetryDelay = 20 * time.Millisecond })
	s.run(t)
	ctx := context.Background()
	pg := s.feed.pg.Pool
	me := testutil.SeedUser(t, pg, "meuser", nil, "")
	ch := testutil.SeedUser(t, pg, "chanel", nil, "")
	for _, q := range []string{
		`CREATE FUNCTION media.refuse_subscriptions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'database trouble'; END $$`,
		`CREATE TRIGGER refuse_subscriptions BEFORE INSERT ON media.subscriptions FOR EACH ROW EXECUTE FUNCTION media.refuse_subscriptions()`,
	} {
		if _, err := pg.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	s.publish(t, me.ID, ch.ID, true)  // fails while the trouble lasts, retried in process
	s.publish(t, me.ID, ch.ID, false) // must be applied AFTER it, never before
	time.Sleep(600 * time.Millisecond)
	if _, err := pg.Exec(ctx, `DROP TRIGGER refuse_subscriptions ON media.subscriptions`); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 30*time.Second, "both events applied", s.drained(t))
	time.Sleep(500 * time.Millisecond)
	if got := s.pairs(t); len(got) != 0 {
		t.Fatalf("the unsubscribe was applied before the subscribe: %v", got)
	}
}
