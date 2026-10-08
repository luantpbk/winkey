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
| Antigravity 1 | apps/web, e2e, packages/api-client | idle; BETA1-web accepted and merged #270 |
| Antigravity 2 | deploy/, workflows, root tooling; every production rollout | rollout complete; LT2 generator standby / same-night deletion |
| Antigravity 3 | auth, social, realtime, shared TS packages | idle |
| Antigravity 4 | systest/, loadtest/ | LT2 (PR #263, changes requested) |
| Sonnet / Sonnet 2 | — | PAUSED; no work until the user says so |

# STATE (updated 2026-10-08, by ChatGPT Astra, acting architect)
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
- CINEMA_CURATOR_HANDLE and FEEDBACK_URL are empty. Redundant NEXT_PUBLIC_FEEDBACK_URL removed in #274.

## In progress
| Agent | Task | Brief | What to check |
|---|---|---|---|
| Antigravity 2 | LT2 generator standby / same-night destruction | BETA-ops D | rollout complete; standby until harness accepted; delete VM and boot volume same night with evidence |
| Antigravity 4 | LT2 harness, PR #263 | `antigravity-4_LT2_production-1000-viewers.md` | see the LT2 items below; **must not run until merged** |

BETA1-web must:
- add the invite field, `?invite=` prefill, `?error=` messages and the Google `invite_code`;
- add the terms checkbox;
- add the legal pages copied verbatim from docs/legal (with a test that the copies match);
- **carry two items over from #267:**
  - the footer must read the runtime server env `FEEDBACK_URL` (not `NEXT_PUBLIC_*`, no `#feedback` fallback),
    hidden when empty, https or mailto only;
  - on mobile, the hero ⓘ button stays on the same row as the other buttons.

Astra acceptance (2026-10-08):
- Main CI run 37656127763 at #272 merge initially failed in web realtime.test.tsx:189; failed jobs rerun once
  now SUCCESS. No test weakened; no root-cause claim.
- #270 accepted and squash-merged as `f6cd24330bc8a04fa1b42b7a7fd88a5d22451d97` using exact green head
  `21a7c9bc17fae8b78d8de9545472eaf5fda1227b`; APPROVED review 5450978496. Actual head CI log: 30 files / 396 web
  tests pass; all checks success or normal path-skip, both image architectures green.
- Dynamic feedback API and both shell hooks resolve runtime FEEDBACK_URL while legal pages stay static (ADR-034
  addendum). Same-artifact four-value regression source and outputs reviewed; portable screenshot evidence
  independently inspected. Mobile drawer now opens and link is in viewport; hero three buttons fit 375px.
- All three legal copies independently hash-match completed canonical sources. English labels fixed; no agent
  machine path added; process cleanup now stops only the owned child. A non-blocking local-test startup-failure
  child cleanup nit remains recorded on the approval; no follow-up feature/task assigned.
- **LIVE / ACCEPTED**: rollout #274 squash-merged as `181fb1c69f17ae9bfbc8ef8c003db3caf9ee3941` using exact
  green head `81235656b971592a14426b171368256b7e21f82f`, APPROVED review 5451213630. Digest matches actual
  main f6cd243 CI containerimage.digest (images run 37722582611 / web job 113133442972). Matching main
  CI 37722582654 SUCCESS. Production HTTP independently verifies cinema, redirects, three legal pages and
  feedback API null. Browser verifies Vietnamese register invite field, unchecked checkbox and disabled
  Create Account / Google; no account created. All FOUR canonical legacy sites 200, including kidzlab.edu.vn.
- AG2 corrected the four-site evidence list on #47 (6052049634). Independent kidzlab
  verification satisfies the gate. AG1 idle; AG2 rollout complete, standby for LT2 same-night deletion.

LT2 harness #263 head `c936389b3f29a7d18e154216251c6180eb24c05a`: NOT APPROVED; do not run production.
- CI GREEN: root run 37754093455/job 113234299536 format passes, zero lint errors. Review 5454276306.
  Independent snapshot tests: 14/14 pass. Accepted: API-mix uses metadata login and removes token-file reads
  and fallback registrations; cleanup login failure retains matching comments and account; corrupt/non-array
  journals throw before deletion. Real cleanup regressions pass. Prior comment-failure author retention stands.
- Latest diff touches ONLY API-mix and count helper test. Accepted: exact five-account check and missing-token
  rejection. Actual-source mock probe confirms six accounts / missing token both reject setup.
- Actual-source five-account probe creates one comment, collector fails three ACKs, workload does not abort.
  Renewal failure and uncertain-write recovery remain blocked; validate unique owned metadata and ACK,
  preserve authors until reconciliation, stop BOTH workloads. Remaining runner/HLS/collector implementations
  and README/Handoff Report unchanged; replace copied helper tests with real implementation regressions.
- Cleanup JSON parsing is fixed, but record-array validation/contract success and atomic 0600 persistence
  remain; collector still turns corrupt prior journals into empty arrays and can overwrite recovery records.
- k6 fail() still aborts only an iteration. Window bypass is limited by unsafe substring-host checks, allowing
  remote URLs containing localhost to bypass. HHMM octal errors, missing ICT start date/cleanup reserve and
  timezone fallback remain. Parse exact hostname and use tested decimal preflight with no production bypass.
- Collector preflight remains unbounded/accepts HTTP 500 or unowned listener and starts before cleanup trap.
  Abort still kills collector before writers, swallows cleanup failure and can resume after signals. Stop/wait
  run-owned containers first; drain/close/wait collector then cleanup, fail nonzero, and exit on INT/TERM.
- HLS now reads `playback.hls_url`, but still falls back to `/v1/videos/:id/manifest.m3u8` (absent from contract).
  Remove fallback and test the actual request sequence, not a copied helper. Reject empty/invalid
  playback and failed first segments. Gate on exact aggregate non-seek stall/(watch+stall); the rounded Rate
  approximation and p95 threshold do not satisfy the brief. Report the inclusive ratio separately.
- Watchdog reads generator RAM instead of edge-1 RAM, omits sustained HTTP-error abort, leaves legacy checks
  optional and accepts HTTP 500. Enforce all four HTTP 200 checks, edge available RAM and >5% errors for 60s.
- Enforce ICT date/window before account creation, with cleanup reserve. Stop/wait both run-named containers,
  drain collector, then cleanup; preserve both exit statuses and terminate on INT/TERM. Do not stop unrelated
  containers or swallow cleanup failures.
- API-mix enforces five and token presence, but still ignores renewal/ACK failure. Use five
  metadata-only accounts (0600), in-memory login/refresh and fail-closed preseed; do not log emails.
- Collector ignores durability failures and binds all interfaces; use loopback, validated atomic recovery records,
  0600 and a recovery path for lost create responses/acknowledgements. Add meaningful offline regressions.
- No `[LT2] result` issue found. AG2 posted non-secret host/Docker/Tailscale/isolation outputs and corrected
  schedule on #47; generator is on standby. Oct 9 02:00-03:30 ICT is Oct 8 19:00-20:30 UTC.
  No production load until web deployed and harness accepted/merged. VM and boot volume deletion evidence
  is mandatory the same night after the run; user/AG2 terminate the resources.
  A failed harness review is not a production bottleneck measurement. Assign no performance fix without evidence.
## Beta gate order (ADR-034)
SEC0 ✅ → #249 ✅ → BETA1 ✅ → CIN1 ✅ + BETA1-web ✅ (deployed / accepted #274) → LT2 ⏳ (changes requested).

Then the user sends the first wave of invites, using the link `https://winkey.vn/register?invite=<code>`. This happens
only after BETA1-web is deployed AND LT2 has passed.
- LT2 window: 02:00–03:30 Asia/Ho_Chi_Minh, from the night of 2026-10-09.
- Generator: a temporary OCI A1 VM (BETA-ops D), deleted the same night.

## Legal merged; BETA1-web deployed and accepted
- User merged Astra docs PR #272 as `5be48cb5e410b2c7e31eb7f569c0ea8495db54fc`. Legal sources and matching web
  copies are complete with the user's exact text: effective 10/10/2026, backup retention 14 days, OCI region
  ap-singapore-1. #270 has synchronized these copies. Do not announce readiness before that effective date.
- #270 app and #274 rollout are accepted/merged/live; #263 is green but still changes requested.
## Waiting on the user
- Choose `CINEMA_CURATOR_HANDLE` and create a few PUBLIC playlists on that channel. Optional: a feedback form URL.
- For LT2 night: AG2 supplied non-secret generator readiness outputs; standby until the gates pass.
  The user/AG2 must terminate the VM and boot volume the same night and post evidence.
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
