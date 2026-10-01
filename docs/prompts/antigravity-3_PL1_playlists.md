# Kickoff — Antigravity 3 · Task PL1 (playlists + watch later in social-svc)

Starts after N2 (#136, merged). Design: ADR-024. Contract on main: tag `playlists` in contracts/openapi/social.v1.yaml
(`createPlaylist`, `getPlaylist`, `updatePlaylist`, `deletePlaylist`, `listPlaylistItems`, `addPlaylistItem`,
`removePlaylistItem`, `movePlaylistItem`, `listChannelPlaylists`, `getWatchLater`, `getPlaylistMembership`). Migration 000014 (tested in
db/tests/012_playlists.sql). Gateway routes: Antigravity 2. Web: Antigravity 1. `batchGetVideos`: Sonnet.

````text
# ROLE
You are the Node/TypeScript engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-pl1 -b agent/ag3/pl1-playlists origin/main
READ FIRST: docs/DECISIONS.md ADR-024 (+ ADR-007, the C4 visibility rules), contracts/openapi/social.v1.yaml (tag
`playlists`, every description: limits, error codes, idempotency, visibility), db/migrations/000014_playlists.up.sql
(CHECKs, deferrable unique position, the item_count trigger).
You own: services/social, packages/*. Never edit contracts/, db/, deploy/.
First: `pnpm --filter @winkey/api-client run generate`; add both tables to the Kysely types.

# TASK PL1 — build (services/social)
1. Routes exactly per contract (strict body validation, problem+json codes named in the contract:
   PLAYLIST_LIMIT, PLAYLIST_FULL, WATCH_LATER_IMMUTABLE, VIDEO_NOT_FOUND; 404 for anything the caller may not see).
   - Visibility: PRIVATE / WATCH_LATER → owner only (404 otherwise, never 403); UNLISTED/PUBLIC readable by anyone.
   - Items filter at read time: join social.videos; hide `hidden` or `PRIVATE` videos unless the caller owns the video.
   - addPlaylistItem: the video must be readable by the caller now (same rule); idempotent 200 vs 201; append at
     `COALESCE(max(position),0) + 2^20` inside the transaction with `SELECT … FOR UPDATE` on the playlist row
     (serialises concurrent appends); map the item_count CHECK violation to 409 PLAYLIST_FULL.
   - createPlaylist: count the owner's playlists in the same transaction (FOR UPDATE on a per-owner advisory lock:
     `pg_advisory_xact_lock(hashtext('playlists:'||owner))`) → 409 PLAYLIST_LIMIT at 200.
   - movePlaylistItem: new position = midpoint of the neighbours (or last + 2^20 for null); if no integer gap,
     `SET CONSTRAINTS social.playlist_items_position DEFERRED` and renumber the whole playlist (step 2^20) in the same
     transaction, then place the item. Moving before itself = no-op 200.
   - getWatchLater: `INSERT … (kind='WATCH_LATER', title='Xem sau', visibility='PRIVATE') ON CONFLICT DO NOTHING`
     then SELECT; counts toward the 200 limit only if it fits (never fail getWatchLater on the limit).
   - listChannelPlaylists: owner sees all (watch-later first, then updated_at DESC, id DESC); others only PUBLIC.
     Keyset cursor on (updated_at, id) — µs precision like N1's cursor.
   - getPlaylistMembership: `SELECT playlist_id FROM playlist_items JOIN playlists … WHERE owner_id = caller AND
     video_id = $1` (uses playlist_items_video).
   - listPlaylistItems: keyset on position ASC. `Cache-Control: private, no-store` on every playlist response.
2. Rate limits per contract (create 30/min/user, add 120/min/user) with the existing limiter.
3. Metrics: `social_playlist_items_added_total`, `social_playlist_renumbers_total`.
4. README (endpoints, limits) + .env.example if any new env.

# DEFINITION OF DONE
- Integration tests (testcontainers PG, WINKEY_REQUIRE_DOCKER=1, 0 skipped), every response contract-checked:
  CRUD + ownership (other user → 404 on get of PRIVATE, 404 on update/delete); UNLISTED readable by link but absent
  from listChannelPlaylists; watch-later created once under 20 concurrent getWatchLater calls, cannot be
  updated/deleted (409), is PRIVATE; add idempotent (200 on repeat, position unchanged); unreadable video → 404;
  hidden/PRIVATE video filtered from items for others but shown to its owner; video.deleted cascade (via the existing
  projection consumer) removes items and fixes item_count; 20 concurrent appends → 20 distinct positions in call
  order-independent but gap-free-of-duplicates; move to front/middle/end; forced renumber (insert positions 1,2,3 by
  SQL, move between 1 and 2) keeps order; 5 000 cap → 409 PLAYLIST_FULL; 200 playlists → 409; cursor walk 45 items
  limit 20 = 20/20/5.
- `pnpm --filter @winkey/social run lint && typecheck && test && build`, root lint + format:check, CI green, the new
  test files 10× in a row. Open the PR yourself; description = Handoff Report with real outputs + curl of each
  endpoint against `make dev`. No BOM in files.

# OUT OF SCOPE
Web (Antigravity 1), gateway (Antigravity 2), batchGetVideos (Sonnet), events, collaborative/saved playlists.
````
