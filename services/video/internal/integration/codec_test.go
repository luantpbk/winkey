package integration

import (
	"testing"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Task AV1-tel (ADR-048): codec and av1_capable pass through to analytics.playback, and are omitted (not null) when
// the client does not send them, so video-svc can deploy before the analytics-worker that accepts them.
func TestHeartbeatsForwardCodecFieldsOnlyWhenSent(t *testing.T) {
	s := startPlayback(t, nil)
	alice := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: alice.ID}).ID

	pb := ids.New()
	start := hbSample(pb, v, "start", 0)
	start["codec"], start["av1_capable"] = "av1", true
	beat := hbSample(pb, v, "heartbeat", 1)
	beat["codec"], beat["av1_capable"] = "h264", false
	old := hbSample(ids.New(), v, "start", 0)
	if code, body := s.post(nil, hbBatch(start, beat, old)); code != 202 {
		t.Fatalf("%d %s", code, body)
	}
	msgs := s.cap.sent()
	if len(msgs) != 3 {
		t.Fatalf("%d events", len(msgs))
	}
	for i, want := range []struct {
		codec   any
		capable any
	}{{"av1", true}, {"h264", false}} {
		d := checkAnalyticsEvent(t, msgs[i].Payload)
		if d["codec"] != want.codec || d["av1_capable"] != want.capable {
			t.Fatalf("event %d: codec=%v av1_capable=%v", i, d["codec"], d["av1_capable"])
		}
	}
	d := checkAnalyticsEvent(t, msgs[2].Payload)
	if _, ok := d["codec"]; ok {
		t.Fatalf("codec present for an older client: %v", d)
	}
	if _, ok := d["av1_capable"]; ok {
		t.Fatalf("av1_capable present for an older client: %v", d)
	}

	for field, values := range map[string][]any{
		"codec":       {"hevc", "AV1", "", nil, 1, true},
		"av1_capable": {"true", 1, nil, []any{}},
	} {
		for _, value := range values {
			sample := hbSample(ids.New(), v, "start", 0)
			sample[field] = value
			if code, _ := s.post(nil, hbBatch(sample)); code != 400 {
				t.Fatalf("%s=%v accepted with status %d", field, value, code)
			}
		}
	}
	if len(s.cap.sent()) != 3 {
		t.Fatal("an invalid sample was published")
	}
}
