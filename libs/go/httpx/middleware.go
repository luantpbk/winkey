package httpx

import (
	"log/slog"
	"net/http"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/obs"
)

// RequestIDHeader is the header used to carry the request id.
const RequestIDHeader = "X-Request-Id"

var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// RequestID propagates a well-formed inbound X-Request-Id or generates one,
// stores it in the context (for logs) and echoes it in the response.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(RequestIDHeader)
		if !validRequestID.MatchString(id) {
			id = ids.NewString()
		}
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(obs.WithRequestID(r.Context(), id)))
	})
}

// Tracing starts a server span per request and extracts W3C trace context.
// It is a no-op cost-wise when no tracer provider is installed.
func Tracing(service string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return otelhttp.NewHandler(next, service,
			otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
				return r.Method + " " + routePattern(r)
			}))
	}
}

// Recover turns panics into a 500 problem and logs the stack.
func Recover(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil || rec == http.ErrAbortHandler {
					if rec != nil {
						panic(rec)
					}
					return
				}
				log.ErrorContext(r.Context(), "panic in handler",
					"panic", rec, "stack", string(debug.Stack()))
				Internal(w, r)
			}()
			next.ServeHTTP(w, r)
		})
	}
}

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

var (
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total", Help: "HTTP requests by method, route and status.",
	}, []string{"method", "route", "status"})
	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "http_request_duration_seconds", Help: "HTTP request latency.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "route"})
)

func routePattern(r *http.Request) string {
	if rc := chi.RouteContext(r.Context()); rc != nil {
		if p := rc.RoutePattern(); p != "" {
			return p
		}
	}
	return "unmatched"
}

// AccessLog logs one line per request (method, route, status, duration,
// bytes) and records Prometheus metrics. Query strings are not logged: they
// can carry presigned signatures. Probe and metrics paths are skipped to keep
// logs quiet.
func AccessLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			next.ServeHTTP(sw, r)
			if sw.status == 0 {
				sw.status = http.StatusOK
			}
			route := routePattern(r)
			d := time.Since(start)
			httpRequests.WithLabelValues(r.Method, route, strconv.Itoa(sw.status)).Inc()
			httpDuration.WithLabelValues(r.Method, route).Observe(d.Seconds())

			switch route {
			case "/healthz", "/readyz", "/metrics":
				return
			}
			lvl := slog.LevelInfo
			if strings.HasPrefix(route, "/internal/") { // hot, infrastructure only (nginx auth_request)
				lvl = slog.LevelDebug
			}
			if sw.status >= 500 {
				lvl = slog.LevelError
			}
			log.LogAttrs(r.Context(), lvl, "http request",
				slog.String("method", r.Method),
				slog.String("route", route),
				slog.String("path", r.URL.Path),
				slog.Int("status", sw.status),
				slog.Int("bytes", sw.bytes),
				slog.Duration("duration", d),
			)
		})
	}
}

// NewRouter returns a chi router with the standard middleware stack:
// request id → tracing → recover → access log.
func NewRouter(service string, log *slog.Logger) *chi.Mux {
	r := chi.NewRouter()
	r.Use(RequestID, Tracing(service), Recover(log), AccessLog(log))
	r.NotFound(func(w http.ResponseWriter, req *http.Request) { NotFound(w, req) })
	r.MethodNotAllowed(func(w http.ResponseWriter, req *http.Request) {
		WriteProblem(w, req, NewProblem(http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method not allowed"))
	})
	return r
}
