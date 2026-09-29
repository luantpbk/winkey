// Package outbox implements the transactional outbox of ADR-008.
//
// Enqueue writes the event to <schema>.outbox inside the caller's business
// transaction; a Relay per service publishes pending rows to JetStream.
// Handlers must never publish directly.
package outbox

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"

	"github.com/luantpbk/winkey/libs/go/ids"
)

// Envelope is contracts/events/envelope.schema.json.
type Envelope struct {
	EventID     string          `json:"event_id"`
	Type        string          `json:"type"`
	Version     int             `json:"version"`
	OccurredAt  time.Time       `json:"occurred_at"`
	Producer    string          `json:"producer"`
	Traceparent string          `json:"traceparent,omitempty"`
	Data        json.RawMessage `json:"data"`
}

var producer atomic.Value // string

// SetProducer sets the `producer` field of every envelope built by this
// process (e.g. "upload-svc"). Call it once at startup.
func SetProducer(name string) { producer.Store(name) }

func producerName() string {
	if s, ok := producer.Load().(string); ok && s != "" {
		return s
	}
	return "unknown"
}

var identRe = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// NotifyChannel returns the LISTEN/NOTIFY channel used to wake the relay of
// the given schema.
func NotifyChannel(schema string) string { return "outbox_" + schema }

// Enqueue builds the envelope for event (the `data` payload, marshalled as
// JSON), inserts it into <schema>.outbox using tx and schedules a NOTIFY that
// fires when tx commits. subject doubles as the envelope `type`. Version is
// always 1; bump it here when a breaking contract version is introduced.
func Enqueue(ctx context.Context, tx pgx.Tx, schema, subject string, event any) error {
	if !identRe.MatchString(schema) {
		return fmt.Errorf("outbox: invalid schema name %q", schema)
	}
	env, payload, err := BuildEnvelope(ctx, subject, event)
	if err != nil {
		return err
	}
	table := pgx.Identifier{schema, "outbox"}.Sanitize()
	if _, err := tx.Exec(ctx,
		`INSERT INTO `+table+` (event_id, subject, payload) VALUES ($1, $2, $3)`,
		env.EventID, subject, payload); err != nil {
		return fmt.Errorf("outbox: insert %s: %w", subject, err)
	}
	// NOTIFY is transactional: listeners wake up only after commit.
	if _, err := tx.Exec(ctx, `SELECT pg_notify($1, '')`, NotifyChannel(schema)); err != nil {
		return fmt.Errorf("outbox: notify: %w", err)
	}
	return nil
}

// BuildEnvelope wraps event (the `data` payload) in the contract envelope and
// returns it with its JSON encoding.
func BuildEnvelope(ctx context.Context, subject string, event any) (Envelope, []byte, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return Envelope{}, nil, fmt.Errorf("outbox: marshal %s: %w", subject, err)
	}
	env := Envelope{
		EventID:    ids.NewString(),
		Type:       subject,
		Version:    1,
		OccurredAt: time.Now().UTC(),
		Producer:   producerName(),
		Data:       data,
	}
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	env.Traceparent = carrier["traceparent"]

	payload, err := json.Marshal(env)
	if err != nil {
		return Envelope{}, nil, fmt.Errorf("outbox: marshal envelope: %w", err)
	}
	return env, payload, nil
}
