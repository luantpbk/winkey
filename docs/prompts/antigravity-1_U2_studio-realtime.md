# Kickoff — Antigravity 1 · Task U2 (Creator Studio realtime + live comments/likes)

Starts after U3 (#69, merged). realtime-gw (C2, #57) and its contract are on main.

````text
# ROLE
You are the Frontend engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag1-u2 -b agent/ag1/u2-studio-realtime origin/main
READ FIRST: contracts/realtime/README.md (ticket flow, rooms, messages, heartbeat, close codes, reconnect rules),
contracts/realtime/client.schema.json + server.schema.json + examples/, contracts/openapi/realtime.v1.yaml
(createRealtimeTicket, openRealtime), apps/web studio/upload pages (today they POLL status every few seconds),
the U3 social components, packages/api-client (createRealtimeClient + generated types).
You own: apps/web, e2e/, packages/api-client. Branch: agent/ag1/u2-studio-realtime.

# TASK U2 — one shared realtime client in the web app, then use it in three places
1. `RealtimeProvider` (one WebSocket per tab, created lazily when a component subscribes):
   - signed in: POST /v1/realtime/ticket, then wss://<host>/v1/realtime?ticket=…; anonymous: no ticket.
     A NEW ticket for every (re)connect (single use, 30 s). Never log or store the ticket.
   - reconnect with exponential backoff + jitter 1 s → 30 s max; after reconnect re-subscribe every room
     and let each consumer refetch its REST state (the contract says events can be missed).
   - honour close codes: 1001 → reconnect; 4401 → drop auth and reconnect anonymous; 4429 → back off to the
     max delay; 4400 → log a bug (client sent bad frames) and back off.
   - answer nothing to server pings (the browser does it); send `ping` only if you need liveness in the UI.
   - validate every server frame against server.schema.json (ajv, compiled once); drop invalid frames.
   - hook API: useRealtimeRoom(room, onEvent) with ref-counted subscribe/unsubscribe (two components on the
     same room → one subscribe frame; last unmount → unsubscribe). Respect the 50 rooms limit.
   - sign-in/out: reconnect so the connection identity matches the session.
2. Studio (/studio) and upload page: replace polling with `upload:{video_id}` rooms for videos in
   UPLOADED/PROCESSING: `video.progress` → progress bar (stage + percent), `video.ready` / `video.failed` →
   update the row (failed shows reason/message, retryable). Keep ONE slow fallback poll (e.g. 30 s) only while
   the socket is disconnected. `user:{me}` `video.ready` → toast "Video X is ready" anywhere in the app.
3. Watch page: `video:{id}` room — `like.count` updates the like counter (do not fight an in-flight optimistic
   toggle of the same user); `comment.created` → show a "N new comments" pill that refetches the first page on
   click (never inject the body: events carry ids only). `user:{me}` `comment.reply` → toast with a link.

# DEFINITION OF DONE
- Unit tests with a mock WebSocket server (e.g. `mock-socket` or `ws` in vitest): ticket per connect,
  backoff sequence + jitter bounds, re-subscribe after reconnect, ref-counted rooms, close-code handling,
  invalid frames dropped, anonymous vs signed-in, studio progress/ready/failed rendering, like.count vs
  optimistic toggle, new-comments pill.
- Playwright (MSW or a small ws mock): studio shows progress then READY without page reload.
- No new polling loops while connected (assert in a test). No ticket in logs, URLs of analytics, or storage.
- Before pushing, at the repo root: pnpm run format:check && pnpm run lint:root && pnpm run lint &&
  pnpm run typecheck && pnpm run test && pnpm run build. PR description = Handoff Report with real output.

# OUT OF SCOPE
- Changing contracts/realtime or realtime-gw (open a contract-change issue if something is missing).
- Admin/moderation UI (U4, after A2 and S4).
````
