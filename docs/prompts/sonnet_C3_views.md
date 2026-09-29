# Kickoff — Sonnet 5.5 · Task C3 (view counter)

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-c3 -b agent/sonnet/c3-views origin/main
READ FIRST: AGENTS.md, contracts/openapi/video.v1.yaml (operation recordView and its description),
services/video (S1, S2 — reuse its visibility rules, cache, Valkey client, testkit).
You own: services/video, libs/go. No migration is needed (media.videos.view_count exists).

# TASK C3 — POST /v1/videos/{video_id}/views in video-svc (implement the contract exactly)
- Optional auth (X-User-Id / X-User-Roles). The video must be readable by the caller and READY
  (reuse the GET /v1/videos/{id} visibility logic) → otherwise 404.
- Validate the body (playback_id uuid, watched_ms 0..86_400_000) → 400 problem+json.
- Threshold: watched_ms >= min(30_000, duration_ms / 2), else 202 {counted:false}.
- Viewer = user id, or sha256(client_ip + user_agent) for anonymous. client_ip honours X-Forwarded-For
  only from TRUST_PROXY_CIDRS (add the env var if video-svc does not have it yet; same semantics as auth-svc).
- Dedup (Valkey): views:seen:{video_id}:{viewer} SET NX EX 1800, and views:pb:{playback_id} SET NX EX 1800
  so retries of one playback never count twice. Counted → HINCRBY views:pending {video_id} 1.
- Rate limit: 60 reports/min per client IP → 429 with Retry-After.
- Flusher (one goroutine per replica, safe with several replicas): every VIEW_FLUSH_INTERVAL (default 30 s)
  atomically move the pending hash to a unique key (RENAME views:pending → views:flush:{uuid}, ignore
  "no such key"), then in ONE transaction
  UPDATE media.videos v SET view_count = v.view_count + d.n FROM unnest($1::uuid[], $2::bigint[]) d(id, n)
  WHERE v.id = d.id; on success DEL the flush key; on failure keep it and retry it on the next tick
  (also pick up leftover views:flush:* keys at startup, e.g. after a crash). Deleted videos simply match no row.
  Do not bump updated_at. Invalidate the video cache entries that changed (or rely on CACHE_TTL; say which).
- Valkey unavailable: the endpoint answers 202 {counted:false} (fail open, never 5xx), and a metric counts it.
- Metrics: video_views_total{result=counted|duplicate|below_threshold|rate_limited|valkey_down},
  video_view_flush_seconds, video_view_flush_errors_total.

# DEFINITION OF DONE
- Real PostgreSQL 17 + Valkey via testcontainers/testkit (WINKEY_REQUIRE_DOCKER=1 fails, never skips):
  • threshold (short and long videos), PRIVATE/non-READY → 404, owner can count on own PRIVATE video? → follow
    the GET visibility rules (owner reads it, so yes);
  • dedup per viewer (30 min, use a short TTL via env in tests) and per playback_id; anonymous viewers with
    different IP or user agent count separately; X-Forwarded-For ignored from untrusted peers;
  • rate limit 429;
  • flusher: N concurrent reports → view_count += N exactly once, two flushers in parallel never double count,
    a failed flush (stop PostgreSQL or inject an error) loses nothing and is applied on the next tick,
    leftover views:flush:* picked up at start;
  • Valkey down → 202 counted:false, no 5xx;
  • contract test: 202/400/404/429 bodies match video.v1.yaml.
- go vet, go test -race, arm64 build pass; README section "View counter" (rules, env table, metrics).
- PR description = Handoff Report with the test output pasted.

# OUT OF SCOPE
- Web player calling the endpoint (Antigravity 1, PL1). Analytics pipeline (R1). Any contract change
  (open a contract-change issue).
````
