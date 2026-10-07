# Kickoff — Antigravity 4 · Task LT2 (1.000 concurrent viewers on production)

Design: ADR-034 (beta gate 5). Harness: `loadtest/` from LT1. **This is the architect's explicit go-ahead to run
against production, and it holds only inside the window and with the limits below.**

````text
# ROLE
You are Antigravity 4, QA on Winkey (repo luantpbk/winkey). You own systest/ and loadtest/. Never edit services/,
deploy/, apps/.

# REPO
Worktree: git worktree add ../winkey-ag4-lt2 -b agent/ag4/lt2-production origin/main

# BEFORE THE NIGHT (repo PR, merge before the run)
1. hls-viewers.js:
   - Report TWO ratios. `rebuffer_ratio` = stalls NOT caused by a seek (the P2 criterion, same rule as the web tracker
     after QOE2). `rebuffer_ratio_incl_seek` = informational.
   - Aggregate ratio = sum(stall_ms) / (sum(watch_ms) + sum(stall_ms)) over all VUs. That is the gate. Keep p95 per VU
     as information only.
   - Add `http_req_failed` < 1 % as a threshold.
2. Production mode, enabled by `TARGET_URL=https://winkey.vn`:
   - NO uploads and NO seeding of new videos. Viewers pick from the PUBLIC READY videos returned by
     `listVideos?sort=newest&limit=50`.
   - api-mix writes (comment, like) use at most 20 accounts `lt2_<random>`, registered with the LT2 invite code from
     the env `LT2_INVITE_CODE`, entered on the load VM with `read -rs`.
   - The run ends with a teardown that deletes every comment it created and calls deleteMe for every lt2 account.
     Teardown also runs on abort (k6 teardown + a standalone `cleanup.mjs`).
   - Respect auth rate limits: register the accounts slowly before the ramp.
3. A runbook in loadtest/README.md "LT2 on production": the ramp, the abort rules, the teardown, and what to capture.

# THE RUN (window 02:00–03:30 Asia/Ho_Chi_Minh, first night 2026-10-09; any later night if that slips)
- Generator: the temporary OCI A1 VM prepared by Antigravity 2. Never run it from gpu-01 or the home network: there is
  not enough downlink.
- Ramp: 50 → 200 → 500 → 1000 viewers, each step 5 min. Hold 1000 for 15 min. Run api-mix at 5 % of the VU count in
  parallel.
- ABORT immediately (and run cleanup) if any of these happens:
  - HTTP errors > 5 % for 1 min;
  - any of the 4 legacy sites fails an HTTP check (curl them every 30 s from the VM);
  - edge-1 memory available < 1 GiB;
  - the user or the architect says stop.
- Capture:
  - the k6 summaries for both ratios;
  - Grafana panels: edge-1 CPU / RAM / network, nginx cache hit ratio, `media-origin` upstream time, R2 requests;
  - the 4 legacy-site checks.

# AFTER
- Run the cleanup and verify 0 lt2 accounts and 0 lt2 comments remain.
- Tell Antigravity 2 to destroy the VM.
- Post the report as a new issue `[LT2] result` and link it on #47:
  - PASS when: aggregate `rebuffer_ratio` < 1 %, `http_req_failed` < 1 %, the legacy sites stayed up, and no abort.
  - Otherwise FAIL, with the first bottleneck you saw (CPU, NIC, cache miss → R2, origin).
- Do not change anything on production to "fix" it during the run.
````
