# Kickoff — Sonnet 2 · Task UQ1 (hạn mức upload trong upload-svc)

Design: ADR-027. Contract: the "Quotas" paragraph and the `429` response of `createUpload` in
contracts/openapi/upload.v1.yaml. No migration (index `videos_owner_created` already exists).

````text
# ROLE
You are "Sonnet 2", a Go engineer on "Winkey" (repo luantpbk/winkey). You own services/upload and services/transcoder.
Never edit contracts/, db/, deploy/, .github/, libs/go (ask Sonnet through an issue). Read AGENTS.md first.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet2-uq1 -b agent/sonnet2/uq1-upload-quotas origin/main
Before every commit: `git branch --show-current` must print agent/sonnet2/uq1-upload-quotas.
READ FIRST: ADR-027, upload.v1.yaml (description + createUpload), services/upload/internal/{api,store,domain,config}.

# TASK
1. Config, each with range validation, in the README env table and .env.example:
   - `UPLOAD_MAX_CONCURRENT` (default 3, 1..50);
   - `UPLOAD_DAILY_COUNT` (default 20, 1..10000);
   - `UPLOAD_DAILY_BYTES` (default 53687091200, ≥ 20 GiB so one max-size file always fits).
2. In the transaction that inserts the video row in createUpload:
   - take `pg_advisory_xact_lock(hashtextextended('upload-quota:' || owner_id, 0))`;
   - run ONE query over `media.videos WHERE owner_id = $1 AND created_at > now() - interval '24 hours'` returning
     the count, the sum of size_bytes, the count with `status = 'UPLOADING'`, and min(created_at);
   - then compare. The UPLOADING count must also cover rows older than 24 h (separate predicate or second
     aggregate in the same query).
   - Callers whose `X-User-Roles` contains `admin` skip the check.
   - Refuse BEFORE calling S3 CreateMultipartUpload. Concretely: check and insert in one tx, and only create the
     multipart upload after the check passes. Keep the existing ordering guarantees; describe them in the PR.
3. `429` problem: `code = UPLOAD_QUOTA_EXCEEDED`, `detail` names the limit (`concurrent`, `daily_count`, `daily_bytes`)
   with its value, and `Retry-After`:
   - daily limits: `ceil(min(created_at) + 24h - now())` seconds, ≥ 1;
   - concurrent: 60.
   Metric `upload_quota_rejections_total{limit}`. Log at info: owner_id, limit (no title/filename).
4. README: a "Quotas" section.

# DEFINITION OF DONE
- Unit tests: the decision function (each limit, the boundary exactly at the limit, the new upload's own bytes
  counted, admin bypass, Retry-After maths) and config parsing.
- Integration (testcontainers PG + MinIO/Garage as the existing tests, WINKEY_REQUIRE_DOCKER=1, 0 skipped):
  1. Cases:
     - 3 open uploads → the 4th is 429 concurrent; completing one lets the next pass;
     - 20 in 24 h (seed rows with created_at in the past, including deleted/failed ones) → 429 daily_count;
     - bytes over the limit → 429 daily_bytes;
     - a row 24h+1s old does not count;
     - admin passes.
  2. Race: 10 concurrent createUpload calls with limit 3 create exactly 3 rows.
  3. A refused call creates no S3 multipart upload (list them).
  4. Every response is checked against the contract.
- go vet, golangci-lint, go test -race, amd64/arm64 builds, CI green. Open the PR yourself; Handoff Report with real
  output.

# OUT OF SCOPE
Per-user custom quotas, storage-total quotas, web UI messages (Antigravity 1 later), any contract/migration change.
````
