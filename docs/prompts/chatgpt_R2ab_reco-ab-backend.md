# Kickoff — ChatGPT · Task R2-ab (surface + A/B of the recommended feed: worker then video-svc)

Design: ADR-030 in docs/DECISIONS.md. Contracts (merged by the architect): `PlaybackSample.surface` in
contracts/openapi/video.v1.yaml; `surface` and `reco_variant` in contracts/events/analytics.playback.schema.json;
ClickHouse `db/clickhouse/0002_reco_ab.sql`. Two PRs, in this order: **R2-ab-w** (analytics-worker) then **R2-ab-v**
(video-svc). The worker must be deployed before video-svc starts sending the new fields.

````text
# ROLE
You are "ChatGPT", acting owner of services/video, services/analytics and libs/go on Winkey (repo luantpbk/winkey).
Read AGENTS.md, ADR-022 (all addenda), ADR-028 and ADR-030. Never edit contracts/, db/, deploy/.

# PART A — R2-ab-w: analytics-worker accepts and stores the new fields
Worktree: git worktree add ../winkey-gpt-r2abw -b agent/gpt/r2ab-w-worker-fields origin/main
1. internal/event: decode the optional `surface` (enum per the schema, or null/absent) and `reco_variant`
   ("reco" | "control" | null/absent); any other value → Malformed (Term), like the other fields. Keep
   DisallowUnknownFields.
2. Insert both columns (Nullable) in the same single INSERT; keep the dedup token and the #193 reconciliation exactly.
3. The worker already applies db/clickhouse/*.sql at start-up; make sure 0002 applies on 25.8 and 26.9 and that the
   reco_ab_daily materialized view fills (integration test: signed-in samples with a variant land in reco_ab_daily;
   anonymous or variant-null samples do not; a retried batch does not double the sums).
4. Tests: unit (decode valid/invalid/absent values) + integration as above. DoD: vet, golangci-lint, go test ./...
   green; README updated; PR with real outputs. Lint-only cleanups in a separate PR.

# PART B — R2-ab-v: video-svc assigns the arm, applies it to the feed and records it
Worktree: git worktree add ../winkey-gpt-r2abv -b agent/gpt/r2ab-v-assignment origin/main
1. Config: RECO_AB_ENABLED (default true), RECO_AB_SEED (default "r2ab-1"), RECO_AB_TREATMENT_PERCENT (0..100,
   default 50); validated; README env table.
2. One function `Variant(seed, percent, userID) string` exactly as ADR-030 (first 8 bytes of SHA-256(seed+":"+id),
   big-endian uint64, mod 100). Unit test with fixed vectors and a distribution check (10 000 random ids at 50 % →
   between 48 % and 52 % reco).
3. getRecommendedFeed: signed-in `control` → s_c = s_s = 0 (trending then newest) with the SAME exclusions, diversity
   and pagination; `reco` → unchanged. The Valkey list cache key must include the arm (a seed/percent change must not
   serve the other arm's cached list). Metric video_reco_requests_total gains label `variant` (reco|control|none).
4. recordPlaybackHeartbeats: accept `surface` (contract enum), copy it into the event; for signed-in callers set
   `reco_variant` with the SAME Variant function (null when RECO_AB_ENABLED=false or anonymous). Never log user ids.
5. Tests: integration — a control user gets the anonymous-style ranking but still without own/watched videos; a reco
   user gets the personal ranking; the heartbeat event carries surface and the same arm the feed used; invalid surface
   → 400 per the contract; responses validate against the contract checker.
DoD: vet, golangci-lint, go test ./... green; README; PR with real outputs. Do not merge; tell the user that R2-ab-v
must be deployed only after R2-ab-w is live.
````
