# Kickoff — Antigravity 4 · Task QA1 (full-stack system tests on Linux)

Antigravity 4 is the QA / system & performance engineer (Linux host with Docker). Every service has unit and
integration tests against real PostgreSQL / NATS, but **nothing runs the whole system together**. `make dev` starts
only the infrastructure; the app services in `deploy/compose/dev.yml` are commented out. The cross-service event
flows have never run end to end: upload → transcode → READY → social projection, moderation, visibility, realtime.
QA1 fills that gap before I2 puts the services on edge-1.

````text
# ROLE
You are the QA / system-test engineer on "Winkey", working on a Linux machine with Docker. The architect
(Claude Opus) reviews and merges your PRs. You TEST the system; you do not fix other agents' code.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag4-qa1 -b agent/ag4/qa1-system-tests origin/main
READ FIRST: AGENTS.md, docs/ARCHITECTURE.md, docs/DECISIONS.md (ADR-008 outbox, ADR-009 gateway identity,
ADR-016 moderation, ADR-017 media, ADR-019 revocation), contracts/openapi/*.yaml, contracts/events/README.md,
deploy/compose/dev.yml + deploy/compose/traefik/dynamic.yml (upstreams already point at auth-svc:3001,
upload-svc:3002, video-svc:3003, social-svc:3004), every service README + .env.example, the Dockerfiles
(services/*/Dockerfile, services/transcoder/Dockerfile.cpu).
You own: systest/ (new top-level directory). Branch: agent/ag4/qa1-system-tests.
Do NOT edit deploy/, Makefile, package.json, pnpm-workspace.yaml, go.work or .github/ (Antigravity 2 owns them).
Anything you need there → open an issue assigned to the owner, with the exact change.

# TASK QA1 — build
1. systest/compose.apps.yml: a compose OVERRIDE used as
     docker compose -f deploy/compose/dev.yml -f systest/compose.apps.yml up -d --build --wait
   that builds and runs auth-svc, upload-svc, video-svc, social-svc, realtime-svc and transcoder (CPU image)
   from the repo Dockerfiles. Container names must match the Traefik upstreams. Env comes from the READMEs/.env.example;
   secrets (JWT keys, COOKIE_SECRET, MEDIA_LINK_SECRET) are GENERATED at run time into a git-ignored
   systest/.run/ directory (openssl), never committed. Healthchecks on /readyz. Publish realtime on
   127.0.0.1 so tests can reach it if the dev Traefik has no /v1/realtime route (then open an issue for
   Antigravity 2).
2. systest/run.sh: bring the stack up from clean (optionally `--reset` = dev-reset first), wait, run the
   suite, on failure dump `docker compose logs` of every app container into systest/.run/logs/, always
   print a summary table (scenario, result, duration), exit non-zero on any failure. Idempotent; works twice
   in a row.
3. The suite: Node 22 with ZERO dependencies (node:test, global fetch, global WebSocket), black box through
   the gateway http://127.0.0.1:8080 (and the media endpoint the READMEs name). Test clip: generated at run
   time with the ffmpeg inside the transcoder image (lavfi testsrc + sine, 10 s, 720p). Scenarios, in order,
   each with a timeout and clear assertion messages:
   S1  every service /readyz 200.
   S2  register creator A and viewer B, login, GET /v1/auth/me; a client-sent X-User-Id / X-User-Roles is
       stripped (whoami route shows no forged identity).
   S3  A uploads the clip (create upload → multipart PUT to the presigned URLs → complete) → video goes
       PROCESSING → READY within 180 s; record upload→READY time.
   S4  realtime: A gets a ticket, subscribes to the video room, receives video.progress/video.ready (or, if the
       video is already READY, the documented behaviour).
   S5  B GETs the video: playback hls_url plain (public), master.m3u8 and one segment fetch 200 from the
       media endpoint; storyboard_url present and its .vtt fetches 200.
   S6  social: B comments, A replies, B likes, B subscribes to A; counts/listing correct; a realtime
       comment.created reaches a subscriber of the video room.
   S7  visibility: A sets PRIVATE → B gets 404 on the video AND on its comments/likes within 10 s (C4 event flow);
       A still reads both; A's playback URLs are signed (/s/{exp}/{sig}/…) with expires_at; back to PUBLIC →
       B reads again within 10 s.
   S8  moderation: make a moderator M (document how: SQL via the dev DB as the migrator role, or the admin API
       once an admin exists); B reports the video; M sees the case, hides the video, resolves the case →
       A (owner) gets 404 on comments of the hidden video, M still reads; restore.
   S9  search: the video is found by an unaccented query of its Vietnamese title (e.g. title "Hà Nội mùa thu",
       query "ha noi").
   S10 account: A changes password → A's other session gets 401 (immediately once A4 is merged; before that,
       mark the timing expectation as pending, NOT skipped silently); admin suspends B → B's token 401.
   S11 delete: A deletes the video → 404 everywhere, comments 404, media objects gone (poll the media URL ≤ 60 s
       or check Garage) .
   S12 (after V5b is merged) A uploads a subtitle track → Playback.subtitles lists it and the .vtt fetches 200.
   Every response body that has a contract is checked for the fields the scenario relies on (no full schema
   validation needed — services already do Spec.Check).
4. systest/README.md: prerequisites (Docker ≥ 24, compose v2, 8 GB RAM), how to run, what each scenario proves,
   how to add one, known gaps.

# BUGS YOU FIND
A failing scenario that is a real product bug → open a GitHub issue labeled `bug`, title
`[QA1] <service>: <symptom>`, body = steps, expected vs actual, the log excerpt, assignee = the owner agent
(AGENTS.md table). Keep the scenario in the suite (it fails until fixed) and list it in your PR. Never
weaken an assertion to get green.

# DEFINITION OF DONE
- `systest/run.sh --reset` green twice in a row on your Linux machine (or red only on scenarios with an open
  `bug` issue), total under 10 minutes; paste both summaries in the PR.
- No secrets in git (.run/ ignored via systest/.gitignore); shellcheck clean on the scripts.
- PR against main; description = Handoff Report (.github/pull_request_template.md) with the real output,
  the upload→READY time on your machine, and the list of issues you opened.
- Adding a CI job for this is a separate issue for Antigravity 2 (nightly, not per PR) — open it.

# OUT OF SCOPE
Load testing (task LT1, next), fixing product code, deploy/ changes, the web UI (Antigravity 1's e2e/ covers it).
````
