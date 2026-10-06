# Cloudflare R2 Usage & Cost Exporter (ADR-032 / INF-R2b)

Prometheus exporter for Cloudflare R2 storage usage, operation counts, and projected month-end cost tracking. Queries the Cloudflare GraphQL Analytics API every 15 minutes.

## Features

- **Storage Metrics**: Reports current payload size in bytes (`r2_storage_bytes`) and object counts (`r2_storage_objects`) per bucket.
- **Operation Counts**: Month-to-date (MTD) counter for Class A (`PutObject`, `ListObjects`, multipart upload operations, etc.) and Class B (`GetObject`, `HeadObject`) requests (`r2_operations_mtd_total`).
- **Cost Projections**: Month-end projected cost in USD (`r2_cost_projected_usd`, `r2_cost_projected_storage_usd`, `r2_cost_projected_class_a_usd`, `r2_cost_projected_class_b_usd`) extrapolated linearly based on days elapsed in the billing cycle.
- **Free-Tier Quota Tracking**: Free-tier quota utilization ratio (`r2_free_tier_quota_used_ratio` for `storage`, `class_a`, `class_b`).
- **Zero External Dependencies**: Pure Python standard library (`urllib.request`, `http.server`, `json`, `calendar`, `threading`). Multi-arch compatible (`linux/amd64`, `linux/arm64`).

## Pricing Model & Limits

| Resource | Free Tier (Monthly) | Beyond Free Tier (USD) |
|---|---|---|
| Storage | 10 GB-month | $0.015 per GB-month |
| Class A operations | 1,000,000 requests | $4.50 per 1,000,000 requests |
| Class B operations | 10,000,000 requests | $0.36 per 1,000,000 requests |

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `2588dff2e56bf889918bc5c7af53ad86` | Cloudflare account tag / ID |
| `CLOUDFLARE_API_TOKEN` | *(required)* | Cloudflare API Token with `Account -> Analytics -> Read` permission |
| `EXPORTER_PORT` | `9095` | Port the HTTP exporter listens on |
| `EXPORTER_HOST` | `0.0.0.0` | Host address to bind HTTP listener |
| `SCRAPE_INTERVAL_SECONDS` | `900` | Polling interval for Cloudflare GraphQL API (default: 15 minutes) |
| `R2_BUCKETS` | `winkey-raw,winkey-media,winkey-pg-backup,winkey-backup` | Comma-separated list of buckets to monitor |

## Security

Per ADR-032 and cluster rules:
- **Never commit API tokens to git.**
- Tokens must be configured via `setup_r2_usage.sh` using `read -rs` into a Kubernetes Secret (`r2-usage-secrets` in `observability` namespace).
- The token only requires read-only permission: **Account -> Analytics -> Read**.

## Deployment

### Kubernetes (edge-1)

Deployed in the `observability` namespace on `edge-1` (single source of truth):
```bash
# 1. Configure secret interactively (never stored in git)
bash deploy/r2-usage/setup_r2_usage.sh

# 2. Apply manifests
kubectl apply -k deploy/k8s/observability/
```
The Deployment includes Prometheus scrape annotations (`prometheus.io/scrape: 'true'`, `prometheus.io/port: '9095'`), enabling automatic discovery by `vmagent`.

Security context:
- Runs as non-root (`runAsNonRoot: true`, user `65534`).
- Read-only root filesystem (`readOnlyRootFilesystem: true`).
- Dropped all capabilities (`drop: [ALL]`).
- Pinned multi-arch base image (`python:3.12-alpine@sha256:...`).
- Non-optional `r2-usage-secrets` Secret reference (exporter terminates non-zero without token).

## Endpoints

- `GET /metrics` - Prometheus metrics output
- `GET /healthz` - Health probe (`{"status":"ok"}`)
- `GET /readyz` - Readiness probe (`{"status":"ok"}`)

## Testing & Verification

Run a one-shot query directly to inspect metrics without starting the server:
```bash
python3 deploy/k8s/observability/scripts/r2_usage_exporter.py --once
```

Scrape active server:
```bash
curl -s http://localhost:9095/metrics
```
