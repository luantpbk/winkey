package testutil

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// MemStore is an in-memory job.Store recording every call.
type MemStore struct {
	mu       sync.Mutex
	Video    job.Video
	Missing  bool // BeginJob reports the video as gone
	Attempts int  // attempts already used
	Ready    []job.ReadyResult
	Fails    []job.FailRecord
	Encoders []string // SetJobEncoder calls
	Progress []float64
	Begun    []string // encoder passed to BeginJob

	CompleteOK   *bool // nil = true
	FailJobError error
}

func (s *MemStore) BeginJob(_ context.Context, id uuid.UUID, encoder, _ string) (job.BeginResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Begun = append(s.Begun, encoder)
	if s.Missing || s.Video.Status == "READY" {
		return job.BeginResult{Skip: true}, nil
	}
	s.Attempts++
	s.Video.Status = "PROCESSING"
	return job.BeginResult{Video: s.Video, JobID: uuid.New(), Attempt: s.Attempts}, nil
}

func (s *MemStore) SetJobEncoder(_ context.Context, _ uuid.UUID, enc string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Encoders = append(s.Encoders, enc)
	return nil
}

func (s *MemStore) SetProgress(_ context.Context, _ uuid.UUID, p float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Progress = append(s.Progress, p)
	return nil
}

func (s *MemStore) Complete(_ context.Context, r job.ReadyResult) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.CompleteOK != nil && !*s.CompleteOK {
		return false, nil
	}
	s.Ready = append(s.Ready, r)
	s.Video.Status = "READY"
	return true, nil
}

func (s *MemStore) FailJob(_ context.Context, f job.FailRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.FailJobError != nil {
		return s.FailJobError
	}
	s.Fails = append(s.Fails, f)
	return nil
}

// Object is one stored object.
type Object struct {
	Data         []byte
	ContentType  string
	CacheControl string
}

// MemObjects is an in-memory job.Objects. Keys are "bucket/key".
type MemObjects struct {
	mu          sync.Mutex
	Objs        map[string]Object
	UploadOrder []string
	DownloadErr error
	UploadErr   error
}

func NewMemObjects() *MemObjects { return &MemObjects{Objs: map[string]Object{}} }

func (m *MemObjects) Put(bucket, key string, data []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Objs[bucket+"/"+key] = Object{Data: data}
}

func (m *MemObjects) Keys(bucket string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for k := range m.Objs {
		if rest, ok := strings.CutPrefix(k, bucket+"/"); ok {
			out = append(out, rest)
		}
	}
	sort.Strings(out)
	return out
}

func (m *MemObjects) Get(bucket, key string) (Object, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.Objs[bucket+"/"+key]
	return o, ok
}

func (m *MemObjects) Download(_ context.Context, bucket, key, dst string) error {
	if m.DownloadErr != nil {
		return m.DownloadErr
	}
	o, ok := m.Get(bucket, key)
	if !ok {
		return errors.New("no such key")
	}
	return os.WriteFile(dst, o.Data, 0o644)
}

func (m *MemObjects) UploadFile(ctx context.Context, bucket, key, src, ct, cc string) error {
	if m.UploadErr != nil {
		return m.UploadErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Clean(src))
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Objs[bucket+"/"+key] = Object{Data: data, ContentType: ct, CacheControl: cc}
	m.UploadOrder = append(m.UploadOrder, key)
	return nil
}

func (m *MemObjects) DeletePrefix(_ context.Context, bucket, prefix string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k := range m.Objs {
		if strings.HasPrefix(k, bucket+"/"+prefix) {
			delete(m.Objs, k)
		}
	}
	return nil
}

func (m *MemObjects) DeleteObject(_ context.Context, bucket, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.Objs, bucket+"/"+key)
	return nil
}

func (m *MemObjects) ListPrefixes(_ context.Context, bucket, prefix string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	seen := map[string]bool{}
	for k := range m.Objs {
		rest, ok := strings.CutPrefix(k, bucket+"/"+prefix)
		if !ok {
			continue
		}
		if i := strings.Index(rest, "/"); i >= 0 {
			seen[prefix+rest[:i+1]] = true
		}
	}
	var out []string
	for p := range seen {
		out = append(out, p)
	}
	sort.Strings(out)
	return out, nil
}

// RecEvents records core-NATS publishes.
type RecEvents struct {
	mu   sync.Mutex
	Msgs []RecMsg
}

type RecMsg struct {
	Subject string
	Data    []byte
}

func (r *RecEvents) Publish(subject string, data []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Msgs = append(r.Msgs, RecMsg{subject, data})
	return nil
}

func (r *RecEvents) Snapshot() []RecMsg {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RecMsg(nil), r.Msgs...)
}

// MaterializeHLS writes every object under prefix+"hls/" to a temp directory,
// keeping the relative layout, so ffprobe can read the published output.
func MaterializeHLS(t testing.TB, m *MemObjects, bucket, prefix string) string {
	t.Helper()
	dir := t.TempDir()
	for _, k := range m.Keys(bucket) {
		rel, ok := strings.CutPrefix(k, prefix+"hls/")
		if !ok {
			continue
		}
		o, _ := m.Get(bucket, k)
		dst := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, o.Data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}
