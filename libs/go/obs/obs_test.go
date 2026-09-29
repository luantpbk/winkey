package obs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel/trace"
)

func TestLoggerFields(t *testing.T) {
	var buf bytes.Buffer
	lg := NewLoggerTo(&buf, "upload", "info")

	tid, _ := trace.TraceIDFromHex("0123456789abcdef0123456789abcdef")
	sid, _ := trace.SpanIDFromHex("0123456789abcdef")
	ctx := trace.ContextWithSpanContext(context.Background(),
		trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid, TraceFlags: trace.FlagsSampled}))
	ctx = WithRequestID(ctx, "req-1")

	lg.InfoContext(ctx, "hello", "k", "v")
	lg.DebugContext(ctx, "dropped")

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("not one json line: %v: %s", err, buf.String())
	}
	want := map[string]string{
		"level": "info", "msg": "hello", "service": "upload", "k": "v",
		"trace_id": "0123456789abcdef0123456789abcdef", "request_id": "req-1",
	}
	for k, v := range want {
		if rec[k] != v {
			t.Errorf("%s = %v, want %v", k, rec[k], v)
		}
	}
	if _, ok := rec["ts"]; !ok {
		t.Error("missing ts")
	}
	if bytes.Count(buf.Bytes(), []byte("\n")) != 1 {
		t.Error("debug record should have been dropped")
	}
}

func TestHealthEndpoints(t *testing.T) {
	h := NewHealth()
	r := chi.NewRouter()
	h.Mount(r)

	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		return w
	}
	if w := get("/healthz"); w.Code != 200 {
		t.Fatalf("healthz %d", w.Code)
	}
	if w := get("/readyz"); w.Code != 200 {
		t.Fatalf("readyz without checks %d", w.Code)
	}
	fail := true
	h.AddCheck("db", func(context.Context) error {
		if fail {
			return errors.New("postgres://user:secret@host down")
		}
		return nil
	})
	w := get("/readyz")
	if w.Code != 503 {
		t.Fatalf("readyz %d", w.Code)
	}
	if bytes.Contains(w.Body.Bytes(), []byte("secret")) {
		t.Fatal("readyz leaks error text")
	}
	fail = false
	if w := get("/readyz"); w.Code != 200 {
		t.Fatalf("readyz %d", w.Code)
	}
	if w := get("/metrics"); w.Code != 200 {
		t.Fatalf("metrics %d", w.Code)
	}
}

func TestSetupTracingNoop(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	sd, err := SetupTracing(context.Background(), "x")
	if err != nil {
		t.Fatal(err)
	}
	if err := sd(context.Background()); err != nil {
		t.Fatal(err)
	}
}
