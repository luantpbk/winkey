# Media Cache Warmer (`media-cache-warmer`)

A Kubernetes CronJob that pre-warms the Nginx edge media cache (`proxy_cache winkey_media`) on `edge-1` to guarantee instant video playback starts (< 0.4s TTFB) and eliminate rebuffer / stuttering caused by cold cache misses.

---

## 1. Overview & Strategy

When a user watches a video segment that has not been cached on `edge-1` (`X-Cache-Status: MISS`), the segment must be fetched across multiple network hops:
$$\text{Client (VN)} \longleftrightarrow \text{Nginx (Singapore)} \longleftrightarrow \text{media-origin} \longleftrightarrow \text{Cloudflare R2}$$
This results in an average TTFB of $\sim$1.09s–1.28s, leaving less than 1s of buffer headroom for 4s HLS segments. Conversely, on a **Cache HIT**, TTFB drops to **0.28s** with 20 Mbps download speed.

`media-cache-warmer` runs every 15 minutes to pre-populate Nginx disk cache with the essential portions of media:

1. **Start of every new video (published in the last 24h)**:
   - Master playlist (`master.m3u8`) and all variant playlists (`1080p`, `720p`, `480p`, `audio`, and AV1 if present).
   - Init segments (`init_0.mp4`) for all video and audio renditions.
   - **First 15 segments** (`seg_00000.m4s` to `seg_00014.m4s`, $\sim$60s of playback) for every rendition.
2. **Full coverage for HOT videos (Top 20 trending / most viewed over 7 days)**:
   - Full rendition of **`720p`** + default audio stream.
3. **Stateless Idempotency (ConfigMap-free)**:
   - Before warming, the job sends an HTTP `HEAD` request to `seg_00000.m4s` of the video.
   - If the response header carries `X-Cache-Status: HIT`, the video start is already cached $\rightarrow$ **SKIPPED immediately**.
4. **QoS and Resource Protections**:
   - **Concurrency**: $\le 4$ simultaneous stream downloads.
   - **Rate Limiting**: $\le 5\text{ MB/s}$ (`--limit-rate 5M`) to never compete with real user streaming traffic.
   - **Disk Guard**: Checks `/nginx-cache` volume before warming each video. If cache disk usage exceeds **80% of max_size (32 GB / 40 GB)**, the job halts immediately to protect production disk space.

---

## 2. Configuration (Environment Variables)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MEDIA_BASE_URL` | `https://media.winkey.vn` | Media gateway URL through Nginx host |
| `API_BASE_URL` | `https://winkey.vn` | Video metadata and playback API |
| `CACHE_DIR` | `/nginx-cache` | Mount path of Nginx host media cache |
| `MAX_CACHE_BYTES` | `42949672960` (40GB) | Maximum cache size configured in Nginx (`max_size=40g`) |
| `MAX_CONCURRENCY` | `4` | Maximum parallel downloads ($\le 4$) |
| `RATE_LIMIT_BPS` | `5242880` (5 MB/s) | Bandwidth ceiling for warmer transfers |
| `WARM_SEGMENTS_COUNT` | `15` | Number of initial segments to warm ($\sim$60s) |
| `HOT_VIDEOS_LIMIT` | `20` | Maximum number of top trending videos to fully warm |
| `NEW_VIDEOS_HOURS` | `24` | Cutoff age in hours for candidate new videos |
| `MEDIA_LINK_SECRET` | *(empty)* | Optional HMAC secret for signed media paths (ADR-017) |

---

## 3. Kubernetes Deployment

The CronJob is managed via Kustomize in `deploy/k8s/apps/media-cache-warmer/`:
- `cronjob.yaml`: Defines the batch/v1 CronJob (`schedule: "*/15 * * * *"`).
- `kustomization.yaml`: Embeds `warmer.mjs` into a ConfigMap via `configMapGenerator`.
- Volume `nginx-cache`: Mounts hostPath `/var/lib/rancher/k3s/storage/nginx-cache/winkey-media` (read-only) for disk usage tracking.

### Manual / One-Shot Trigger
To trigger an immediate warm job on production:
```bash
kubectl create job --from=cronjob/media-cache-warmer media-cache-warmer-manual-$(date +%s)
kubectl logs -f job/media-cache-warmer-manual-$(date +%s)
```
