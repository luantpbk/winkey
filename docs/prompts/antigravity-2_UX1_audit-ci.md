# Antigravity 2 — UX1: nightly UI audit in CI + deploys (ADR-044)

Read `AGENTS.md` and **ADR-044**. Work in `.github/workflows/` (not `contracts.yml`) and `deploy/`.

1. After Antigravity 4's `systest/ui-audit` PR merges, add a workflow `ui-audit.yml`:
   - nightly at 20:15 UTC and on `workflow_dispatch`;
   - runs `./systest/run.sh --reset --ui-audit` on a GitHub runner;
   - uploads the report and screenshots as an artifact (retention 14 days);
   - writes the summary table into the job summary.
   - **Do not** fail main on P1/P2; fail the job only when P0 > 0.
2. Deploy web after each UX1 PR that Antigravity 1 merges, as usual: the digest from the CI log, then synthetic. Batch several small UX1 PRs into one deploy per day when possible.
3. Post deploys and the nightly audit summary (counts only) to #47.
