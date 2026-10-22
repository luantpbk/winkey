# Media Cache Warmer (`media-cache-warmer`)

A Kubernetes CronJob that pre-warms the Nginx edge media cache (`proxy_cache winkey_media`) on `edge-1` to guarantee instant video playback starts (< 0.4s TTFB) and eliminate rebuffer / stuttering caused by cold cache misses.

---

## 1. Overview & Strategy

When a user watches a video segment that has not been cached on `edge-1` (`X-Cache-Status: MISS`), the segment must be fetched across multiple network hops:
$$\text{Client (VN)} \longleftrightarrow \text{Nginx (Singapore)} \longleftrightarrow \text{media-origin} \longleftrightarrow \text{Cloudflare R2}$$
This results in an average TTFB of $\sim$1.09s–1.28s, leaving less than 1s of buffer headroom for 4s HLS segments. Conversely, on a **Cache HIT**, TTFB drops to **0.28s** with 20 Mbps download speed.

`media-cache-warmer` runs every 15 minutes to pre-populate Nginx disk cache with the essential portions of media:

1. **Catalogue sweep of newest 50 public videos (regardless of age)**:
   - Master playlist (`master.m3u8`) and all variant playlists (`1080p`, `720p`, `480p`, `audio`, and AV1 if present).
   - Init segments (`init_0.mp4`) for all video and audio renditions.
   - **First 15 segments** (`seg_00000.m4s` to `seg_00014.m4s`, $\sim$60s of playback) for every rendition.
2. **Full coverage for Top Trending videos**:
   - Full rendition of **`720p`** + default audio stream for the top `HOT_FULL_LIMIT=5` trending videos, sourced exclusively from the **H.264** master.
   - Other trending videos get start-only warming.
3. **Stateless Idempotency (ConfigMap-free)**:
   - For **hot-full** videos: derives the test segment from the **LAST** segment of the H.264 720p playlist (ensures full-720p warming runs even when viewers have already fetched the start).
   - For **start-only** videos: derives the test segment from the **FIRST** segment of the first video variant.
   - Sends an HTTP `GET` request (matching the edge cache key `"$scheme$request_method$host$uri"`).
   - If the response header carries `X-Cache-Status: HIT`, the required assets are already cached $\rightarrow$ **SKIPPED immediately**.
4. **QoS and Resource Protections**:
   - **Concurrency**: $\le 4$ simultaneous stream downloads.
   - **Global Rate Limiting**: Shared token bucket across all workers capping total throughput at $\le 5\text{ MB/s}$ (`RATE_LIMIT_BPS=5242880`), preventing edge network saturation.
   - **Run Budget**: `WARM_MAX_BYTES_PER_RUN` (default 3 GiB). Halts downloading once reached to avoid runaway consumption.
   - **Pod Hardening**: `runAsNonRoot: true`, `runAsUser: 1000`, `readOnlyRootFilesystem: true`, `seccompProfile: RuntimeDefault`, `restartPolicy: Never`, `backoffLimit: 0`, exact image `node:22.14.0-alpine`.

---

## 2. Configuration (Environment Variables)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MEDIA_BASE_URL` | `https://media.winkey.vn` | Media gateway URL through Nginx host |
| `API_BASE_URL` | `https://winkey.vn` | Video metadata and playback API |
| `MAX_CONCURRENCY` | `4` | Maximum parallel downloads ($\le 4$) |
| `RATE_LIMIT_BPS` | `5242880` (5 MB/s) | Global token bucket bandwidth ceiling across all workers |
| `WARM_SEGMENTS_COUNT` | `15` | Number of initial segments to warm ($\sim$60s) |
| `WARM_MAX_BYTES_PER_RUN` | `3221225472` (3 GiB) | Maximum bytes transferred per cronjob execution |
| `HOT_FULL_LIMIT` | `5` | Top trending videos eligible for full 720p H.264 warming |
| `HOT_VIDEOS_LIMIT` | `20` | Trending candidate videos evaluated |
| `NEW_VIDEOS_HOURS` | `24` | Cutoff age in hours for candidate new videos |

---

## 3. Kubernetes Deployment

The CronJob is managed via Kustomize in `deploy/k8s/apps/media-cache-warmer/`:
- `cronjob.yaml`: Defines the batch/v1 CronJob (`schedule: "*/15 * * * *"`).
- `kustomization.yaml`: Embeds `warmer.mjs` into a ConfigMap via `configMapGenerator`.

### Manual / One-Shot Trigger
To trigger an immediate warm job on production:
```bash
kubectl create job --from=cronjob/media-cache-warmer media-cache-warmer-manual-$(date +%s)
kubectl logs -f job/media-cache-warmer-manual-$(date +%s)
```
