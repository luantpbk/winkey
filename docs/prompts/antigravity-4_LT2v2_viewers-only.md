# Kickoff — Antigravity 4 · Task LT2 v2 (1 000 concurrent viewers, viewers only)

Design: ADR-034, addendum of 2026-10-10. **This replaces PR #263** (closed as superseded). Start a fresh branch from
main and reuse only what you need.

````text
# ROLE
You are Antigravity 4 (QA) on Winkey (repo luantpbk/winkey). You own systest/ and loadtest/. Never edit services/,
deploy/, apps/.

# REPO
Worktree: git worktree add ../winkey-ag4-lt2v2 -b agent/ag4/lt2-v2-viewers origin/main

# SCOPE: viewers + anonymous reads only
- NO accounts, NO registration, NO comments or likes, NO uploads. There is nothing to clean up afterwards.
- Target: https://winkey.vn, like real viewers. Generator: the temporary OCI VM from Antigravity 2.

# TASK (keep it small: about 400 lines including tests)
1. `loadtest/hls-viewers.js`:
   - Ramp 50 → 200 → 500 → 1000 (5 min each), then hold 1000 for 15 min.
   - Video pool: `listVideos?sort=newest&limit=50` plus `listVideos?sort=trending`, PUBLIC only. Pick 20 % hot.
   - Seeks as in LT1, but seek-induced stalls do not count.
   - Counters: `stall_ms_noseek`, `stall_ms_seek`, `watch_ms`.
   - In `handleSummary()`, compute AGGREGATE `rebuffer_ratio = stall_ms_noseek / (watch_ms + stall_ms_noseek)` and
     `rebuffer_ratio_incl_seek`, print PASS/FAIL, and write `results/lt2-summary.json`.
   - The gate is `rebuffer_ratio < 0.01` AND `http_req_failed < 0.01`.
2. `loadtest/api-read.js`: anonymous reads at 5 % of the viewer VU count with the same ramp: listVideos,
   getVideo, listRelatedVideos, listComments, searchVideos, listCinemaCatalog. Add an `http_req_failed` threshold.
3. `loadtest/lt2-run.sh`:
   - Refuse to run outside 02:00–03:30 Asia/Ho_Chi_Minh unless `TARGET_URL` is not winkey.vn.
   - Start `deploy/lt2/watchdog.sh --pid $$ --abort-file <run dir>/abort.signal` (merged in #279; interface in
     deploy/lt2/README.md). Before starting k6, check the watchdog process is alive and its first check cycle
     passed (read its log).
   - When the watchdog sends SIGINT, `docker stop` both k6 containers and exit non-zero, naming the abort reason
     from the abort file.
   - Run both k6 containers (image pinned by digest, as in LT1). Keep EACH container's exit code; the run fails if
     either fails or the watchdog aborted.
   - On exit, always print where the summary is.
4. Tests (node --test, offline, against a local fake HTTP server, no network):
   - window refusal;
   - summary maths for the aggregate ratio, incl-seek kept separate;
   - the runner propagates a failure from either generator, and a watchdog abort.
5. README section "LT2 v2 on production": steps, what to capture (k6 summaries; Grafana edge-1 CPU / RAM / network,
   nginx cache hit, media-origin upstream time, R2 requests; the 4 legacy sites), and the PASS rule.

# DEFINITION OF DONE
- CI green. Offline tests run 10× in a row. A 50-VU dry run against the local dev stack is posted in the PR.
- After the architect merges the PR, run in the window from 2026-10-12, with Antigravity 2 on the VM. Post an
  `[LT2] result` issue with PASS or FAIL and the first bottleneck seen.
````
