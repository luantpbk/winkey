package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Related videos v1 (task R2-c, ADR-025): no personalisation, the same answer for every caller.

const (
	relatedDefaultLimit = 12
	relatedMaxLimit     = 24
	relatedSimilarMax   = 8
	relatedChannelMax   = 4
	relatedTrendingPad  = 13 // trending is asked for limit + 13 so that duplicates never leave the list short
	relatedMaxWords     = 12
	relatedMinWordRunes = 2
	relatedTTL          = 300 * time.Second
	cacheRelated        = "public, max-age=300"
)

var (
	relatedItems = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "video_related_items", Help: "Number of items in a GET /v1/videos/{id}/related answer.",
		Buckets: []float64{0, 1, 2, 4, 8, 12, 16, 24},
	})
	relatedCache = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "video_related_cache_total", Help: "Related-videos cache lookups by result (hit or miss).",
	}, []string{"result"})
)

// RelatedCache keeps the final JSON of an answer for a short time. Implementations fail open: an error is a miss.
type RelatedCache interface {
	GetRelated(ctx context.Context, key string) ([]byte, bool)
	SetRelated(ctx context.Context, key string, body []byte, ttl time.Duration)
}

// RelatedQuery turns a title into the text of a to_tsquery('simple', ...) that OR-s its words: the words are the
// letter/digit runs of the title in lower case, words shorter than 2 runes are dropped, duplicates are dropped, at most
// 12 are kept, and each is single-quoted. The text is folded (unaccented) in SQL by winkey_fold, like the index.
// Only letters and digits survive the split, so no tsquery operator, quote or backslash can get in. ok is false when
// no word is left (the similar source is then skipped).
func RelatedQuery(title string) (query string, ok bool) {
	words := strings.FieldsFunc(strings.ToLower(title), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	seen := map[string]bool{}
	var out []string
	for _, w := range words {
		if utf8.RuneCountInString(w) < relatedMinWordRunes || seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, "'"+w+"'")
		if len(out) == relatedMaxWords {
			break
		}
	}
	if len(out) == 0 {
		return "", false
	}
	return strings.Join(out, " | "), true
}

// relatedPattern is the fixed merge order: 1 similar, 2 same channel, 3 trending.
var relatedPattern = [...]int{0, 0, 1, 0, 2}

// MergeRelated interleaves the three sources in the pattern 1, 1, 2, 1, 3 (repeated) and stops at limit. A source
// that has nothing left is replaced by the next source of the pattern; videos already taken are skipped. Pure.
func MergeRelated(similar, channel, trending []domain.Summary, limit int) []domain.Summary {
	src := [3][]domain.Summary{similar, channel, trending}
	next := [3]int{}
	taken := map[uuid.UUID]bool{}
	out := make([]domain.Summary, 0, limit)
	pop := func(s int) (domain.Summary, bool) {
		for next[s] < len(src[s]) {
			v := src[s][next[s]]
			next[s]++
			if !taken[v.ID] {
				taken[v.ID] = true
				return v, true
			}
		}
		return domain.Summary{}, false
	}
	for slot := 0; len(out) < limit; slot++ {
		progressed := false
		for k := 0; k < len(relatedPattern); k++ { // this slot's source, else the next sources of the pattern
			if v, ok := pop(relatedPattern[(slot+k)%len(relatedPattern)]); ok {
				out = append(out, v)
				progressed = true
				break
			}
		}
		if !progressed {
			break
		}
	}
	return out
}

func parseRelatedLimit(raw string) (int, bool) {
	if raw == "" {
		return relatedDefaultLimit, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > relatedMaxLimit {
		return 0, false
	}
	return n, true
}

type relatedJSON struct {
	Items []summaryJSON `json:"items"`
}

// ---- GET /v1/videos/{video_id}/related -----------------------------------------------------------------------------

func (h *Handler) listRelatedVideos(w http.ResponseWriter, r *http.Request) {
	limit, ok := parseRelatedLimit(r.URL.Query().Get("limit"))
	if !ok {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "limit must be between 1 and 24",
			httpx.FieldError{Field: "limit", Message: "must be between 1 and 24"})
		return
	}
	id, ok := videoID(r)
	if !ok {
		notFound(w, r)
		return
	}
	src, err := h.load(r, id, true)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			notFound(w, r)
			return
		}
		h.fail(w, r, "related: source", err)
		return
	}
	// The answer is shared by every caller (public cache), so the source must be one the public could open:
	// readable like getVideo AND not PRIVATE, hidden or unfinished, even for its owner (ADR-025).
	if src.Status != domain.StatusReady || src.Visibility == domain.VisPrivate || src.Hidden() || !domain.CanView(src, viewer(r)) {
		notFound(w, r)
		return
	}

	key := "related:v1:" + id.String() + ":" + strconv.Itoa(limit)
	if h.RelatedCache != nil {
		if body, hit := h.RelatedCache.GetRelated(r.Context(), key); hit {
			relatedCache.WithLabelValues("hit").Inc()
			h.writeRelated(w, body)
			return
		}
		relatedCache.WithLabelValues("miss").Inc()
	}

	items, err := h.relatedItems(r, src, limit)
	if err != nil {
		h.fail(w, r, "related", err)
		return
	}
	out := relatedJSON{Items: make([]summaryJSON, 0, len(items))}
	for _, s := range items {
		out.Items = append(out.Items, h.summary(s))
	}
	body, err := json.Marshal(out)
	if err != nil {
		h.fail(w, r, "related: encode", err)
		return
	}
	relatedItems.Observe(float64(len(items)))
	if h.RelatedCache != nil {
		h.RelatedCache.SetRelated(r.Context(), key, body, relatedTTL)
	}
	h.writeRelated(w, body)
}

func (h *Handler) writeRelated(w http.ResponseWriter, body []byte) {
	w.Header().Set("Cache-Control", cacheRelated)
	httpx.WriteJSON(w, http.StatusOK, json.RawMessage(body))
}

// relatedItems runs the three short queries and merges them.
func (h *Handler) relatedItems(r *http.Request, src domain.Video, limit int) ([]domain.Summary, error) {
	var similar []domain.Summary
	// Tags first: RelatedQuery keeps at most relatedMaxWords words, and the owner's tags are the strongest signal.
	if q, ok := RelatedQuery(strings.Join(src.Tags, " ") + " " + src.Title); ok {
		s, err := h.Store.RelatedSimilar(r.Context(), src.ID, q, relatedSimilarMax)
		if err != nil {
			return nil, err
		}
		similar = s
	}
	channel, err := h.Store.RelatedSameChannel(r.Context(), src.OwnerID, src.ID, relatedChannelMax)
	if err != nil {
		return nil, err
	}
	trending, err := h.Store.RelatedTrending(r.Context(), src.ID, limit+relatedTrendingPad)
	if err != nil {
		return nil, err
	}
	return MergeRelated(similar, channel, trending, limit), nil
}
