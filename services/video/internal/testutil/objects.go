package testutil

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
)

// StoredObject is one object of MemObjects.
type StoredObject struct {
	Data         []byte
	ContentType  string
	CacheControl string
}

// MemObjects is an in-memory domain.Objects that records what was stored, for tests that do not
// need Garage. Keys are "bucket/key".
type MemObjects struct {
	mu   sync.Mutex
	objs map[string]StoredObject
	// PutErr and DeleteErr make the next calls fail (until reset to nil).
	PutErr, DeleteErr error
	Puts, Deletes     []string // keys, in call order
}

func NewMemObjects() *MemObjects { return &MemObjects{objs: map[string]StoredObject{}} }

func (m *MemObjects) Put(ctx context.Context, bucket, key string, data []byte, contentType, cacheControl string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.PutErr != nil {
		return m.PutErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	m.objs[bucket+"/"+key] = StoredObject{Data: append([]byte(nil), data...), ContentType: contentType, CacheControl: cacheControl}
	m.Puts = append(m.Puts, key)
	return nil
}

func (m *MemObjects) Delete(_ context.Context, bucket, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Deletes = append(m.Deletes, key)
	if m.DeleteErr != nil {
		return m.DeleteErr
	}
	delete(m.objs, bucket+"/"+key)
	return nil
}

// Get returns the object, ok false when it is not there.
func (m *MemObjects) Get(bucket, key string) (StoredObject, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.objs[bucket+"/"+key]
	return o, ok
}

// Keys lists the keys of bucket that start with prefix, sorted.
func (m *MemObjects) Keys(bucket, prefix string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for k := range m.objs {
		if rest, ok := strings.CutPrefix(k, bucket+"/"); ok && strings.HasPrefix(rest, prefix) {
			out = append(out, rest)
		}
	}
	sort.Strings(out)
	return out
}

// DeletePrefix removes every object of bucket under prefix, like the media janitor does for a deleted video.
func (m *MemObjects) DeletePrefix(bucket, prefix string) error {
	if prefix == "" || !strings.HasSuffix(prefix, "/") {
		return errors.New("refusing to delete without a prefix ending in /")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for k := range m.objs {
		if strings.HasPrefix(k, bucket+"/"+prefix) {
			delete(m.objs, k)
		}
	}
	return nil
}
