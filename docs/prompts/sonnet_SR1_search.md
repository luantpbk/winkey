# Kickoff — Sonnet 5.5 · Task SR1 (video search in video-svc)

Starts after S4 (#71, merged). Contract (`searchVideos`, `suggestSearch` in video.v1.yaml) and migration
000007_search are on main.

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-sr1 -b agent/sonnet/sr1-search origin/main
READ FIRST: contracts/openapi/video.v1.yaml (tag `search`: searchVideos, suggestSearch, SearchSuggestions),
db/migrations/000007_search.up.sql (public.winkey_fold, media.videos.search_vector, the two partial GIN
indexes) and db/tests/005_search.sql, services/video (feed SQL, visibility rules incl. S4 moderation,
cursor package, rate limiter and TRUST_PROXY_CIDRS from C3, contract Spec.Check).
You own: services/video, libs/go. Branch: agent/sonnet/sr1-search.

# TASK SR1 — implement exactly
- GET /v1/search?q=…: fold q with the SAME function in SQL (`public.winkey_fold($1)`), never in Go, so the
  index expression matches. Primary: `search_vector @@ plainto_tsquery('simple', winkey_fold($1))`, ranked by
  ts_rank_cd; fallback only when the primary returns no row on the FIRST page: `winkey_fold(title) % winkey_fold($1)`
  ranked by similarity (set `pg_trgm.similarity_threshold = 0.3` per transaction, SET LOCAL).
  Every query keeps the partial-index predicate literally (status = 'READY' AND visibility = 'PUBLIC' AND
  moderation_state = 'VISIBLE') so the planner uses videos_search_fts / videos_search_title_trgm, and joins
  auth.public_profiles (owner active) exactly like the feed. Response = VideoPage of VideoSummary.
- Cursor: opaque, encodes (mode fts|trgm, rank, published_at, id) for keyset paging on
  (rank DESC, published_at DESC, id DESC); max 10 pages then next_cursor = null. A cursor from another q → 400.
- GET /v1/search/suggest?q=…: ≤ 8 distinct titles, prefix match on winkey_fold(title) first, then trigram
  similarity; public videos only.
- Rate limits per client IP (reuse the C3 limiter + TRUST_PROXY_CIDRS): 60/min search, 120/min suggest → 429
  with Retry-After. Cache-Control public max-age=30 (search) / 60 (suggest). No auth dependence in results.
- Metrics: search requests by mode (fts, trgm, empty), latency histogram. Log q length only, never q itself.
- EXPLAIN check: add a test that runs EXPLAIN (FORMAT JSON) for both queries on seeded data and asserts the
  partial index is used (Bitmap Index Scan on videos_search_fts / videos_search_title_trgm) — this guards the
  folding and predicate from drifting.

# DEFINITION OF DONE
- Tests on real PostgreSQL 17 + Valkey (testkit, WINKEY_REQUIRE_DOCKER=1): Vietnamese folding ("ha noi" finds
  "Hà Nội", "Đà Lạt"/"da lat"), title outranks description, typo fallback, hidden/private/unlisted/not-ready/
  owner-inactive videos never returned, keyset paging stable with equal ranks, 10-page cap, cursor/q mismatch
  400, empty/too long q 400, suggest ≤ 8 and distinct, rate limits, EXPLAIN index usage.
- Contract Spec.Check on every response (race-safe); go vet, golangci-lint, go test -race; arm64 cross-build.
- README updated. PR description = Handoff Report with real test output (show the suites really ran).

# OUT OF SCOPE
- Web search page (Antigravity 1). Gateway route /v1/search (Antigravity 2, I2). Any contract/migration change
  (open a `contract-change` issue).
````
