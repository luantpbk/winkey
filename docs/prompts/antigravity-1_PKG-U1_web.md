# Kickoff — Antigravity 1 · Tasks PKG + U1 (web app shell)

````text
# ROLE
You are the Frontend Engineer of "Winkey", a YouTube-like platform built by a team of AI agents. Use your browser
agent to verify every screen visually. The architect (Claude Opus) reviews your PRs.

# REPO
git clone https://github.com/luantpbk/winkey && cd winkey
READ FIRST: AGENTS.md, docs/ARCHITECTURE.md (§3 flows), contracts/openapi/*.yaml (auth, upload, video, common).
You own: apps/web/, packages/api-client/, e2e/. Branches: agent/ag1/pkg-api-client, then agent/ag1/u1-web-shell.

# PKG — packages/api-client
Generate types with openapi-typescript from contracts/openapi/*.v1.yaml and export typed openapi-fetch clients.
Add a `generate` script and a CI check that fails when the generated output is stale.

# TASK U1 — apps/web
Stack: the latest stable Next.js (App Router, RSC), React, TypeScript strict, Tailwind CSS v4, TanStack Query for
client data, next-intl (vi default, en), and hls.js (the player itself is task PL1 — for now just render the poster
plus a basic <video> via hls.js / native HLS on Safari).
Backend availability: the APIs are not built yet. Use MSW (Mock Service Worker) handlers with typed fixtures from
packages/api-client, enabled with NEXT_PUBLIC_API_MOCKS=1, so the app works with no backend. The real API is the
same origin under /v1/* (Traefik in dev on http://localhost:8080 proxies to Next on :3000).

Routes:
- /                 Home: responsive grid of VideoSummary cards, infinite scroll via next_cursor, skeletons.
- /watch/[id]       SSR metadata (title, owner, views, description) plus the player area with the poster.
                    404 page for non-visible videos. Open Graph tags.
- /c/[handle]       Channel page: profile header + the owner's videos. (Do NOT use /@handle — "@" folders are
                    parallel routes in Next.js.)
- /login, /register Forms matching the auth.v1 schemas, mapping Problem.errors to fields, plus a "Continue with
                    Google" button linking to /v1/auth/oauth/google?return_to=…
- /upload           Creator upload (requires the creator role):
                    • POST /v1/uploads, then presign in batches of ≤ 100 parts;
                    • PUT at most 4 parts in parallel straight to the presigned URL, with retry and exponential
                      backoff per part; read the ETag response header of each part;
                    • then POST complete;
                    • show overall progress, speed and ETA;
                    • resume after a reload: persist {video_id, part_size, completed parts + etags} in IndexedDB,
                      keyed by a file fingerprint (name + size + lastModified);
                    • cancel = DELETE /v1/uploads/{id}.
- /studio           The caller's videos (GET /v1/studio/videos) with a status badge and a progress bar. Poll
                    GET /v1/uploads/{id} every 5s while UPLOADED/PROCESSING (realtime replaces this in P2).
Auth handling: keep the access token in memory only (never localStorage). On app load call POST /v1/auth/refresh to
restore the session. On a 401, refresh once and retry. Logout calls POST /v1/auth/logout.
UI: dark theme by default plus a light toggle, a YouTube-like layout (top bar with search placeholder and a
collapsible side nav), fully responsive from 360 px, keyboard accessible, Lighthouse ≥ 90 for performance and
accessibility on / and /watch.

# DEFINITION OF DONE
- Unit/component tests (vitest + Testing Library) for the uploader state machine (resume, retry, cancel) and the auth
  refresh flow.
- Playwright tests in e2e/ against MSW mocks: browse home → open watch; register → upload a small file → it appears
  in the studio.
- Screenshots at 375 / 768 / 1440 px for each route, attached to the PR.
- Docker image (multi-arch, standalone output, non-root).
- AGENTS.md DoD + the Handoff Report PR description.
````
