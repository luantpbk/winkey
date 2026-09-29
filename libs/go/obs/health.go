package obs

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// CheckFunc reports whether one dependency is usable.
type CheckFunc func(ctx context.Context) error

// Health serves /healthz (liveness) and /readyz (dependencies reachable).
type Health struct {
	mu      sync.RWMutex
	names   []string
	checks  map[string]CheckFunc
	timeout time.Duration
}

// NewHealth returns an empty Health. With no checks /readyz always succeeds.
func NewHealth() *Health {
	return &Health{checks: map[string]CheckFunc{}, timeout: 2 * time.Second}
}

// AddCheck registers a named readiness check (e.g. "postgres", "nats", "s3").
func (h *Health) AddCheck(name string, fn CheckFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.checks[name]; !ok {
		h.names = append(h.names, name)
	}
	h.checks[name] = fn
}

// Healthz is the liveness handler: it never touches dependencies.
func (h *Health) Healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// Readyz is the readiness handler. Failing check names are reported, error
// texts are not (they may contain connection strings).
func (h *Health) Readyz(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	names := append([]string(nil), h.names...)
	checks := make(map[string]CheckFunc, len(h.checks))
	for k, v := range h.checks {
		checks[k] = v
	}
	h.mu.RUnlock()

	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()

	results := make(map[string]string, len(names))
	ok := true
	for _, n := range names {
		if err := checks[n](ctx); err != nil {
			results[n] = "fail"
			ok = false
		} else {
			results[n] = "ok"
		}
	}
	status, word := http.StatusOK, "ok"
	if !ok {
		status, word = http.StatusServiceUnavailable, "unavailable"
	}
	writeJSON(w, status, map[string]any{"status": word, "checks": results})
}

// Router is the subset of chi.Router that Mount needs.
type Router interface {
	Get(pattern string, handlerFn http.HandlerFunc)
}

// Mount registers /healthz, /readyz and /metrics on r.
func (h *Health) Mount(r Router) {
	r.Get("/healthz", h.Healthz)
	r.Get("/readyz", h.Readyz)
	r.Get("/metrics", MetricsHandler().ServeHTTP)
}

// MetricsHandler serves the default Prometheus registry.
func MetricsHandler() http.Handler { return promhttp.Handler() }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
