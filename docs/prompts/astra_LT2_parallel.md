# LT2 parallel completion brief — 2026-10-08, Astra

The user explicitly requested other team members to join LT2 completion on 2026-10-08. This overrides the prior idle preference for these scoped tasks. Ownership does not change; Sonnet and Sonnet 2 stay paused. No new product feature, service performance fix, contract change or production load is authorized.

Current integration target: PR #263 at 59d81f3c63fd4b81ab9c760b956618f7b4828ccd; review 5455268331. CI has five no-undef errors; actual request/body deadline findings are accepted, remaining groups are not. Each member works in a separate worktree/branch and does not push AG4's branch.

## [LT2-A1] Antigravity 1: actual offline runner and workload regressions

Assignment: https://github.com/luantpbk/winkey/issues/275

Owner: Antigravity 1. Authorized by the user's 2026-10-08 request to distribute remaining LT2 work. This supports ADR-034 and PR #263, not a new feature.

Use your own worktree/branch; write only e2e/ (including offline fixtures/helpers). Read the exact current #263 snapshot; never push its branch or edit loadtest/. Open a separate draft PR if committing tests.

Build regressions against ACTUAL runner/workload/cleanup/collector code, using controlled module adapters, fake Docker/processes and loopback HTTP fixtures. No copied validation/token/window helpers. Cover exact-host and ICT date/start cutoff; workload failure/INT/TERM and stop-wait-drain-cleanup order; lost ACK/create response and renewal failure; malformed/missing cursor, request/body timeout, persistence failure and retry. No production requests/accounts/load; fake CLI must never invoke real Docker/OCI/SSH.

Report each finding -> target SHA -> actual command/output -> test file. Expose current failures honestly; no skips or weakened assertions. Share fixtures/outputs with AG4 via this issue; AG4 fixes loadtest/. Re-run on its final head and require pass before acceptance. Architect merges only exact green SHA. Current review: https://github.com/luantpbk/winkey/pull/263#pullrequestreview-5455268331

## [LT2-A2] Antigravity 2: platform watchdog and offline CI gate

Assignment: https://github.com/luantpbk/winkey/issues/276

Owner: Antigravity 2. Extension of your CURRENT LT2 generator/platform preparation; no transfer of your deployment/OCI ownership. User requests parallel support for ADR-034 gate.

Own worktree/branch, modifications only deploy/, owned workflows/root tooling. Keep generator standby; no production load until architect accepts/merges harness and grants go-ahead.

Deliver read-only proof of edge-1 MemAvailable source (verified edge instance/metric, never generator RAM), mandatory HTTP200 checks for kendrickheller.com, cuuhohanam.com, kidzlab.edu.vn, sblaichau.vn every30s, and support sustained >5% load HTTP errors for60s. Implement any platform helper in deploy/ and submit a separate PR with offline failure/timeout tests. Agree helper inputs/stop notification with AG4 and record proposed interface for architect approval/documentation before integration; AG4 alone modifies loadtest runner. No new firewall/privileges/secrets.

Make CI execute actual offline LT2 regressions (loadtest tests plus AG1 handoff once available) on relevant exact PR heads; do not rely on root lint alone, silently skip absent required tests, or run production load. Coordinate test wiring with AG1/AG4.

After approved LT2: tailscale logout, delete VM AND boot volume same night, post non-secret proof to #47 and linked [LT2] result. Never touch gpu-01 protected workloads. Report helper/CI PR SHA and tests; architect reviews/merges.

## [LT2-A3] Antigravity 3: auth/social contract and recovery audit

Assignment: https://github.com/luantpbk/winkey/issues/277

Owner: Antigravity 3. Read-only specialist support for remaining #263 auth/social recovery findings, authorized by user to distribute LT2 work. Current service implementations are not assigned a performance fix.

Read auth/social OpenAPI and actual #263 API-mix, cleanup and collector diff at reported SHA. Provide contract-valid synthetic fixtures and an actionable patch proposal/output to AG4 through this issue: exactly five unique run-owned accounts, in-memory login/renewal failure behavior and rate limits; actual Comment.author nullable profile with NO invented email; all cursor pages, account-delete success and purge-before-author; lost create response/ACK, malformed journals, retry and authoritative zero-leftover verification. Explain limits if an existing API cannot prove reconciliation; raise contract-change for architect rather than inventing an endpoint.

Run only offline/mock/loopback probes; no production write/load, account deletion or real secrets. Do not edit loadtest/, contracts/, migrations or another agent branch. A report does not require a code PR. Any proven service defect must be reported separately for architect decision before product changes. Deliver finding -> contract line -> actual source line -> fixture/probe -> output; AG4 integrates harness code.

## [LT2-G1] Codex: playback contract and exact QoE gate audit

Assignment: https://github.com/luantpbk/winkey/issues/278

Owner: ChatGPT (Codex), acting Go data-plane owner. Read-only specialist support for #263, authorized by user; Sonnet and Sonnet2 stay paused.

Read video OpenAPI, current actual HLS workload, ADR-034 and LT2 brief. Deliver actual-source audit and concrete patch/fixture suggestions to AG4 through this issue. Enforce PUBLIC READY playback.hls_url, relative URL resolution without invented manifest endpoint, valid first/remaining segments, zero-valid-playback failure and no invented watch duration.

Provide numerical fixtures/output for EXACT aggregate sum(non-seek stall)/(sum(watch)+sum(non-seek stall)) across unequal session durations, near1% boundaries and zero denominator. Inclusive-seek ratio is separate; p95 per-session is information only. Cover test-wide failure/exit behavior, request failure and both summaries; no copied-helper-only proof.

Own worktree; never edit loadtest/ or AG4 branch. Offline/mock only, no production load/service changes or speculative performance fix. Report contract/source lines, proposed patch, fixture input and expected/actual outputs; AG4 implements and tests loadtest changes. Product-service defects, if any, go to a separate issue for architect decision. No new feature/ADR.

## Antigravity 4 — integration and completion of existing #263

Continue the existing task. Fix CI Node-global/timer declarations and the remaining cleanup/collector durability and schema findings. Consume A1's actual regression tests, A2's platform/CI changes, A3's contract fixtures and Codex's QoE findings. Own ALL changes to loadtest/ and systest/, including API-mix, runner stop/drain/window and HLS metrics. Helpers in another owner's directory land through that owner's separate reviewed PR; do not copy unreviewed code or push their branch. Declare dependencies and coordinate public interface proposals in the assignment issues; Astra records any resulting design addendum before integration.

Keep the entire finding-to-implementation/test/output checklist in the actual PR Handoff Report. Report partial group completion explicitly; whole-PR completion requires every blocking group fixed and real offline tests/CI green on the final SHA. Never weaken tests, reopen accepted findings without new evidence or use screenshots/reports as acceptance proof.

## Gate and execution

Astra independently reviews diffs and CI logs and merges with exact green SHA. Production load requires accepted/merged harness and explicit go-ahead inside 02:00–03:30 ICT from 2026-10-09, enough cleanup reserve, and accepted web already live. AG2 retains VM/boot-volume destruction ownership the same night. AG4 posts [LT2] result with cleanup and linked destruction proof; no performance fix before evidence identifies the first bottleneck. Invitations remain gated on LT2 PASS and the legal effective date 10/10/2026. No code, credentials, tokens or invite secret are published.
