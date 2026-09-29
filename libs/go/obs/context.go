// Package obs provides logging, tracing, metrics and health-check helpers
// shared by every Go service.
package obs

import "context"

type ctxKey int

const requestIDKey ctxKey = iota

// WithRequestID returns a context carrying the request id; the JSON logger
// adds it to every record logged with that context.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// RequestID returns the request id stored by WithRequestID, or "".
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}
