// Package event decodes and validates analytics.playback v1 messages (contracts/events/analytics.playback.schema.json
// and envelope.schema.json) into the rows of winkey.playback_events. Validation is written by hand (the schema
// files are not in the image) and is strict like the schemas: unknown keys, missing or mistyped fields, a
// non-canonical UUID, an out-of-range number all make the message malformed, and a message that is malformed can
// never become valid, so the worker terminates it instead of retrying.
package event

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"time"

	"github.com/google/uuid"
)

// Type is the event type and the NATS subject.
const Type = "analytics.playback"

// Result classifies a message.
type Result int

const (
	OK             Result = iota // valid: Row is set
	Malformed                    // can never succeed: Term + metric
	UnknownVersion               // a version this code does not know: Term + metric (analytics are lossy by design)
)

// Row is one row of winkey.playback_events, in the column order of db/clickhouse/0001_playback.sql.
type Row struct {
	EventID       uuid.UUID
	ReceivedAt    time.Time
	SentAt        time.Time
	PlaybackID    uuid.UUID
	VideoID       uuid.UUID
	OwnerID       uuid.UUID
	ViewerKey     string // 64 lower-case hex characters (FixedString(64))
	Authenticated bool
	Kind          string // start | heartbeat | end
	Seq           uint32
	PositionMs    uint32
	WatchedMs     uint32
	RebufferMs    uint32
	RebufferCount uint16
	StartupMs     *uint32
	Rendition     *string
	BitrateKbps   *uint32
	ErrorCode     *string
	Client        string
	Country       *string // always null in v1
}

type envelope struct {
	EventID    *string         `json:"event_id"`
	Type       *string         `json:"type"`
	Version    *int64          `json:"version"`
	OccurredAt *string         `json:"occurred_at"`
	Producer   *string         `json:"producer"`
	Trace      *string         `json:"traceparent"`
	Data       json.RawMessage `json:"data"`
}

type data struct {
	PlaybackID    *string `json:"playback_id"`
	VideoID       *string `json:"video_id"`
	OwnerID       *string `json:"owner_id"`
	ViewerKey     *string `json:"viewer_key"`
	Authenticated *bool   `json:"authenticated"`
	Kind          *string `json:"kind"`
	Seq           *int64  `json:"seq"`
	ReceivedAt    *string `json:"received_at"`
	SentAt        *string `json:"sent_at"`
	PositionMs    *int64  `json:"position_ms"`
	WatchedMs     *int64  `json:"watched_ms"`
	RebufferMs    *int64  `json:"rebuffer_ms"`
	RebufferCount *int64  `json:"rebuffer_count"`
	StartupMs     *int64  `json:"startup_ms"`
	Rendition     *string `json:"rendition"`
	BitrateKbps   *int64  `json:"bitrate_kbps"`
	ErrorCode     *string `json:"error_code"`
	Client        *string `json:"client"`
	Country       *string `json:"country"`
}

var (
	viewerKeyRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
	countryRe   = regexp.MustCompile(`^[A-Z]{2}$`)
	typeRe      = regexp.MustCompile(`^[a-z]+(\.[a-z_]+)+$`)
)

func strict(raw []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

func uid(p *string) (uuid.UUID, bool) {
	if p == nil || len(*p) != 36 {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(*p)
	return id, err == nil
}

func ts(p *string) (time.Time, bool) {
	if p == nil {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, *p)
	return t.UTC(), err == nil
}

func rng(p *int64, min, max int64) (int64, bool) {
	if p == nil || *p < min || *p > max {
		return 0, false
	}
	return *p, true
}

func optRng(p *int64, max int64) (*uint32, bool) {
	if p == nil {
		return nil, true
	}
	if *p < 0 || *p > max {
		return nil, false
	}
	v := uint32(*p)
	return &v, true
}

func optStr(p *string, max int) (*string, bool) {
	if p == nil {
		return nil, true
	}
	if len([]rune(*p)) > max {
		return nil, false
	}
	return p, true
}

// Decode validates one message payload.
func Decode(payload []byte) (Row, Result) {
	var env envelope
	if strict(payload, &env) != nil || env.EventID == nil || env.Type == nil || env.Version == nil || env.OccurredAt == nil ||
		env.Producer == nil || len(env.Data) == 0 || bytes.Equal(bytes.TrimSpace(env.Data), []byte("null")) {
		return Row{}, Malformed
	}
	eventID, ok := uid(env.EventID)
	if !ok || !typeRe.MatchString(*env.Type) || *env.Type != Type || *env.Version < 1 {
		return Row{}, Malformed
	}
	if _, ok := ts(env.OccurredAt); !ok {
		return Row{}, Malformed
	}
	if *env.Version != 1 {
		return Row{}, UnknownVersion
	}

	var d data
	if strict(env.Data, &d) != nil {
		return Row{}, Malformed
	}
	var r Row
	r.EventID = eventID
	var ok1, ok2, ok3, ok4, ok5 bool
	r.PlaybackID, ok1 = uid(d.PlaybackID)
	r.VideoID, ok2 = uid(d.VideoID)
	r.OwnerID, ok3 = uid(d.OwnerID)
	r.ReceivedAt, ok4 = ts(d.ReceivedAt)
	r.SentAt, ok5 = ts(d.SentAt)
	if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 {
		return Row{}, Malformed
	}
	if d.ViewerKey == nil || !viewerKeyRe.MatchString(*d.ViewerKey) || d.Authenticated == nil {
		return Row{}, Malformed
	}
	r.ViewerKey, r.Authenticated = *d.ViewerKey, *d.Authenticated
	if d.Kind == nil || (*d.Kind != "start" && *d.Kind != "heartbeat" && *d.Kind != "end") {
		return Row{}, Malformed
	}
	r.Kind = *d.Kind
	if d.Client == nil || (*d.Client != "web" && *d.Client != "ios" && *d.Client != "android" && *d.Client != "other") {
		return Row{}, Malformed
	}
	r.Client = *d.Client

	var good [6]bool
	var seq, pos, watched, rebuf, rcount int64
	seq, good[0] = rng(d.Seq, 0, 100000)
	pos, good[1] = rng(d.PositionMs, 0, math.MaxUint32)
	watched, good[2] = rng(d.WatchedMs, 0, 600000)
	rebuf, good[3] = rng(d.RebufferMs, 0, 600000)
	rcount, good[4] = rng(d.RebufferCount, 0, 1000)
	for _, g := range good[:5] {
		if !g {
			return Row{}, Malformed
		}
	}
	r.Seq, r.PositionMs, r.WatchedMs, r.RebufferMs, r.RebufferCount = uint32(seq), uint32(pos), uint32(watched), uint32(rebuf), uint16(rcount)

	var okS, okB, okR, okE bool
	r.StartupMs, okS = optRng(d.StartupMs, 600000)
	r.BitrateKbps, okB = optRng(d.BitrateKbps, math.MaxUint32)
	r.Rendition, okR = optStr(d.Rendition, 16)
	r.ErrorCode, okE = optStr(d.ErrorCode, 64)
	if !okS || !okB || !okR || !okE {
		return Row{}, Malformed
	}
	if d.Country != nil {
		if !countryRe.MatchString(*d.Country) {
			return Row{}, Malformed
		}
		r.Country = d.Country
	}
	return r, OK
}
