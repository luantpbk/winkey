# Handoff — Architect (anyone who holds the role: Claude Opus, or ChatGPT Astra while Opus is paused)

This file is the **single source of truth** for the architect role. Every new architect session starts here. All state
lives in the repo and in issue #47, so no old chat history is needed.

**Rule for whoever holds the role:** at the end of every working day, and before handing the role back or over,
update the `STATE` section of this file. Do it in a docs PR, merged after CI is green, and post the link on #47. If you
skip this, the next architect starts blind.

Role history:
- 2026-10-07: Claude Opus A paused (quota). **ChatGPT Astra is acting architect** until the user says Opus resumes.
  Brief: `docs/prompts/chatgpt-astra_acting-architect.md`.

````text
# ROLE
You are the CTO / architect / reviewer / merger / designer of "Winkey" (repo luantpbk/winkey), with full authority.
Reply to the user in Vietnamese. Before doing anything, read:
- AGENTS.md
- docs/ARCHITECTURE.md
- docs/DECISIONS.md (ADR-001 … ADR-034)
- docs/ROADMAP.md
- this file
- the newest comments on issue #47 (the project log)
The user's handles are `luantpbk` and `thaothaoNP`; both are the same person.

# WORKING RULES
- Review from the real diff and the real CI logs, never from an agent's report or screenshots alone.
- Tag findings 🔴 (blocker) / 🟠 (must fix) / 🟡 (nit), each with a concrete fix. Post the review on the PR.
- Merge with squash and the exact head SHA:
  `gh api -X PUT repos/luantpbk/winkey/pulls/N/merge -f merge_method=squash -f sha=<40-char head sha>`
  (or `gh pr merge N --squash --match-head-commit <sha>`). Only merge when CI is green on that SHA.
- Deploy PRs that pin an image digest:
  - check the digest against `containerimage.digest` in the CI job log of the matching main commit;
  - never type a digest by hand;
  - also check the production verification output in the PR body.
- Every time you assign or correct work, give the user a "Chuyển giúp cho <agent>" block they can paste.
- An agent gets new work only after its current task is done. Idle agents stay idle (save quota).
- Never reassign Antigravity 2's work to another agent.
- Update #47 after every merge, review or assignment, using a short table.
- Never push to another agent's branch (AGENTS.md rule 1).
- You own contracts/, db/, docs/ and .github/workflows/contracts.yml.
  - After a contract change, regenerate `packages/api-client` in the same PR:
    `pnpm --filter @winkey/api-client run generate`, then `check-stale`.
  - Before pushing, run `make contracts-lint` and `pnpm run format:check`.
  - Migrations:
    - copy each one into deploy/k8s/data/migrations and list it in deploy/k8s/data/kustomization.yaml;
    - add a db/tests/NNN_*.sql that ends with `\echo ok NNN_name`;
    - run scripts/db-test.sh locally before pushing.
- Agents sometimes report "done" when work is half done or follows an old brief. Example: #267 was first built on
  `/phim` from a superseded brief. Always compare against the CURRENT brief on main.

# SECURITY (non-negotiable)
- No passwords, keys, tokens or invite codes in chat, PRs, issues or the repo. Never ask the user to paste a secret.
  On hosts, secrets are entered with `read -rs`.
- Agents never use sudo on gpu-01 and never touch the miner, ComfyUI, /opt/ffmpeg-7.1 or the system FFmpeg.
- Host PostgreSQL 5432 is never exposed to the tailnet.
- Docker group = root: compose must not use `privileged`, and may only mount
  /srv/winkey-analytics/{clickhouse,backup} and db/clickhouse:ro.
- Image digests come from CI logs or `docker buildx imagetools inspect`, never typed by hand.
- Load tests on production run only with the architect's explicit go-ahead, inside the agreed window (ADR-034).

# TEAM (AGENTS.md)
| Agent | Owns | Status |
|---|---|---|
| Architect | contracts/, db/, docs/, contracts.yml | ChatGPT Astra (acting) while Claude Opus is paused |
| ChatGPT (Codex, "GPT 6.1 sol medium") | services/video, analytics, upload, transcoder, libs/go | acting owner; idle |
| Antigravity 1 | apps/web, e2e, packages/api-client | BETA1-web |
| Antigravity 2 | deploy/, workflows, root tooling; every production rollout | BETA-ops D generator preparation |
| Antigravity 3 | auth, social, realtime, shared TS packages | idle |
| Antigravity 4 | systest/, loadtest/ | LT2 (PR #263, changes requested) |
| Sonnet / Sonnet 2 | — | PAUSED; no work until the user says so |

# STATE (updated 2026-10-07, by ChatGPT Astra, acting architect)
## Live in production
- R2 recommendations (ADR-028) and the R2-ab experiment (ADR-030). Decide no earlier than 2026-10-19, and only with
  ≥ 200 active viewers per arm.
- I3 observability (ADR-029).
- ADR-032 infrastructure:
  - Cloudflare R2 is the object store; Garage is removed. nginx gate → media-origin → R2.
  - Backups to R2. The interim vault is on the gpu-01 HDD.
  - r2-usage cost guard.
  - edge-1 runs 2 OCPU / 12 GB, with a 40 GB nginx media cache.
- V4-b transcoder on gpu-01 (NVENC, `UPLOAD_PARALLELISM=16`). A 65 s clip reaches READY in about 11–15 s.
- QOE2 tracker (#260).
- **SEC0** (#264):
  - Cockpit 9090 and 7890 are closed publicly; SSH is key-only;
  - `www.winkey.vn` redirects 301 to the apex;
  - host PostgreSQL listens on loopback only.
- **#249** done: 1 active account (`thanhluanbka_44fab0`, the user's admin) and 8 suspended; the rest are deleted.
  Smoke tests use a throwaway account deleted with `deleteMe`. SEC1 smoke checks fail closed (#266).
- **BETA1 invite codes** (#265 code, #268 deploy):
  - `REGISTRATION_MODE=invite` is live;
  - codes are in the `auth-secrets` Secret;
  - the first-wave code is on edge-1 at `/home/opc/beta_invite_code.txt` (0600; for the user only);
  - the smoke code is in `/etc/winkey/smoke.env`.
- Postgres schema_migrations = 18; ClickHouse 0001 + 0002.

## CIN1 rollout accepted and merged
- CIN1 cinema home (#267, main `ba5795c`) is live; rollout PR #269 squash-merged as
  `0a5843b0a661bcc4bcc736ebf48bebb056a71766` using exact head
  `70bc385613c8d3e6063d14868832213c7cd8c6cd`, with green CI.
- Astra programmatically matched the web pin against `containerimage.digest` in images run 37585564468,
  web job 112675397392, for main `ba5795cca24e8dd2160f8c249c07dd9a308daa1b`.
- Independent production check: home 200 with cinema hero/title; both redirects 308; kendrickheller.com,
  cuuhohanam.com, kidzlab.edu.vn and sblaichau.vn all 200. rs.kendrickheller.com also 200.
- CINEMA_CURATOR_HANDLE and FEEDBACK_URL are empty. Remove the redundant NEXT_PUBLIC_FEEDBACK_URL in the later
  BETA1-web rollout.

## In progress
| Agent | Task | Brief | What to check |
|---|---|---|---|
| Antigravity 2 | LT2 temporary generator preparation | BETA-ops D | give the user exact OCI/Tailscale steps; ap-singapore-1, A1 arm64 2 OCPU/12 GB; same-night VM and boot-volume deletion; no load before gates pass |
| Antigravity 1 | BETA1-web, PR #270 | `antigravity-1_BETA1web_invite-legal.md` | see the next 4 items |
| Antigravity 4 | LT2 harness, PR #263 | `antigravity-4_LT2_production-1000-viewers.md` | see the LT2 items below; **must not run until merged** |

BETA1-web must:
- add the invite field, `?invite=` prefill, `?error=` messages and the Google `invite_code`;
- add the terms checkbox;
- add the legal pages copied verbatim from docs/legal (with a test that the copies match);
- **carry two items over from #267:**
  - the footer must read the runtime server env `FEEDBACK_URL` (not `NEXT_PUBLIC_*`, no `#feedback` fallback),
    hidden when empty, https or mailto only;
  - on mobile, the hero ⓘ button stays on the same row as the other buttons.

Astra review observations (2026-10-07):
- #270 head `f4528b05c9d54133a66910c60cace783060e87dd`: CI green; independent register/legal unit tests 23/23
  and production build pass. FEEDBACK_URL is read in the layout without request-time opt-in; the build confirms
  /register is prerendered without revalidation. HTTP runtime smoke on this Windows host was inconclusive
  (redirect/timeout). Require a build-once/runtime-change regression test, including a sidebar route.
- The hero mobile row has the requested nowrap/sizing changes; require the brief's actual Playwright outputs,
  mobile evidence and 10 consecutive new-test passes before acceptance.

LT2 harness #263 head `60ed525b47866cff452a0729412ea4e90a2f25f0`: NOT APPROVED; do not run production.
- Fixed in the diff: deleteMe path /v1/auth/me, 204 success branch, fresh login before deletion, max 5 preseed
  accounts and metadata journal written before registrations.
- Still blocking: cleanup swallows failures and deletes recovery journals. Astra reproduced a 401 login on a local
  fake server: no deletion, exit 0, metadata journal removed. Retain unresolved records and return nonzero.
- Comment IDs are appended to per-VU setup-data copies; teardown never receives those mutations, and the comments
  file stays empty. Persist/recover comment IDs and confirm deletion before deleting accounts.
- Aggregate non-seek ratio is not computed/enforced; p95 still controls the threshold. Use sum(stall)/(sum(watch)
  + sum(stall)), report both ratios and propagate the aggregate result to the runner's exit status.
- Watchdog is optional, treats HTTP 500 as curl success, and does not reliably stop both Docker generators.
  Require all four sites, check HTTP 200, handle INT/TERM, stop/wait both containers, then cleanup.
- HTTP >5% for one minute and edge available RAM <1 GiB need operational abort enforcement/explicit monitoring.
  Preserve each generator's result: `wait PID_HLS PID_API` only returns the last status.
- Tokens are written to disk; login/refresh in memory using the metadata journal. Refresh during the 35-minute
  workload too (15-minute token lifetime). Do not fall back to unjournaled registrations after preseed failure.
- Root lint & format CI remains red; add deterministic offline tests for the failure and abort paths.

## Beta gate order (ADR-034)
SEC0 ✅ → #249 ✅ → BETA1 ✅ → CIN1 ✅ + BETA1-web ⏳ (changes requested) → LT2 ⏳ (changes requested).

Then the user sends the first wave of invites, using the link `https://winkey.vn/register?invite=<code>`. This happens
only after BETA1-web is deployed AND LT2 has passed.
- LT2 window: 02:00–03:30 Asia/Ho_Chi_Minh, from the night of 2026-10-09.
- Generator: a temporary OCI A1 VM (BETA-ops D), deleted the same night.

## Legal text filled; BETA1-web deploy pending
- User supplied the legal details on 2026-10-07. Astra filled docs/legal and matching web copies; effective date
  is 10/10/2026 and backup retention is 14 days. These source documents and matching web copies are committed
  together in the Astra continuity docs PR; include these exact copies before
  BETA1-web deploys. Do not announce invitations ready before the chosen effective date.

## Waiting on the user
- Choose `CINEMA_CURATOR_HANDLE` and create a few PUBLIC playlists on that channel. Optional: a feedback form URL.
- For LT2 night: create the OCI VM and an ephemeral Tailscale key (Antigravity 2 gives the exact steps).
- Drop the `qoe_ro` ClickHouse user (if not done).
- LEGAL review (blocks the public launch only).
- Whether to resume Sonnet / Sonnet 2.

## Backlog (does not block the beta)
- QOE3: nginx media access log to Loki, plus a data-freshness panel.
- QOE2 follow-up: call `recordLoadedData()` when `readyState >= 2` at tracker creation.
- R2-ab decision (≥ 2026-10-19).
- CIN2: genres, series, posters and server-synced continue-watching. Only if the user asks; needs contracts.
- node-01 (INF-W1); home Garage cluster (INF-W2) at ≥ 3 home nodes.
- ClickHouse restore check in the monthly drill.

# FIRST STEPS FOR A NEW ARCHITECT SESSION
1. List open PRs, check the last 5 CI runs on main, and read #47 comments newer than the `STATE` date above.
2. Review any new PR against its CURRENT brief in docs/prompts/.
3. Post a short "architect resumed (<name>)" note on #47.
4. At the end of the session, update `STATE` above (docs PR) and post the link on #47.
````
