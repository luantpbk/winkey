# Kickoff — Antigravity 1 · Task U8 (player QoE / watch-time heartbeats for R1 analytics)

Starts after U7 (#124, merged). Design: ADR-022. Contract on main: `recordPlaybackHeartbeats`
(`POST /v1/playback/heartbeats`), schemas `PlaybackHeartbeatBatch` / `PlaybackSample` in
contracts/openapi/video.v1.yaml. The backend (Sonnet, R1) is in progress — build against MSW; the contract is final.
The gateway route `/v1/playback` is already live (#122).

````text
# ROLE
You are the frontend engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag1-u8 -b agent/ag1/u8-player-heartbeats origin/main
READ FIRST: docs/DECISIONS.md ADR-022 (why deltas, privacy), contracts/openapi/video.v1.yaml (recordPlaybackHeartbeats +
schemas + limits; recordView for playback_id), apps/web/src/components/video/video-player.tsx (hls.js events,
use-view-counter.ts — reuse its playback_id).
You own: apps/web, e2e/, packages/api-client. Branch: agent/ag1/u8-player-heartbeats.
First: `pnpm --filter @winkey/api-client run generate`.

# TASK U8 — build
1. A small, framework-free tracker module (lib/video/playback-tracker.ts, unit-tested with fake timers) fed by the
   player: one instance per playback, same `playback_id` as the C3 view counter.
   - `start` sample when the first frame is shown (`playing` for the first time) with `startup_ms` = first frame −
     play request.
   - `heartbeat` every 30 s while the page is visible and the video exists; `end` on `ended`, on unmount/navigation,
     on a fatal error (with `error_code` = hls.js `data.details`, max 64 chars) and on `visibilitychange` → hidden
     (send with `navigator.sendBeacon`, fallback `fetch(..., {keepalive:true})`).
   - Counters are DELTAS since the previous sample of the playback: `watched_ms` (time actually playing: `timeupdate`
     progress while not seeking/stalled, clamp each step to [0, 2 s] so a seek never counts), `rebuffer_ms` +
     `rebuffer_count` (a stall = `waiting` while playing after the first frame, until `playing` resumes; the initial
     load is NOT a stall), `seq` 0,1,2… per playback, `position_ms`, `rendition` (current level height + "p"),
     `bitrate_kbps` (level bitrate / 1000), `client: "web"`, `sent_at` = now ISO.
   - Batch: queue samples, flush at most every 30 s or when 20 are queued; one request per flush; on network error
     keep the batch and retry once on the next flush (drop after that — telemetry, never block the UI); 429 → drop and
     back off 60 s. Never send more than the contract limits (≤ 20 samples, ≤ 16 KiB).
2. Wire it into video-player.tsx (hls.js and native HLS paths). No UI change. Respect Do-Not-Track? No — not required;
   but add a `NEXT_PUBLIC_ANALYTICS_ENABLED` flag (default true) so it can be turned off.
3. MSW handler for `POST /v1/playback/heartbeats` (202 {accepted:n}; a switch to return 429).

# DEFINITION OF DONE
- Vitest (fake timers + a fake media element / event emitter): start with startup_ms; heartbeats every 30 s with correct
  deltas; a seek does not add watched_ms; a stall adds rebuffer_ms/count and the initial load does not; end on
  ended/unmount/hidden (sendBeacon called with the right JSON); batching limits; retry-once then drop; 429 back-off;
  disabled flag sends nothing.
- Playwright (MSW): play the watch page ~35 s → at least one start + one heartbeat request captured with a valid body
  (validate against the generated types).
- `pnpm --filter @winkey/web run lint && typecheck && test && build`, root `pnpm run lint && pnpm run format:check`,
  CI green; the new test files 10× in a row (paste the count; give the bash loop). Handoff Report with real outputs.

# OUT OF SCOPE
Backend (Sonnet R1), dashboards (I3), creator stats UI (after R1-b), any contract change (→ `contract-change` issue).
````
