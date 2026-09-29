package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

type dlqCopy struct {
	data    []byte
	eventID string
}

func uploadedMsg(t *testing.T, videoID string) ([]byte, string) {
	t.Helper()
	_, payload, err := outbox.BuildEnvelope(context.Background(), "video.uploaded", job.UploadedEvent{
		VideoID: videoID, OwnerID: owner, RawBucket: "winkey-raw", RawKey: "k", SizeBytes: 1, ContentType: "video/mp4",
	})
	if err != nil {
		t.Fatal(err)
	}
	var env outbox.Envelope
	_ = json.Unmarshal(payload, &env)
	return payload, env.EventID
}

func newWatcher(store *testutil.MemStore, subject string, data []byte, getErr error, dlq *[]dlqCopy) *Watcher {
	return &Watcher{
		Store: store, Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		GetMsg: func(context.Context, uint64) (string, []byte, error) { return subject, data, getErr },
		DLQ: func(_ context.Context, d []byte, id string) bool {
			*dlq = append(*dlq, dlqCopy{d, id})
			return true
		},
	}
}

func advisory(seq uint64) []byte {
	b, _ := json.Marshal(map[string]any{
		"type": "io.nats.jetstream.advisory.v1.max_deliver", "stream": "VIDEO", "consumer": "transcoder",
		"stream_seq": seq, "deliveries": 3,
	})
	return b
}

func TestMaxDeliveriesSubject(t *testing.T) {
	if got := MaxDeliveriesSubject("VIDEO", "transcoder"); got != "$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.VIDEO.transcoder" {
		t.Fatal(got)
	}
}

func TestAdvisoryFailsStuckVideoAndCopiesToDLQ(t *testing.T) {
	data, eventID := uploadedMsg(t, vid)
	store := &testutil.MemStore{}
	var dlq []dlqCopy
	w := newWatcher(store, SubjectUploaded, data, nil, &dlq)

	w.HandleAdvisory(context.Background(), advisory(7))

	if len(store.Stuck) != 1 || store.Stuck[0].VideoID.String() != vid || !store.Stuck[0].Terminal {
		t.Fatalf("stuck: %+v", store.Stuck)
	}
	f := store.Stuck[0].Failure
	if f.Reason != job.ReasonInternal || !f.Retryable || f.Message == "" {
		t.Fatalf("failure: %+v", f)
	}
	if len(dlq) != 1 || dlq[0].eventID != eventID || string(dlq[0].data) != string(data) {
		t.Fatalf("DLQ copy: %+v", dlq)
	}
}

func TestAdvisoryNoopWhenVideoAlreadyResolved(t *testing.T) {
	data, _ := uploadedMsg(t, vid)
	store := &testutil.MemStore{StuckNoop: true}
	var dlq []dlqCopy
	newWatcher(store, SubjectUploaded, data, nil, &dlq).HandleAdvisory(context.Background(), advisory(7))
	if store.StuckCalls != 1 || len(dlq) != 0 {
		t.Fatalf("calls=%d dlq=%d: a resolved video must not be copied to the DLQ", store.StuckCalls, len(dlq))
	}
}

func TestAdvisoryIgnoresBadInput(t *testing.T) {
	data, _ := uploadedMsg(t, vid)
	notUUID, _ := uploadedMsg(t, "../../etc")
	cases := map[string]struct {
		w       func(*testutil.MemStore, *[]dlqCopy) *Watcher
		payload []byte
	}{
		"garbage advisory": {func(s *testutil.MemStore, d *[]dlqCopy) *Watcher { return newWatcher(s, SubjectUploaded, data, nil, d) }, []byte("nope")},
		"no sequence":      {func(s *testutil.MemStore, d *[]dlqCopy) *Watcher { return newWatcher(s, SubjectUploaded, data, nil, d) }, advisory(0)},
		"message gone": {func(s *testutil.MemStore, d *[]dlqCopy) *Watcher {
			return newWatcher(s, SubjectUploaded, nil, errors.New("not found"), d)
		}, advisory(7)},
		"other subject": {func(s *testutil.MemStore, d *[]dlqCopy) *Watcher { return newWatcher(s, "video.ready", data, nil, d) }, advisory(7)},
		"malformed data": {func(s *testutil.MemStore, d *[]dlqCopy) *Watcher {
			return newWatcher(s, SubjectUploaded, []byte("{"), nil, d)
		}, advisory(7)},
		"bad video id": {func(s *testutil.MemStore, d *[]dlqCopy) *Watcher {
			return newWatcher(s, SubjectUploaded, notUUID, nil, d)
		}, advisory(7)},
	}
	for name, c := range cases {
		store := &testutil.MemStore{}
		var dlq []dlqCopy
		c.w(store, &dlq).HandleAdvisory(context.Background(), c.payload)
		if store.StuckCalls != 0 || len(dlq) != 0 {
			t.Errorf("%s: acted on bad input (calls=%d dlq=%d)", name, store.StuckCalls, len(dlq))
		}
	}
}

func TestAdvisoryStoreErrorSkipsDLQ(t *testing.T) {
	data, _ := uploadedMsg(t, vid)
	store := &testutil.MemStore{StuckErr: errors.New("db down")}
	var dlq []dlqCopy
	newWatcher(store, SubjectUploaded, data, nil, &dlq).HandleAdvisory(context.Background(), advisory(7))
	if len(dlq) != 0 {
		t.Fatal("must not copy to the DLQ when the video could not be failed")
	}
}
