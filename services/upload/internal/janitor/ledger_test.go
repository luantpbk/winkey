package janitor

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

// ledgerStore records PurgeLedger calls; every other Store method is unused here.
type ledgerStore struct {
	domain.Store
	purged []int // rows each call reports, in order
	asked  []time.Duration
	limits []int
}

func (s *ledgerStore) StaleUploads(context.Context, time.Duration, int) ([]domain.Video, error) {
	return nil, nil
}

func (s *ledgerStore) PurgeLedger(_ context.Context, d time.Duration, limit int) (int, error) {
	s.asked = append(s.asked, d)
	s.limits = append(s.limits, limit)
	if len(s.purged) == 0 {
		return 0, nil
	}
	n := s.purged[0]
	s.purged = s.purged[1:]
	return n, nil
}

func newLedgerJanitor(st domain.Store) *Janitor {
	return &Janitor{Store: st, Storage: &stubStorage{}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

// The retention deletes in batches of at most 1000 until a batch comes back short, older than 48 h.
func TestSweepPurgesTheLedgerInBatches(t *testing.T) {
	st := &ledgerStore{purged: []int{1000, 1000, 250}}
	if _, err := newLedgerJanitor(st).Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(st.asked) != 3 {
		t.Fatalf("PurgeLedger called %d times, want 3 (two full batches, then a short one)", len(st.asked))
	}
	for i := range st.asked {
		if st.asked[i] != 48*time.Hour || st.limits[i] != 1000 {
			t.Errorf("call %d: older than %v, limit %d; want 48h and 1000", i, st.asked[i], st.limits[i])
		}
	}
}

// A batch of exactly 1000 means there may be more: one more call, which returns 0.
func TestSweepAsksOnceMoreAfterAFullBatch(t *testing.T) {
	st := &ledgerStore{purged: []int{1000}}
	if _, err := newLedgerJanitor(st).Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(st.asked) != 2 {
		t.Fatalf("PurgeLedger called %d times, want 2", len(st.asked))
	}
}

func TestSweepPurgesTheLedgerEvenWithNothingStale(t *testing.T) {
	st := &ledgerStore{purged: []int{3}}
	n, err := newLedgerJanitor(st).Sweep(context.Background())
	if err != nil || n != 0 || len(st.asked) != 1 {
		t.Fatalf("n=%d err=%v purge calls=%d", n, err, len(st.asked))
	}
}
