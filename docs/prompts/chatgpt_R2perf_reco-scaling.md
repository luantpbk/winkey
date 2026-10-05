# Kickoff — ChatGPT · Task R2-perf (bound the cost of recommendations as data grows)

Design: ADR-028 and its "Bổ sung R2-perf" addendum in docs/DECISIONS.md. Two small PRs, any order. No contract or
migration change.

````text
# ROLE
You are "ChatGPT", acting owner of services/video, services/analytics and libs/go on Winkey (repo luantpbk/winkey).
Read AGENTS.md, ADR-028 (with the R2-perf addendum) and ADR-030. Never edit contracts/, db/, deploy/.

# PR 1 — analytics-worker: cap qualified videos per viewer before the co-view self-join
Branch: agent/gpt/r2perf-coview-cap
1. Config RECO_COVIEW_MAX_PER_VIEWER (default 200, 10..5000), validated, README env table.
2. In the co-view SQL, keep only each viewer's N most recent qualified videos (by max(received_at), ties video_id)
   BEFORE the self-join; compute viewers(v) on that capped set. History (viewer_history) is unchanged.
3. Metric analytics_reco_viewers_capped_total (viewers whose qualified set was truncated in the last run).
4. Tests (integration, ClickHouse 25.8 AND 26.9): a viewer with N+5 qualified videos contributes only their N most
   recent to pairs; pairs among other viewers are unchanged; exact expected rows.

# PR 2 — video-svc: bound the candidate list before diversity
Branch: agent/gpt/r2perf-candidate-limit
1. Config RECO_CANDIDATE_LIMIT (default 2000, 200..20000), validated, README env table.
2. The candidate SQL returns at most RECO_CANDIDATE_LIMIT rows in the exact ADR-028 order (final DESC,
   published_at DESC, id DESC), newest-fill included in that order; then DiversifyRecommended and the 200 cap run as
   today. The control arm (ADR-030) is bounded the same way.
3. Tests: a catalogue larger than the limit returns the same first 200 as an unbounded run when the limit is ≥ the
   number of items needed for diversity (hand-built fixture); EXPLAIN shows the LIMIT is applied in the query (paste it);
   existing ranking/diversity/A-B tests stay green.

DoD for both: go vet, golangci-lint, go test ./... green; README; PR with real outputs (Handoff Report). Lint-only
cleanups in a separate PR. Never merge.
````
