package janitor

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

type stubStore struct {
	domain.Store
	stale   []domain.Video
	deleted []uuid.UUID
	asked   time.Duration
}

func (s *stubStore) StaleUploads(_ context.Context, d time.Duration, _ int) ([]domain.Video, error) {
	s.asked = d
	return s.stale, nil
}
func (s *stubStore) DeleteUploading(_ context.Context, id uuid.UUID) (bool, error) {
	s.deleted = append(s.deleted, id)
	return true, nil
}

type stubStorage struct {
	domain.Storage
	err     map[string]error
	aborted []string
}

func (s *stubStorage) AbortMultipart(_ context.Context, _, _, uploadID string) error {
	s.aborted = append(s.aborted, uploadID)
	return s.err[uploadID]
}

func TestSweep(t *testing.T) {
	ok, gone, broken := uuid.New(), uuid.New(), uuid.New()
	st := &stubStore{stale: []domain.Video{
		{ID: ok, S3UploadID: "u-ok", RawKey: "k1"},
		{ID: gone, S3UploadID: "u-gone", RawKey: "k2"},
		{ID: broken, S3UploadID: "u-broken", RawKey: "k3"},
	}}
	sg := &stubStorage{err: map[string]error{
		"u-gone":   domain.ErrNoSuchUpload,
		"u-broken": errors.New("garage unreachable"),
	}}
	j := &Janitor{Store: st, Storage: sg, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	n, err := j.Sweep(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.asked != 24*time.Hour {
		t.Errorf("stale threshold %v, want 24h", st.asked)
	}
	// "already gone" still deletes the row; a broken abort keeps it for the next sweep.
	if n != 2 || len(st.deleted) != 2 || st.deleted[0] != ok || st.deleted[1] != gone {
		t.Fatalf("deleted=%v n=%d", st.deleted, n)
	}
	if len(sg.aborted) != 3 {
		t.Fatalf("aborted=%v", sg.aborted)
	}
}
