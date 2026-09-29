package job_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// While a job runs, every heartbeat tick must both extend the message's ack
// deadline (InProgress) and stamp the job's heartbeat_at, for that job only.
func TestHeartbeatStampsJobAndCallsInProgress(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipLandscape)
	f.Pipeline.Cfg.X264Preset = "slow" // keep it busy for several ticks
	f.Pipeline.Cfg.HeartbeatEvery = 200 * time.Millisecond

	var inProgress atomic.Int32
	d := job.Delivery{Num: 1, Max: 3, InProgress: func() error { inProgress.Add(1); return nil }}
	res := f.Pipeline.Process(context.Background(), f.Event(), d)
	if res.Action != job.ActionAck {
		t.Fatalf("%+v", res)
	}

	f.Store.Lock()
	beats := append([]uuid.UUID(nil), f.Store.Beats...)
	f.Store.Unlock()
	if len(beats) < 3 || inProgress.Load() < 3 {
		t.Fatalf("too few ticks: heartbeats=%d InProgress=%d", len(beats), inProgress.Load())
	}
	jobID := f.Store.Ready[0].JobID
	for _, b := range beats {
		if b != jobID {
			t.Fatalf("heartbeat for %s, want job %s", b, jobID)
		}
	}
	// The loop stops with the job: no ticks after Process returned.
	n := len(beats)
	time.Sleep(500 * time.Millisecond)
	f.Store.Lock()
	after := len(f.Store.Beats)
	f.Store.Unlock()
	if after != n {
		t.Fatalf("heartbeat kept running after the job ended (%d -> %d)", n, after)
	}
}

func TestNilInProgressIsAllowed(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	f.Pipeline.Cfg.HeartbeatEvery = 50 * time.Millisecond
	if res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3}); res.Action != job.ActionAck {
		t.Fatalf("%+v", res)
	}
}
