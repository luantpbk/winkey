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
| ChatGPT (Codex, "GPT 6.1 sol medium") | services/video, analytics, upload, transcoder, libs/go | acting owner; #278/#284 complete (#281/#288), idle pending architect contract #286 |
| Antigravity 1 | apps/web, e2e, packages/api-client | LT2-A1 offline regressions #275; BETA1-web complete |
| Antigravity 2 | deploy/, workflows, root tooling; every production rollout | LT2-A2 watchdog/CI #276; generator standby / same-night deletion |
| Antigravity 3 | auth, social, realtime, shared TS packages | #277 scoped audit complete; idle until CIN2 architect contracts |
| Antigravity 4 | systest/, loadtest/ | LT2 (PR #263, changes requested) |
| Sonnet / Sonnet 2 | — | PAUSED; no work until the user says so |

# STATE (updated 2026-10-09, by ChatGPT Astra, acting architect)
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
| Antigravity 2 | LT2 platform watchdog/CI + standby/destruction #276 | BETA-ops D | rollout complete; standby until harness accepted; delete VM and boot volume same night with evidence |
| Antigravity 4 | LT2 harness, PR #263 | `antigravity-4_LT2_production-1000-viewers.md` | integrate specialist outputs + all remaining findings; **must not run until merged** |

Parallel work authorized explicitly by the user on 2026-10-08; prior idle preference is overridden only for these
LT2 tasks. Ownership remains unchanged, Sonnet/Sonnet2 stay paused. Brief: `docs/prompts/astra_LT2_parallel.md`.

| Member | Scoped task / delivery |
|---|---|
| Antigravity 1 | #275: actual offline runner/workload regressions; e2e-only draft PR, failing-to-passing outputs |
| Antigravity 2 | #276: platform watchdog + offline CI; extends current generator prep, keeps destruction ownership |
| Antigravity 3 | #277: auth/social contract-valid fixtures and recovery audit; report to AG4, no service fix assigned |
| Codex | #278: playback/exact QoE audit and numerical fixtures; report to AG4, no Go service fix assigned |
| Antigravity 4 | Existing #263: sole loadtest/systest integrator, all open code findings and actual Handoff Report |
| Astra | Review interfaces/dependencies/diffs/CI, document any design addendum; no production go-ahead yet |

Outputs re-reviewed 2026-10-09; #288 merged, LT2 still blocked:
- AG1 #280 headc3c9abc1ea758250776d9e836347ec78c8d2d466: scoped guard correction ACCEPTED COMMENT5472608288.
  CI37925985741 RED, offline113804973904 e2e38tests15pass22fail1skip; guard regression PASS,
  remaining22 failures inherited olddependency; helper75/75 and cleanup20/20PASS. Root113804973882 inherited5loadtest errors.
  CLOSED: immediate live requery before group and each PID signal; injected query sequences D/E refuse reused
  PIDs after group/earlier child kill. Strict null/reused timestamp guard and prior technical closures retained.
  No new scoped code blocker; do not churn accepted guard or edit AG4 files. No unsafe execution by Astra.
  Merge waits for accepted dependency/final exact-head green and actual native evidence: k6 unavailable,
  crash skipped, native scenarios supplementary fallback. No native gate acceptance from models. #280 draft.
- AG2 #279 APPROVED5465388984, exact green7885baf4752937b75d503108e379d1f8473ff6bf
  squash-merged710ca88d648408dfff727289a15d5c1d2b71abb6. Actual CI37877545985/job113649520811 and independent
  offline75/75 PASS with extra network-deny guard. Standalone helper accepted; harness integration remains
  gated. ADR034 addendum records interface; AG2 generator standby/same-night VM+boot-volume deletion unchanged.
- AG3 #282 head163ac637f75e93c1ecab809760718085ae6cd08d: scoped delivery ACCEPTED COMMENT5467930084.
  CI37906809615 GREEN; actual TS113742198213 logs/tests/build inspected, probe not run by Astra. Exact manual
  fixture/narrower-policy/model wording now truthful; last claim finding CLOSED, prior technical closures retained.
  #277 CLOSED. #282 remains draft/pending independent review/merge because authenticated author account; no
  self-approval/merge. This accepts specialist support, NOT actual AG4 code/native gate/coordinator integration.
  AG3 idle until architect CIN2 contracts/migration and assignment gate; no new endpoint implementation authorized.
- Codex #281 APPROVED5458996658, exact green1ed6832ca023df9853160478fc5e9c2e9abb4b6a
  merged4390957298633bec84204b32dd833adaeb30ecea; LT2 defect evidence only, #278 complete.
  CIN2 #288 APPROVED5467410494, exact green55497f849e9c4ab4e573cb59c43ae4de5d5ff2fb
  mergedb978f66c0676e9d89ee4850650b8b3167b0607aa. Single cached signed-playback regression; actual CI37886494670
  video113677595497 vet/race api4.619s/integration309.048s PASS; existing CI20m timeout unchanged. No local full
  Docker rerun by Astra; agent report separates local failed retries and eventual full fixture pass. No deploy.
  #284 accepted/closed; Codex idle until architect PUBLIC-only contract #286. AG1 #287 late-refresh identity
  source-risk/regression remains feature gate, not a reproduced production bug. Sonnet/Sonnet2 stay paused.
- AG4 #263 head182f6ebfc95f2dc4ec05f9b63a86c2faf61a2337: changes requested5472849584 despite GREEN CI37959998082.
  Offline113920170956 helper75/75 and loadtest28/28PASS, zero skips; root113920171002GREEN.
  CLOSED: SYSTEM_VN_TIME runtime override removed; test-only fake date executable; window now before password,
  so positive control actually crosses time gate. Do not rework these closed clock findings. Prior journal conflict,
  silent-skip/unrelated-error assertion/token-file/lint/cleanup closures retained.
  Two-file delta does not implement existing exact production window/host/cutoff-reserve or required readiness,
  dual telemetry/helper death/abort/lifecycle/HLS/auth/durable recovery groups. Complete existing consolidated
  checklist with actual changed code/regressions/output; blocked items explicit. No whole-PR acceptance from
  green clock tests/mock log claims. Shared sentinel/fixed ports/inherited env/deadline limitations remain.
- #47 table6085187016 records current decision; #280 unchangedc3c9abc, scoped guard correction remains accepted
  pending native/dependency/final green; #277 complete, #288 remains merged. STATE #273 independent review/merge pending.
  No accepted LT2 result or production go-ahead. Beta invites require LT2 PASS and legal effective10/10/2026.
  AG1/AG3 cinema implementation queued after current acceptance and architect/backend gates.
One worktree/branch per member; do not push another owner's branch. Separate helper/test PRs need independent
architect review. Full finding -> changed lines -> actual regression/output checklist remains mandatory.

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
  verification satisfies the gate. AG1 now #275; AG2 rollout complete, #276 platform/CI and LT2 deletion.

LT2 harness #263 head `182f6ebfc95f2dc4ec05f9b63a86c2faf61a2337`: NOT APPROVED despite CI GREEN; do not run production.
- Review5472849584: SYSTEM_VN_TIME runtime override and false positive time control CLOSED.
  Test-only date CLI added; window before password means actual gate transition now tested. Preserve closures.
  Existing exact host/date/ICT/cutoff/cleanup reserve and hard no-outbound bounded test requirements remain.
  Prior token-file/unrelated-error/real-clock silent skip closures retained; tokens stay memory-only.
- Hidden cleanup/preseed mock paths removed/closed. PREFLIGHT_ONLY still creates accounts; DRY_RUN skips
  workloads and invents success without actual preflight; these false-success runner modes remain unaccepted.
  Temporary journal directories now fix observed cleanup conflict; fixed ports/inherited env/unbounded children/log-string claims remain. Isolate snapshot,
  minimal env, contract fixtures, hard loopback guard, deadlines and verified owned teardown. No erased recovery data.
- Required accepted helper, actual HTTP observations of BOTH workloads/rolling source, readiness before account
  creation/load, helper death checks, private run-scoped matched sentinel and retained nonzero abort remain missing.
  Optional fallback omits error-rate/status/canonical-site/provenance/freshness checks; zero/missing/negative RAM allowed.
- Collector preflight still unbounded before trap. Abort kills collector before writers, lacks owned container/drain
  waits, swallows cleanup failure and may resume after signals. Stop/wait writers/owned containers -> drain/wait
  collector -> cleanup; terminal signals, first failing peer and combined failure outcome required.
- HLS/api-mix/collector unchanged: PUBLIC READY/detail/URLs/init/segments, no invented manifest/false watch; exact
  weighted non-seek stall/(watch+stall), separate inclusive report and actual zero-playback/native final failure.
  Cross-VU five-account renewal, no write-to-read degradation; ACK/uncertain-create/durable full-schema exact-run
  ownership, DELETE204 and authoritative zero-leftovers/no-email logs remain. No unaccepted AG3 coordinator.
- Accepted prior cleanup fixes stay closed: real request/body budget, required cursor/cycle/page cap, corrupt recovery
  preservation/atomic journal subset, no invented author email, failed-comment/login author retention and conflicting
  known account-pair detection. New presence-only metrics check and correct helper env names do not close integration.
- Whole PR Handoff must map finding -> actual code -> actual regression/output; stale targetVM/5m/p95/password sample
  and unsupported README preflight/dual telemetry/death/stop-wait-drain claims must be corrected.
- No accepted [LT2] result, no performance fix without first-bottleneck evidence. Run only after accepted/merged harness
  and explicit go-ahead inside02:00-03:30 ICT, with cleanup reserve. AG2 deletes VM AND boot volume same night and
  posts linked non-secret proof. Invitations remain gated on PASS and legal date.
## CIN2 requested: real series and episode playback (2026-10-09)
- User explicitly requests the feature and confirms owners mark a playlist “Bộ phim”. Regular collections are not
  automatically films. Existing lists can be converted; standalone videos stay one-episode films.
- Feature #283; design PR #285, head `17ebf5471ce6ca2843255d013fbe2ed9ae71fa7a`. ADR-035 + canonical brief
  `docs/prompts/astra_CIN2_series.md` are in that separate design PR, based on main `710ca88d648408dfff727289a15d5c1d2b71abb6`.
  Exact-head CI 37885106617 SUCCESS; independent review pending. Contracts/migration/generated client and runtime implementation
  are NOT yet delivered or deployed. Design PR is not a feature-live claim.
- One public series card replaces its individual episode cards; catalogue membership/pagination is backend-owned.
  Series detail/watch keeps playlist context, playable episode order/count, desktop sidebar/mobile below-player,
  previous/next across pages and deep links; preserve video visibility checks and existing player/tracker.
- Codex CIN2-G1 #284 readiness accepted/closed via #288, test-only mergeb978f66c; actual batch/detail/playback audit and
  real tests expose PUBLIC-only batch contract gap #286. Architect contract gate before implementation; no production calls.
- AG3 CIN2-S1 queued after current #277/#282 accepted and architect contracts/migration merge. AG1 CIN2-W1 queued
  after #275/#280 accepted and contract/backend available. Brief records tests, boundaries and separate branches.
  Do not start a second implementation task while LT2 work remains unaccepted.
- AG2 retains platform/LT2 VM/deletion, later CIN2 rollout only after accepted implementation. AG4 stays on #263;
  Sonnet/Sonnet2 paused. No production load/deploy authorization, new genre/poster/history pipeline or beta gate
  change is included. ADR-034 and the 10/10/2026 legal effective date still apply.
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
- #270 app and #274 rollout are accepted/merged/live; #263 CI is GREEN at182f6eb but review5472849584 remains changes requested for existing integration groups.
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
- Cinema extras: genres, posters and server-synced continue-watching remain backlog. Series/episode CIN2 is now explicitly requested; see #283/#285 above.
- node-01 (INF-W1); home Garage cluster (INF-W2) at ≥ 3 home nodes.
- ClickHouse restore check in the monthly drill.

# FIRST STEPS FOR A NEW ARCHITECT SESSION
1. List open PRs, check the last 5 CI runs on main, and read #47 comments newer than the `STATE` date above.
2. Review any new PR against its CURRENT brief in docs/prompts/.
3. Post a short "architect resumed (<name>)" note on #47.
4. At the end of the session, update `STATE` above (docs PR) and post the link on #47.
````
