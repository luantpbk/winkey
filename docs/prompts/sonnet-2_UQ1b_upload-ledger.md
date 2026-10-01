# Kickoff — Sonnet 2 · Task UQ1-b (sổ ghi upload cho hạn mức ngày)

Design: ADR-027 and its addendum dated 2026-10-01. Migration `000017_upload_ledger` (already on main). No contract change.

````text
# ROLE
You are "Sonnet 2", a Go engineer on "Winkey" (repo luantpbk/winkey). You own services/upload and services/transcoder.
Never edit contracts/, db/, deploy/, .github/, libs/go. Read AGENTS.md first.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet2-uq1b -b agent/sonnet2/uq1b-upload-ledger origin/main
Before every commit: `git branch --show-current` must print agent/sonnet2/uq1b-upload-ledger.
READ FIRST: the ADR-027 addendum, db/migrations/000017_upload_ledger.up.sql, db/tests/015_upload_ledger.sql,
services/upload/internal/{store,janitor}.

# WHY
UQ1 (#161) counts the daily quotas over media.videos. Videos are hard-deleted (video-svc delete, upload abort), so
"upload, delete, upload again" escapes daily_count and daily_bytes. The ledger keeps one row per started upload.

# TASK
1. store.Create: inside the SAME transaction, after the advisory lock and the quota check, and together with the video
   INSERT, insert `media.upload_ledger (video_id, owner_id, size_bytes)` (created_at = default now()).
   - A refusal (429) writes neither row.
   - A failure of S3 CreateMultipartUpload rolls the transaction back, so the ledger row goes too.
   - Admin uploads (quota skipped) are still written to the ledger.
2. The usage query:
   - daily_count, daily_bytes and min(created_at) (for Retry-After) come from `media.upload_ledger WHERE owner_id = $1
     AND created_at > now() - interval '24 hours'` (index upload_ledger_owner_created);
   - concurrent stays `count(*) FROM media.videos WHERE owner_id = $1 AND status = 'UPLOADING'`;
   - keep it ONE round trip (two scalar subqueries in one SELECT are fine).
3. Janitor: each sweep also deletes ledger rows with `created_at < now() - interval '48 hours'`, in batches of at most
   1000 per statement (`DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT 1000)`) until none are left. Log the count.
   Never try to delete younger rows: the DB trigger refuses rows younger than 25 h (restrict_violation).
4. README: one paragraph on the ledger and retention.

# TESTS (integration on the existing testcontainers stack; CI runs them with WINKEY_REQUIRE_DOCKER=1)
- Upload, delete the video row (`DELETE FROM media.videos`), repeat: the 21st createUpload in 24 h is 429 daily_count
  although media.videos has no rows for the owner.
- Same for bytes: 3 × 20 GiB with deletes in between → the third is 429 daily_bytes.
- concurrent: 3 UPLOADING, abort one (row deleted) → the next createUpload is accepted (concurrent frees up) but the
  ledger has 4 rows.
- A refusal writes no ledger row; an S3 failure on CreateMultipartUpload (fake/injected) leaves no ledger row.
- Retry-After uses the oldest ledger row in the window (insert one with created_at = now() - 23 h; expect ~3600).
- Janitor: rows at -49 h are deleted, rows at -26 h and -1 h stay.
- The existing UQ1 tests (race 10 → 3, admin, boundaries) still pass unchanged.

# DONE
PR against main with the Handoff Report. Paste the `go (services/upload)` CI lines showing `internal/integration` and
`internal/store` ran (non-trivial durations) with WINKEY_REQUIRE_DOCKER=1. You have no Docker locally: say so.
````
