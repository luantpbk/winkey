# Kickoff — Antigravity 3 · Task OBS-N (Prometheus `/metrics` for the Node services)

Starts after A5 (#108, merged). The Go services already serve `/metrics` (Prometheus, `libs/go/obs`), as
docs/ARCHITECTURE.md §"Trace/Metric" requires. The Node services (auth, social, realtime) only create OpenTelemetry
counters with no SDK/exporter, so in production they are no-ops, and `src/` carries in-memory "test counters"
(`recordRevocationMetric`, …). OBS-N gives them real metrics before I3 (VictoriaMetrics + Grafana) scrapes them.

````text
# ROLE
You are the Node product-services engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-obs -b agent/ag3/obs-n-node-metrics origin/main
READ FIRST: docs/ARCHITECTURE.md (observability row), libs/go/obs (health.go + the HTTP metrics in libs/go/httpx —
copy their metric names/labels so Go and Node dashboards match), services/{auth,social,realtime}/src (every
`metrics.getMeter`, `createCounter`, `recordRevocationMetric`, `getRevocationMetricCount`, in-memory counters).
You own: services/auth, services/social, services/realtime, packages/* (new package allowed).
Branch: agent/ag3/obs-n-node-metrics.

# TASK OBS-N — build
1. packages/metrics (`@winkey/metrics`, ESM, strict TS, prom-client as its only runtime dependency):
   - `createRegistry(service)`: a prom-client Registry with default Node metrics (prefix none) and a default label
     `service`.
   - a Fastify plugin that records `http_requests_total{method,route,status}` and
     `http_request_duration_seconds{method,route,status}` (histogram, same buckets as libs/go/httpx) using the
     ROUTE PATTERN (`/v1/videos/:id`), never the raw URL (cardinality); skips /healthz, /readyz, /metrics.
   - `GET /metrics` handler (text exposition format).
   - unit tests (route pattern used, health routes skipped, exposition parses).
2. auth, social, realtime: register the plugin + `/metrics` on the service port. Convert EVERY existing OTel counter to
   a prom-client counter on that registry with the SAME name and labels (e.g. `auth_revocation_write_total{result}`,
   `auth_verify_revocation_check_total{result}`, `realtime_revoked_closes_total`,
   `realtime_revocation_sweep_errors_total`). Delete the in-memory test counters and their helpers from `src/`;
   tests read values from the registry (`await registry.getSingleMetricAsString(...)` or `.get()`).
   Remove `@opentelemetry/api` where it is no longer used.
3. `/metrics` must NOT be public: check deploy/compose/traefik/dynamic.yml and deploy/k8s (IngressRoutes) and the
   nginx vhosts — if any public route would reach `/metrics`, open an issue for Antigravity 2 with the exact rule
   (do not edit deploy/). Add a line to each service README (endpoint, not public, metric list).
4. `test:prod-deps` must still pass for all three services (prom-client in `dependencies`).

# DEFINITION OF DONE
- `pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build` + root `pnpm run lint && pnpm run
  format:check` green; integration tests unchanged in count (0 skipped with WINKEY_REQUIRE_DOCKER=1).
- Real output pasted: `curl -s localhost:<port>/metrics | grep -E '^(http_requests_total|auth_|realtime_)' | head`
  for each service after a few requests.
- PR against main; description = Handoff Report.

# OUT OF SCOPE
Tracing/OTLP export, VictoriaMetrics/Grafana/alerts (I3, Antigravity 2), Go services, contracts, migrations.
````
