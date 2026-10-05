package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/analytics"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/views"
)

// Limits of recordPlaybackHeartbeats (video.v1.yaml, task R1, ADR-022).
const (
	maxHeartbeatBody        = 16 << 10 // 16 KiB
	maxHeartbeatSamples     = 20
	defaultHeartbeatRateLim = 30 // requests per client IP per minute
)

// heartbeatBatch and heartbeatSample follow PlaybackHeartbeatBatch / PlaybackSample. Pointers tell a missing field
// from a zero one; unknown fields are refused by the strict decoder.
type heartbeatBatch struct {
	Samples *[]heartbeatSample `json:"samples"`
}

type heartbeatSample struct {
	PlaybackID    *string         `json:"playback_id"`
	VideoID       *string         `json:"video_id"`
	Kind          *string         `json:"kind"`
	Seq           *int64          `json:"seq"`
	SentAt        *string         `json:"sent_at"`
	PositionMs    *int64          `json:"position_ms"`
	WatchedMs     *int64          `json:"watched_ms"`
	RebufferMs    *int64          `json:"rebuffer_ms"`
	RebufferCount *int64          `json:"rebuffer_count"`
	StartupMs     *int64          `json:"startup_ms"`
	Rendition     *string         `json:"rendition"`
	BitrateKbps   *int64          `json:"bitrate_kbps"`
	ErrorCode     *string         `json:"error_code"`
	Client        *string         `json:"client"`
	Surface       json.RawMessage `json:"surface"` // distinguishes omitted from explicit null (not allowed by OpenAPI)
	_             struct{}        `json:"-"`
}

type heartbeatResult struct {
	Accepted int `json:"accepted"`
}

// recordPlaybackHeartbeats serves POST /v1/playback/heartbeats: it validates the batch strictly, keeps the samples of
// videos the caller may read, and publishes one analytics.playback event per kept sample. A publish problem drops the
// sample and counts it; it is never an error for the player.
func (h *Handler) recordPlaybackHeartbeats(w http.ResponseWriter, r *http.Request) {
	// Rate limit first (cheapest check; same limiter and client IP rules as recordView).
	if h.limited(w, r, "heartbeat", h.HeartbeatRateLimit, defaultHeartbeatRateLim) {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxHeartbeatBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var batch heartbeatBatch
	if err := dec.Decode(&batch); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpx.WriteProblem(w, r, httpx.NewProblem(http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "the request body is larger than 16 KiB"))
			return
		}
		httpx.BadRequest(w, r, "INVALID_JSON", "request body is not valid JSON for this endpoint")
		return
	}
	if dec.More() {
		httpx.BadRequest(w, r, "INVALID_JSON", "unexpected data after JSON body")
		return
	}
	samples, fe := validateSamples(batch)
	if len(fe) > 0 {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "invalid playback samples", fe...)
		return
	}

	// Telemetry switched off (or not wired): accept and forget.
	if h.Analytics == nil || len(h.AnalyticsSalt) == 0 {
		httpx.WriteJSON(w, http.StatusAccepted, heartbeatResult{Accepted: 0})
		return
	}

	who := viewer(r)
	videos, err := h.playbackVideos(r, samples)
	if err != nil {
		h.Log.WarnContext(r.Context(), "playback heartbeats: video lookup failed; dropping the batch", "error", err)
		analytics.SamplesTotal.WithLabelValues("dropped_lookup_error").Add(float64(len(samples)))
		httpx.WriteJSON(w, http.StatusAccepted, heartbeatResult{Accepted: 0})
		return
	}

	// The viewer: the user id, or C3's anonymous hash (IP + user agent go into that hash only, never into the event).
	ip := views.ClientIP(r, h.TrustedProxies)
	key := analytics.ViewerKey(h.AnalyticsSalt, viewerKey(who, ip, r.UserAgent()))
	now := h.now()

	accepted := 0
	variant := h.recoVariant(who)
	for _, s := range samples {
		v, ok := videos[s.VideoID]
		if !ok || v.Status != domain.StatusReady || !domain.CanView(v, who) {
			analytics.SamplesTotal.WithLabelValues("dropped_invalid_video").Inc()
			continue
		}
		s.RecoVariant = variant
		msg, err := analytics.Build(s, v.OwnerID, key, who.Authed, now)
		if err == nil {
			err = h.Analytics.Publish(r.Context(), msg)
		}
		if err != nil {
			analytics.SamplesTotal.WithLabelValues("publish_error").Inc()
			h.Log.DebugContext(r.Context(), "playback sample not published", "error", err)
			continue
		}
		analytics.SamplesTotal.WithLabelValues("published").Inc()
		accepted++
	}
	httpx.WriteJSON(w, http.StatusAccepted, heartbeatResult{Accepted: accepted})
}

// playbackVideos reads the videos of the batch: the cache first (the record of GetVideo), then ONE query for every
// distinct id that is missing.
func (h *Handler) playbackVideos(r *http.Request, samples []analytics.Sample) (map[uuid.UUID]domain.Video, error) {
	out := map[uuid.UUID]domain.Video{}
	seen := map[uuid.UUID]bool{}
	var missing []uuid.UUID
	for _, s := range samples {
		if seen[s.VideoID] {
			continue
		}
		seen[s.VideoID] = true
		if h.Cache != nil {
			if v, ok := h.Cache.Get(r.Context(), s.VideoID); ok {
				out[s.VideoID] = v
				continue
			}
		}
		missing = append(missing, s.VideoID)
	}
	if len(missing) == 0 {
		return out, nil
	}
	rows, err := h.Store.VideosForPlayback(r.Context(), missing)
	if err != nil {
		return nil, err
	}
	for _, v := range rows {
		out[v.ID] = v
	}
	return out, nil
}

// ---- validation -------------------------------------------------------------------------------------------------

func validateSamples(b heartbeatBatch) ([]analytics.Sample, []httpx.FieldError) {
	if b.Samples == nil {
		return nil, []httpx.FieldError{{Field: "samples", Message: "is required"}}
	}
	list := *b.Samples
	if len(list) < 1 || len(list) > maxHeartbeatSamples {
		return nil, []httpx.FieldError{{Field: "samples", Message: "must hold 1 to 20 samples"}}
	}
	var fe []httpx.FieldError
	out := make([]analytics.Sample, 0, len(list))
	for i, in := range list {
		s, errs := validateSample(in)
		for _, e := range errs {
			e.Field = "samples[" + strconv.Itoa(i) + "]." + e.Field
			fe = append(fe, e)
		}
		if len(errs) == 0 {
			out = append(out, s)
		}
	}
	return out, fe
}

func validateSample(in heartbeatSample) (analytics.Sample, []httpx.FieldError) {
	var fe []httpx.FieldError
	bad := func(field, msg string) { fe = append(fe, httpx.FieldError{Field: field, Message: msg}) }
	var s analytics.Sample

	uid := func(field string, p *string) uuid.UUID {
		if p == nil {
			bad(field, "is required")
			return uuid.Nil
		}
		id, err := uuid.Parse(*p)
		if err != nil || len(*p) != 36 {
			bad(field, "must be a UUID")
			return uuid.Nil
		}
		return id
	}
	num := func(field string, p *int64, min, max int64) int {
		if p == nil {
			bad(field, "is required")
			return 0
		}
		if *p < min || *p > max {
			bad(field, "must be between "+strconv.FormatInt(min, 10)+" and "+strconv.FormatInt(max, 10))
			return 0
		}
		return int(*p)
	}
	optNum := func(field string, p *int64, max int64) *int {
		if p == nil {
			return nil
		}
		if *p < 0 || *p > max {
			bad(field, "must be between 0 and "+strconv.FormatInt(max, 10))
			return nil
		}
		v := int(*p)
		return &v
	}
	optStr := func(field string, p *string, max int) *string {
		if p == nil {
			return nil
		}
		if utf8.RuneCountInString(*p) > max || !utf8.ValidString(*p) {
			bad(field, "must be at most "+strconv.Itoa(max)+" characters")
			return nil
		}
		return p
	}

	s.PlaybackID = uid("playback_id", in.PlaybackID)
	s.VideoID = uid("video_id", in.VideoID)
	switch {
	case in.Kind == nil:
		bad("kind", "is required")
	case *in.Kind != "start" && *in.Kind != "heartbeat" && *in.Kind != "end":
		bad("kind", "must be start, heartbeat or end")
	default:
		s.Kind = *in.Kind
	}
	s.Seq = num("seq", in.Seq, 0, 100000)
	switch in.SentAt {
	case nil:
		bad("sent_at", "is required")
	default:
		t, err := time.Parse(time.RFC3339, *in.SentAt)
		if err != nil {
			bad("sent_at", "must be an RFC 3339 date-time")
		}
		s.SentAt = t
	}
	s.PositionMs = num("position_ms", in.PositionMs, 0, 86_400_000)
	s.WatchedMs = num("watched_ms", in.WatchedMs, 0, 600_000)
	s.RebufferMs = num("rebuffer_ms", in.RebufferMs, 0, 600_000)
	s.RebufferCount = num("rebuffer_count", in.RebufferCount, 0, 1000)
	s.StartupMs = optNum("startup_ms", in.StartupMs, 600_000)
	s.Rendition = optStr("rendition", in.Rendition, 16)
	s.BitrateKbps = optNum("bitrate_kbps", in.BitrateKbps, 200_000)
	s.ErrorCode = optStr("error_code", in.ErrorCode, 64)
	s.Client = "web" // the default of the contract
	if len(in.Surface) > 0 {
		var surface string
		err := json.Unmarshal(in.Surface, &surface)
		switch surface {
		case "for_you", "trending", "subscriptions", "search", "channel", "latest", "up_next", "playlist", "other":
			if err == nil {
				s.Surface = &surface
			}
		default:
			bad("surface", "must be a playback surface from the contract")
		}
	}
	if in.Client != nil {
		switch *in.Client {
		case "web", "ios", "android", "other":
			s.Client = *in.Client
		default:
			bad("client", "must be web, ios, android or other")
		}
	}
	return s, fe
}
