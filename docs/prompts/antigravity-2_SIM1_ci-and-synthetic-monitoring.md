# Kickoff — Antigravity 2 · SIM1 CI wiring + MON1 production synthetic monitoring (ADR-038)

Design: **ADR-038**. Part A starts once Antigravity 4's SIM1 PR (`./systest/run.sh --sim`) is merged. Part B can start now.

````text
# ROLE
You are Antigravity 2, platform/DevOps on Winkey (repo luantpbk/winkey). You own deploy/ and .github/workflows/*
(except contracts.yml). No secrets in git; secrets live in GitHub Actions secrets and are never echoed.

# PART A — extend `.github/workflows/sim.yml` (bootstrapped by the architect on 2026-10-11; after SIM1 is merged). Branch agent/ag2/sim1-ci
- It already runs 3 parallel ephemeral stacks (systest 12 scenarios + seed + k6). You own it now. Switch it to
  `./systest/run.sh --sim --reset` once SIM1 lands, and add what follows.
- Triggers:
  - `schedule` nightly at 20:17 UTC (03:17 ICT, outside the LT2 window and away from :00);
  - `workflow_dispatch`;
  - `pull_request` when the PR has the label `systest` OR touches `services/**`, `apps/web/**`, `db/migrations/**`,
    `systest/**`, `loadtest/**`.
- Runner: `ubuntu-latest`, timeout 45 min, `concurrency` per ref (cancel in progress on PRs only).
- Steps: checkout; Node 22; Docker Buildx with the GHA cache for the service images; `./systest/run.sh --sim --reset`.
- Baseline: download the `perf.json` artifact of the last successful nightly on main and pass it to perf-budget.
  On a green nightly, upload the new perf.json as the baseline artifact (retention 30 days).
- Always upload `systest/.run/report/**` (summary.md, Playwright traces/videos, perf.json, the compose logs on failure),
  retention 14 days. Put summary.md into `$GITHUB_STEP_SUMMARY`.
- On a red nightly: open or update ONE issue titled `[systest] nightly failing` (label `systest`) with the run link and
  the failed personas. Close it automatically on the next green nightly.
- Do NOT make it a required check yet; the architect decides after the first fully green `sim` run (all 3 stacks).

# PART B — MON1 production synthetic monitoring. Branch agent/ag2/mon1-synthetic
1. The account: create `synthetic_probe` on production with a dedicated invite code (`read -rs` on edge-1, as for
   smoke). Store `PROBE_EMAIL` / `PROBE_PASSWORD` as GitHub Actions secrets. Never put them in a PR or a log
   (use `::add-mask::`).
2. `deploy/synthetic/probe.mjs` (Node 22, no deps), User-Agent `WinkeySynthetic/1.0`, every request with an 8 s timeout:
   - GET `/` 200 and has the cinema markup; `/healthz` and `/readyz` 200;
   - GET `/v1/videos?limit=5` → pick the first id → GET `/watch/<id>` 200 with `application/ld+json`;
   - GET the video's `hls_url` (master) and the first segment, 200;
     never send playback heartbeats or view reports, so no view is counted;
   - GET `/v1/tags?min_videos=2&limit=1` → GET `/tag/<slug>` 200 with `rel="canonical"`;
   - GET `/sitemap.xml` 200, parse it, ends with `</urlset>`, ≥ 1 `<url>`;
   - auth: login as synthetic_probe → GET `/v1/auth/me` 200 → POST `/v1/auth/refresh` with the refresh cookie → 200
     with a new access token → `/v1/auth/me` again 200 → logout.
     This is the "Lưu" failure class. No other writes on production, ever.
   - Output one JSON line per check (name, status, ms). Exit non-zero if any check fails.
3. `.github/workflows/synthetic.yml`: `schedule` every 10 min (`*/10 * * * *`) + `workflow_dispatch`; timeout 3 min.
   - Two consecutive failures of the same check → open or update one issue `[synthetic] <check> failing`.
   - Auto-close it after 3 green runs.
   - Also push the timings to the existing Grafana/Prometheus if that is simple (a Pushgateway is optional).
     Otherwise keep them in the job summary.
4. Make sure the probe is excluded from rate-limit bans and does not pollute analytics:
   - it never hits the heartbeat or view endpoints;
   - confirm in the nginx logs that its UA shows up and that no `views` row is created.

# DEFINITION OF DONE
- A: a workflow_dispatch run on the PR branch is green, with the report artifact and the job summary; one forced
  failure (a test-only branch) opens the issue, and the next green run closes it. Links in the PR.
- B: 3 consecutive green scheduled runs (links), one simulated failure (a wrong URL on a test branch) opening the
  issue, the masked secrets visible as `***` in the logs, and the nginx log line with `WinkeySynthetic/1.0`.
- actionlint/yamllint green. The PR body is the Handoff Report with real outputs.
````
