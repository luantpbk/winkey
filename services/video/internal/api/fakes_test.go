package api

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// memStore is an in-memory domain.Store with the same semantics as the
// PostgreSQL one (filters, ordering, keyset comparison).
type memStore struct {
	mu        sync.Mutex
	videos    map[uuid.UUID]domain.Video
	progress  map[uuid.UUID]float64
	raw       map[uuid.UUID][2]string // raw bucket, raw key (not part of the API record)
	errs      map[uuid.UUID]string    // owner-safe failure messages
	deleted   []domain.DeletedEvent
	moderated []domain.ModeratedEvent // video.moderated events, in order
	gets      int
	lists     int

	searches  []domain.SearchQuery
	suggests  []string
	searchFn  func(domain.SearchQuery) (domain.SearchResult, error)
	suggestFn func(string, int) ([]string, error)
}

func newMemStore() *memStore {
	return &memStore{videos: map[uuid.UUID]domain.Video{}, progress: map[uuid.UUID]float64{},
		raw: map[uuid.UUID][2]string{}, errs: map[uuid.UUID]string{}}
}

func (s *memStore) put(v domain.Video) domain.Video {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.videos[v.ID] = v
	return v
}

func (s *memStore) GetVideo(_ context.Context, id uuid.UUID) (domain.Video, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gets++
	v, ok := s.videos[id]
	if !ok {
		return domain.Video{}, domain.ErrNotFound
	}
	return v, nil
}

func less(t1 time.Time, id1 uuid.UUID, t2 time.Time, id2 uuid.UUID) bool { // (t1,id1) < (t2,id2)
	if !t1.Equal(t2) {
		return t1.Before(t2)
	}
	return id1.String() < id2.String()
}

func (s *memStore) ListFeed(_ context.Context, q domain.FeedQuery) ([]domain.Summary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lists++
	var out []domain.Summary
	for _, v := range s.videos {
		if v.Status != domain.StatusReady || v.Visibility != domain.VisPublic || v.Owner.Missing || v.Hidden() {
			continue
		}
		if q.OwnerID != nil && v.OwnerID != *q.OwnerID {
			continue
		}
		if q.After != nil && !less(*v.PublishedAt, v.ID, q.After.T, q.After.ID) {
			continue
		}
		out = append(out, domain.Summary{
			ID: v.ID, Title: v.Title, Owner: v.Owner, DurationMs: *v.DurationMs, ViewCount: v.ViewCount,
			PublishedAt: *v.PublishedAt, ThumbnailKey: *v.ThumbnailKey,
		})
	}
	sort.Slice(out, func(i, j int) bool { return less(out[j].PublishedAt, out[j].ID, out[i].PublishedAt, out[i].ID) })
	if len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out, nil
}

func (s *memStore) ListStudio(_ context.Context, q domain.StudioQuery) ([]domain.StudioItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []domain.StudioItem
	for _, v := range s.videos {
		if v.OwnerID != q.UserID || (q.Status != "" && v.Status != q.Status) {
			continue
		}
		if q.After != nil && !less(v.CreatedAt, v.ID, q.After.T, q.After.ID) {
			continue
		}
		item := domain.StudioItem{
			ID: v.ID, Title: v.Title, Visibility: v.Visibility, Status: v.Status, Progress: s.progress[v.ID],
			DurationMs: v.DurationMs, CreatedAt: v.CreatedAt, ThumbnailKey: v.ThumbnailKey,
			ModerationState: v.ModerationState, ModerationReason: v.ModerationReason, ModeratedAt: v.ModeratedAt,
		}
		if msg, ok := s.errs[v.ID]; ok {
			item.Error = &msg
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return less(out[j].CreatedAt, out[j].ID, out[i].CreatedAt, out[i].ID) })
	if len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out, nil
}

func (s *memStore) UpdateVideo(_ context.Context, id, ownerID uuid.UUID, u domain.Update) (domain.Video, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.videos[id]
	if !ok || v.OwnerID != ownerID {
		return domain.Video{}, domain.ErrNotFound
	}
	if u.Title != nil {
		v.Title = *u.Title
	}
	if u.Description != nil {
		v.Description = *u.Description
	}
	if u.Visibility != nil {
		v.Visibility = *u.Visibility
	}
	s.videos[id] = v
	return v, nil
}

func (s *memStore) DeleteVideo(_ context.Context, id uuid.UUID, mediaBucket string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.videos[id]
	if !ok {
		return false, nil
	}
	delete(s.videos, id)
	s.deleted = append(s.deleted, domain.DeletedEvent{
		VideoID: id.String(), OwnerID: v.OwnerID.String(), RawBucket: s.raw[id][0], RawKey: s.raw[id][1],
		MediaBucket: mediaBucket, MediaPrefix: "v/" + id.String() + "/",
	})
	return true, nil
}

func (s *memStore) ModerateVideo(_ context.Context, id, moderatorID uuid.UUID, state string, reason *string) (domain.Video, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.videos[id]
	if !ok {
		return domain.Video{}, false, domain.ErrNotFound
	}
	cur := v.ModerationState
	if cur == "" {
		cur = domain.ModVisible
	}
	if cur == state {
		return v, false, nil
	}
	now := time.Now().UTC()
	v.ModerationState, v.ModerationReason, v.ModeratedBy, v.ModeratedAt = state, reason, &moderatorID, &now
	s.videos[id] = v
	s.moderated = append(s.moderated, domain.ModeratedEvent{
		VideoID: id.String(), OwnerID: v.OwnerID.String(), State: state, ModeratorID: moderatorID.String(),
	})
	return v, true, nil
}

// memCache counts hits and misses.
type memCache struct {
	mu                        sync.Mutex
	m                         map[uuid.UUID]domain.Video
	hits, misses, sets, inval int
}

func newMemCache() *memCache { return &memCache{m: map[uuid.UUID]domain.Video{}} }

func (c *memCache) Get(_ context.Context, id uuid.UUID) (domain.Video, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.m[id]
	if ok {
		c.hits++
	} else {
		c.misses++
	}
	return v, ok
}
func (c *memCache) Set(_ context.Context, v domain.Video) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sets++
	c.m[v.ID] = v
}
func (c *memCache) Invalidate(_ context.Context, id uuid.UUID) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.inval++
	delete(c.m, id)
}

// SearchVideos and SuggestTitles delegate to scripts set by the test (the real
// matching is exercised on PostgreSQL in internal/integration).
func (s *memStore) SearchVideos(_ context.Context, q domain.SearchQuery) (domain.SearchResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.searches = append(s.searches, q)
	if s.searchFn == nil {
		return domain.SearchResult{}, nil
	}
	return s.searchFn(q)
}

func (s *memStore) SuggestTitles(_ context.Context, q string, limit int) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.suggests = append(s.suggests, q)
	if s.suggestFn == nil {
		return nil, nil
	}
	return s.suggestFn(q, limit)
}
