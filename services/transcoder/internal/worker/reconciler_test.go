package worker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

func quietLog() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func TestReconcilerSweepReportsActions(t *testing.T) {
	store := &testutil.MemStore{ReconcileResult: []job.Reconciled{
		{VideoID: uuid.New(), JobID: uuid.New(), Attempt: 1, Retried: true},
		{VideoID: uuid.New(), JobID: uuid.New(), Attempt: 3, Failed: true},
		{VideoID: uuid.New(), JobID: uuid.New(), Attempt: 2},
	}}
	r := &Reconciler{Store: store, Log: quietLog()}
	if got := r.Sweep(context.Background()); len(got) != 3 || store.Reconciles != 1 {
		t.Fatalf("got %d results, %d calls", len(got), store.Reconciles)
	}
}

func TestReconcilerSweepSurvivesStoreErrors(t *testing.T) {
	store := &testutil.MemStore{ReconcileErr: errors.New("db down")}
	r := &Reconciler{Store: store, Log: quietLog()}
	if got := r.Sweep(context.Background()); got != nil {
		t.Fatalf("got %v", got)
	}
}

func TestReconcilerRunSweepsPeriodicallyAndStops(t *testing.T) {
	store := &testutil.MemStore{}
	r := &Reconciler{Store: store, Interval: 20 * time.Millisecond, Log: quietLog()}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	time.Sleep(200 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop after cancel")
	}
	store.Lock()
	n := store.Reconciles
	store.Unlock()
	if n < 3 {
		t.Fatalf("only %d sweeps in 200ms at a 20ms interval", n)
	}
}
