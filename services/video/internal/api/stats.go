package api

import (
	"errors"
	"net/http"
	"time"
	_ "time/tzdata" // the image is distroless: it has no zoneinfo

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Creator statistics (task R1-b, ADR-022 addendum): the numbers come from analytics.video_daily in PostgreSQL, which
// analytics-worker refreshes from ClickHouse. Days are calendar days in Asia/Ho_Chi_Minh.

const (
	statsTimezone    = "Asia/Ho_Chi_Minh"
	statsDefaultDays = 28
	statsMaxDays     = 90
	statsMaxAgeDays  = 730
	statsRateLimit   = 60 // per user per minute, shared by both routes
	dateLayout       = "2006-01-02"
)

var statsLocation = mustLocation(statsTimezone)

func mustLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic("zoneinfo " + name + ": " + err.Error())
	}
	return loc
}

// statsToday is the current calendar date in Asia/Ho_Chi_Minh as midnight UTC (the form pgx sends for a date).
func statsToday(now time.Time) time.Time {
	y, m, d := now.In(statsLocation).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// ParseStatsRange applies the defaults and the rules of the contract. today is statsToday(now).
func ParseStatsRange(fromRaw, toRaw string, today time.Time) (from, to time.Time, fe []httpx.FieldError) {
	to = today
	if toRaw != "" {
		t, err := time.Parse(dateLayout, toRaw)
		if err != nil {
			return from, to, []httpx.FieldError{{Field: "to", Message: "must be a date (YYYY-MM-DD)"}}
		}
		to = t
		if to.After(today) {
			to = today // a later day is clamped to today
		}
	}
	from = to.AddDate(0, 0, -(statsDefaultDays - 1))
	if fromRaw != "" {
		t, err := time.Parse(dateLayout, fromRaw)
		if err != nil {
			return from, to, []httpx.FieldError{{Field: "from", Message: "must be a date (YYYY-MM-DD)"}}
		}
		from = t
	}
	switch {
	case from.After(to):
		fe = append(fe, httpx.FieldError{Field: "from", Message: "must not be after to"})
	case to.Sub(from) > time.Duration(statsMaxDays-1)*24*time.Hour:
		fe = append(fe, httpx.FieldError{Field: "from", Message: "the range holds at most 90 days"})
	case from.Before(today.AddDate(0, 0, -statsMaxAgeDays)):
		fe = append(fe, httpx.FieldError{Field: "from", Message: "must not be more than 730 days before today"})
	}
	return from, to, fe
}

func (h *Handler) statsRange(w http.ResponseWriter, r *http.Request) (from, to time.Time, ok bool) {
	q := r.URL.Query()
	from, to, fe := ParseStatsRange(q.Get("from"), q.Get("to"), statsToday(h.now()))
	if len(fe) > 0 {
		httpx.BadRequest(w, r, "VALIDATION_ERROR", fe[0].Field+": "+fe[0].Message, fe...)
		return from, to, false
	}
	return from, to, true
}

// ---- JSON ---------------------------------------------------------------------------------------------------------

type statsTotalsJSON struct {
	Starts        int64    `json:"starts"`
	WatchTimeMs   int64    `json:"watch_time_ms"`
	AvgWatchMs    *int64   `json:"avg_watch_ms"`
	RebufferRatio *float64 `json:"rebuffer_ratio"`
	Errors        int64    `json:"errors"`
}

type videoStatsDayJSON struct {
	Day           string   `json:"day"`
	Starts        int64    `json:"starts"`
	WatchTimeMs   int64    `json:"watch_time_ms"`
	Viewers       int64    `json:"viewers"`
	RebufferRatio *float64 `json:"rebuffer_ratio"`
	StartupP50Ms  *int     `json:"startup_p50_ms"`
	StartupP95Ms  *int     `json:"startup_p95_ms"`
}

type videoStatsJSON struct {
	VideoID     string              `json:"video_id"`
	From        string              `json:"from"`
	To          string              `json:"to"`
	Timezone    string              `json:"timezone"`
	ViewCount   int64               `json:"view_count"`
	Totals      statsTotalsJSON     `json:"totals"`
	Days        []videoStatsDayJSON `json:"days"`
	RefreshedAt *time.Time          `json:"refreshed_at"`
}

type channelStatsDayJSON struct {
	Day           string   `json:"day"`
	Starts        int64    `json:"starts"`
	WatchTimeMs   int64    `json:"watch_time_ms"`
	RebufferRatio *float64 `json:"rebuffer_ratio"`
}

type topVideoJSON struct {
	VideoID     string `json:"video_id"`
	Title       string `json:"title"`
	Starts      int64  `json:"starts"`
	WatchTimeMs int64  `json:"watch_time_ms"`
}

type channelStatsJSON struct {
	From        string                `json:"from"`
	To          string                `json:"to"`
	Timezone    string                `json:"timezone"`
	Totals      statsTotalsJSON       `json:"totals"`
	Days        []channelStatsDayJSON `json:"days"`
	TopVideos   []topVideoJSON        `json:"top_videos"`
	RefreshedAt *time.Time            `json:"refreshed_at"`
}

// rebufferRatio is rebuffer / (watched + rebuffer); null when both are 0.
func rebufferRatio(watched, rebuffer int64) *float64 {
	if watched+rebuffer == 0 {
		return nil
	}
	v := float64(rebuffer) / float64(watched+rebuffer)
	return &v
}

func totals(starts, watched, rebuffer, errs int64) statsTotalsJSON {
	t := statsTotalsJSON{Starts: starts, WatchTimeMs: watched, Errors: errs, RebufferRatio: rebufferRatio(watched, rebuffer)}
	if starts > 0 {
		v := watched / starts // floor: both are non-negative
		t.AvgWatchMs = &v
	}
	return t
}

func dayRange(from, to time.Time) []time.Time {
	var out []time.Time
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		out = append(out, d)
	}
	return out
}

// ---- rate limit ---------------------------------------------------------------------------------------------------

// limitedUser is limited keyed by the user id instead of the client IP.
func (h *Handler) limitedUser(w http.ResponseWriter, r *http.Request, scope string, user uuid.UUID, limit int) bool {
	return h.limitedKey(w, r, scope, user.String(), limit, limit)
}

// ---- GET /v1/studio/videos/{video_id}/stats -----------------------------------------------------------------------

func (h *Handler) getVideoStats(w http.ResponseWriter, r *http.Request) {
	who := viewer(r)
	if h.limitedUser(w, r, "studio-stats", who.ID, statsRateLimit) {
		return
	}
	w.Header().Set("Cache-Control", cachePrivate)
	id, ok := videoID(r)
	if !ok {
		notFound(w, r)
		return
	}
	from, to, ok := h.statsRange(w, r)
	if !ok {
		return
	}
	data, err := h.Store.VideoStats(r.Context(), id, from, to)
	if errors.Is(err, domain.ErrNotFound) {
		notFound(w, r)
		return
	}
	if err != nil {
		h.fail(w, r, "video stats", err)
		return
	}
	admin := httpx.Identity{UserID: who.ID, Roles: who.Roles}.HasRole(httpx.RoleAdmin)
	if data.OwnerID != who.ID && !admin {
		notFound(w, r) // 404, never 403
		return
	}

	byDay := make(map[time.Time]domain.DailyStats, len(data.Days))
	var refreshed *time.Time
	var starts, watched, rebuffer, errs int64
	for _, d := range data.Days {
		byDay[d.Day] = d
		starts, watched, rebuffer, errs = starts+d.Starts, watched+d.WatchedMs, rebuffer+d.RebufferMs, errs+d.Errors
		if refreshed == nil || d.RefreshedAt.After(*refreshed) {
			t := d.RefreshedAt.UTC()
			refreshed = &t
		}
	}
	days := dayRange(from, to)
	out := videoStatsJSON{VideoID: id.String(), From: from.Format(dateLayout), To: to.Format(dateLayout), Timezone: statsTimezone,
		ViewCount: data.ViewCount, Totals: totals(starts, watched, rebuffer, errs), Days: make([]videoStatsDayJSON, 0, len(days)),
		RefreshedAt: refreshed}
	for _, day := range days {
		d := byDay[day] // zero value for a day without a row
		out.Days = append(out.Days, videoStatsDayJSON{Day: day.Format(dateLayout), Starts: d.Starts, WatchTimeMs: d.WatchedMs,
			Viewers: d.Viewers, RebufferRatio: rebufferRatio(d.WatchedMs, d.RebufferMs), StartupP50Ms: d.StartupP50Ms, StartupP95Ms: d.StartupP95Ms})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ---- GET /v1/studio/stats -----------------------------------------------------------------------------------------

func (h *Handler) getChannelStats(w http.ResponseWriter, r *http.Request) {
	who := viewer(r)
	if h.limitedUser(w, r, "studio-stats", who.ID, statsRateLimit) {
		return
	}
	w.Header().Set("Cache-Control", cachePrivate)
	from, to, ok := h.statsRange(w, r)
	if !ok {
		return
	}
	data, err := h.Store.ChannelStats(r.Context(), who.ID, from, to)
	if err != nil {
		h.fail(w, r, "channel stats", err)
		return
	}
	byDay := make(map[time.Time]domain.ChannelDay, len(data.Days))
	var refreshed *time.Time
	var starts, watched, rebuffer, errs int64
	for _, d := range data.Days {
		byDay[d.Day] = d
		starts, watched, rebuffer, errs = starts+d.Starts, watched+d.WatchedMs, rebuffer+d.RebufferMs, errs+d.Errors
		if refreshed == nil || d.RefreshedAt.After(*refreshed) {
			t := d.RefreshedAt.UTC()
			refreshed = &t
		}
	}
	days := dayRange(from, to)
	out := channelStatsJSON{From: from.Format(dateLayout), To: to.Format(dateLayout), Timezone: statsTimezone,
		Totals: totals(starts, watched, rebuffer, errs), Days: make([]channelStatsDayJSON, 0, len(days)),
		TopVideos: make([]topVideoJSON, 0, len(data.Top)), RefreshedAt: refreshed}
	for _, day := range days {
		d := byDay[day]
		out.Days = append(out.Days, channelStatsDayJSON{Day: day.Format(dateLayout), Starts: d.Starts, WatchTimeMs: d.WatchedMs,
			RebufferRatio: rebufferRatio(d.WatchedMs, d.RebufferMs)})
	}
	for _, t := range data.Top {
		out.TopVideos = append(out.TopVideos, topVideoJSON{VideoID: t.ID.String(), Title: t.Title, Starts: t.Starts, WatchTimeMs: t.WatchedMs})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}
