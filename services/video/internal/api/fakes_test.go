package api

import (
	"context"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"golang.org/x/text/unicode/norm"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// memStore is an in-memory domain.Store with the same semantics as the
// PostgreSQL one (filters, ordering, keyset comparison).
type memStore struct {
	mu              sync.Mutex
	videos          map[uuid.UUID]domain.Video
	progress        map[uuid.UUID]float64
	raw             map[uuid.UUID][2]string // raw bucket, raw key (not part of the API record)
	errs            map[uuid.UUID]string    // owner-safe failure messages
	deleted         []domain.DeletedEvent
	moderated       []domain.ModeratedEvent // video.moderated events, in order
	gets            int
	subtitleWrites  int
	putSubtitleErr  error
	ranking         []rankedVideo
	follows         map[uuid.UUID]map[uuid.UUID]bool
	playbackLookups []int // ids per VideosForPlayback call
	playbackErr     error
	batchLookups    []int // ids per VideosByID call
	batchErr        error
	daily           map[uuid.UUID][]domain.DailyStats // by video, for VideoStats
	channel         domain.ChannelStatsData
	statsReads      int

	// related videos (R2-c): what the three queries return, and what they were asked
	relSimilar, relChannel, relTrending []domain.Summary
	relQuery                            string
	relSimilarLimit, relChannelLimit    int
	relTrendingLimit                    int
	relSource, relOwner                 uuid.UUID
	relCalls, relSimilarCalls           int
	trendingReads                       int
	mediaChecks                         int
	lists                               int

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
		if q.Tag != "" && (testSlug(q.Tag) == "" || !slices.Contains(v.TagSlugs, testSlug(q.Tag))) {
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
			OwnerActive: !v.Owner.Missing,
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
	if u.Tags != nil {
		v.Tags = *u.Tags
		v.TagSlugs = testSlugs(v.Tags) // the generated column tag_slugs
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

func (s *memStore) MediaPublic(_ context.Context, id uuid.UUID) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mediaChecks++
	v, ok := s.videos[id]
	return ok && v.PubliclyWatchable(), nil
}

// PutSubtitle and DeleteSubtitle keep the tracks in the video record, like the PostgreSQL store (one per
// language, at most MaxSubtitles for a new language, sorted on read).
func (s *memStore) PutSubtitle(_ context.Context, w domain.SubtitleWrite) (domain.SubtitleResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subtitleWrites++
	v, ok := s.videos[w.VideoID]
	if !ok {
		return domain.SubtitleResult{}, domain.ErrNotFound
	}
	if v.Status == domain.StatusFailed {
		return domain.SubtitleResult{}, domain.ErrVideoFailed
	}
	if s.putSubtitleErr != nil {
		return domain.SubtitleResult{}, s.putSubtitleErr
	}
	track := domain.Subtitle{Lang: w.Lang, Label: w.Label, Source: "UPLOAD", ObjectKey: w.ObjectKey, SizeBytes: w.SizeBytes, UpdatedAt: time.Date(2026, 10, 1, 9, 0, s.subtitleWrites, 0, time.UTC)}
	res := domain.SubtitleResult{Track: track, Created: true}
	subs := v.Subtitles
	for i, t := range subs {
		if t.Lang == w.Lang {
			res.Created, res.PreviousKey = false, t.ObjectKey
			subs = append(append([]domain.Subtitle{}, subs[:i]...), subs[i+1:]...)
			break
		}
	}
	if res.Created && len(subs) >= domain.MaxSubtitles {
		return domain.SubtitleResult{}, domain.ErrTooManySubtitles
	}
	subs = append(subs, track)
	sort.Slice(subs, func(i, j int) bool { return subs[i].Lang < subs[j].Lang })
	v.Subtitles = subs
	s.videos[w.VideoID] = v
	return res, nil
}

func (s *memStore) DeleteSubtitle(_ context.Context, id uuid.UUID, lang string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.videos[id]
	if !ok {
		return "", domain.ErrNotFound
	}
	for i, t := range v.Subtitles {
		if t.Lang == lang {
			v.Subtitles = append(append([]domain.Subtitle{}, v.Subtitles[:i]...), v.Subtitles[i+1:]...)
			s.videos[id] = v
			return t.ObjectKey, nil
		}
	}
	return "", domain.ErrNotFound
}

// ListTrending serves ranks set by the test, re-applying the public-feed predicate like the SQL does.
func (s *memStore) ListTrending(_ context.Context, q domain.TrendingQuery) ([]domain.TrendingItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.trendingReads++
	var out []domain.TrendingItem
	for _, r := range s.ranking { // ordered by rank
		v, ok := s.videos[r.id]
		if !ok || r.rank <= q.AfterRank || v.Status != domain.StatusReady || v.Visibility != domain.VisPublic || v.Owner.Missing || v.Hidden() {
			continue
		}
		out = append(out, domain.TrendingItem{Rank: r.rank, Summary: domain.Summary{
			ID: v.ID, Title: v.Title, Owner: v.Owner, DurationMs: *v.DurationMs, ViewCount: v.ViewCount,
			PublishedAt: *v.PublishedAt, ThumbnailKey: *v.ThumbnailKey,
		}})
		if len(out) == q.Limit {
			break
		}
	}
	return out, nil
}

type rankedVideo struct {
	id   uuid.UUID
	rank int
}

// follow records that subscriber follows channel (the projection of social.subscription.changed).
func (s *memStore) follow(subscriber, channel uuid.UUID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.follows == nil {
		s.follows = map[uuid.UUID]map[uuid.UUID]bool{}
	}
	if s.follows[subscriber] == nil {
		s.follows[subscriber] = map[uuid.UUID]bool{}
	}
	s.follows[subscriber][channel] = true
}

func (s *memStore) ListSubscriptionFeed(_ context.Context, q domain.SubscriptionFeedQuery) ([]domain.Summary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []domain.Summary
	for _, v := range s.videos {
		if !s.follows[q.Subscriber][v.OwnerID] || v.Status != domain.StatusReady || v.Visibility != domain.VisPublic || v.Owner.Missing || v.Hidden() {
			continue
		}
		if q.After != nil && !less(*v.PublishedAt, v.ID, q.After.T, q.After.ID) {
			continue
		}
		out = append(out, domain.Summary{ID: v.ID, Title: v.Title, Owner: v.Owner, DurationMs: *v.DurationMs, ViewCount: v.ViewCount,
			PublishedAt: *v.PublishedAt, ThumbnailKey: *v.ThumbnailKey})
	}
	sort.Slice(out, func(i, j int) bool { return less(out[j].PublishedAt, out[j].ID, out[i].PublishedAt, out[i].ID) })
	if len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out, nil
}

// VideoStats serves the configured daily rows of the video that fall in the range.
func (s *memStore) VideoStats(_ context.Context, id uuid.UUID, from, to time.Time) (domain.VideoStatsData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statsReads++
	v, ok := s.videos[id]
	if !ok {
		return domain.VideoStatsData{}, domain.ErrNotFound
	}
	out := domain.VideoStatsData{OwnerID: v.OwnerID, ViewCount: v.ViewCount}
	for _, d := range s.daily[id] {
		if !d.Day.Before(from) && !d.Day.After(to) {
			out.Days = append(out.Days, d)
		}
	}
	return out, nil
}

func (s *memStore) ChannelStats(_ context.Context, _ uuid.UUID, _, _ time.Time) (domain.ChannelStatsData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statsReads++
	return s.channel, nil
}

func (s *memStore) RelatedSimilar(_ context.Context, exclude uuid.UUID, q string, limit int) ([]domain.Summary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.relCalls++
	s.relSimilarCalls++
	s.relSource, s.relQuery, s.relSimilarLimit = exclude, q, limit
	return s.relSimilar, nil
}

func (s *memStore) RelatedSameChannel(_ context.Context, owner, exclude uuid.UUID, limit int) ([]domain.Summary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.relCalls++
	s.relOwner, s.relChannelLimit = owner, limit
	return s.relChannel, nil
}

func (s *memStore) RelatedTrending(_ context.Context, exclude uuid.UUID, limit int) ([]domain.Summary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.relCalls++
	s.relTrendingLimit = limit
	return s.relTrending, nil
}

// VideosByID returns the stored rows without renditions or subtitles (like the real query), counting the calls.
func (s *memStore) VideosByID(_ context.Context, ids []uuid.UUID) ([]domain.Video, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.batchLookups = append(s.batchLookups, len(ids))
	if s.batchErr != nil {
		return nil, s.batchErr
	}
	var out []domain.Video
	for _, id := range ids {
		if v, ok := s.videos[id]; ok {
			v.Renditions, v.Subtitles = nil, nil
			out = append(out, v)
		}
	}
	return out, nil
}

// VideosForPlayback returns the visibility-relevant part of the videos that exist, counting the calls.
func (s *memStore) VideosForPlayback(_ context.Context, ids []uuid.UUID) ([]domain.Video, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.playbackLookups = append(s.playbackLookups, len(ids))
	if s.playbackErr != nil {
		return nil, s.playbackErr
	}
	var out []domain.Video
	for _, id := range ids {
		if v, ok := s.videos[id]; ok {
			out = append(out, domain.Video{ID: v.ID, OwnerID: v.OwnerID, Status: v.Status, Visibility: v.Visibility,
				ModerationState: v.ModerationState, Owner: domain.Profile{ID: v.OwnerID, Missing: v.Owner.Missing}})
		}
	}
	return out, nil
}

// --- tags (SEO2) ---------------------------------------------------------------

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// testSlug mirrors public.winkey_tag_slug (migration 000021) for the inputs these tests use.
func testSlug(s string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(strings.ToLower(s)) {
		switch {
		case unicode.Is(unicode.Mn, r):
		case r == 'đ':
			b.WriteRune('d')
		default:
			b.WriteRune(r)
		}
	}
	return strings.Trim(nonSlug.ReplaceAllString(b.String(), "-"), "-")
}

func testSlugs(tags []string) []string {
	out := make([]string, len(tags))
	for i, t := range tags {
		out[i] = testSlug(t)
	}
	return out
}

func (s *memStore) tagStats(only string) []domain.Tag {
	type acc struct {
		videos map[uuid.UUID]bool
		names  map[string]int
		latest time.Time
	}
	by := map[string]*acc{}
	for _, v := range s.videos {
		if v.Status != domain.StatusReady || v.Visibility != domain.VisPublic || v.Owner.Missing || v.Hidden() {
			continue
		}
		for i, slug := range v.TagSlugs {
			if slug == "" || (only != "" && slug != only) {
				continue
			}
			a := by[slug]
			if a == nil {
				a = &acc{videos: map[uuid.UUID]bool{}, names: map[string]int{}}
				by[slug] = a
			}
			a.videos[v.ID] = true
			a.names[v.Tags[i]]++
			if v.PublishedAt.After(a.latest) {
				a.latest = *v.PublishedAt
			}
		}
	}
	out := []domain.Tag{}
	for slug, a := range by {
		name, best := "", 0
		for n, c := range a.names {
			if c > best || (c == best && n < name) {
				name, best = n, c
			}
		}
		out = append(out, domain.Tag{Slug: slug, Name: name, VideoCount: len(a.videos), LatestPublishedAt: a.latest})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].VideoCount != out[j].VideoCount {
			return out[i].VideoCount > out[j].VideoCount
		}
		return out[i].Slug < out[j].Slug
	})
	return out
}

func (s *memStore) ListTags(_ context.Context, limit, minVideos int) ([]domain.Tag, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []domain.Tag{}
	for _, t := range s.tagStats("") {
		if t.VideoCount >= minVideos && len(out) < limit {
			out = append(out, t)
		}
	}
	return out, nil
}

func (s *memStore) GetTag(_ context.Context, tag string) (domain.Tag, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	slug := testSlug(tag)
	if slug == "" {
		return domain.Tag{}, domain.ErrNotFound
	}
	if ts := s.tagStats(slug); len(ts) == 1 {
		return ts[0], nil
	}
	return domain.Tag{}, domain.ErrNotFound
}
