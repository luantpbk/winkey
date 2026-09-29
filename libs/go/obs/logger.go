package obs

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"

	"go.opentelemetry.io/otel/trace"
)

// NewLogger returns a JSON logger writing one line per record with the fields
// ts, level, msg, service and (when present in the context) trace_id and
// request_id. Callers must use the *Context logging methods to get the
// context-derived fields.
func NewLogger(service, level string) *slog.Logger {
	return NewLoggerTo(os.Stdout, service, level)
}

// NewLoggerTo is NewLogger with an explicit writer.
func NewLoggerTo(w io.Writer, service, level string) *slog.Logger {
	var lv slog.Level
	if err := lv.UnmarshalText([]byte(strings.ToUpper(level))); err != nil {
		lv = slog.LevelInfo
	}
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: lv,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) > 0 {
				return a
			}
			switch a.Key {
			case slog.TimeKey:
				a.Key = "ts"
			case slog.LevelKey:
				a.Value = slog.StringValue(strings.ToLower(a.Value.String()))
			}
			return a
		},
	})
	return slog.New(&ctxHandler{Handler: h}).With("service", service)
}

// ctxHandler injects trace_id and request_id from the record's context.
type ctxHandler struct{ slog.Handler }

func (h *ctxHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()))
	}
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("request_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

func (h *ctxHandler) WithAttrs(a []slog.Attr) slog.Handler {
	return &ctxHandler{Handler: h.Handler.WithAttrs(a)}
}

func (h *ctxHandler) WithGroup(n string) slog.Handler {
	return &ctxHandler{Handler: h.Handler.WithGroup(n)}
}
