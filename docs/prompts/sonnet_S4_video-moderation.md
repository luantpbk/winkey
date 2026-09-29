# Kickoff — Sonnet 5.5 · Task S4 (video moderation in video-svc)

Part of A2 (ADR-016). Contract, migration 000006 and the `video.moderated` event are on main.

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-s4 -b agent/sonnet/s4-video-moderation origin/main
READ FIRST: docs/DECISIONS.md ADR-016 (+ ADR-008 outbox), db/migrations/000006_moderation.up.sql (media part),
contracts/openapi/video.v1.yaml (info.description "Task A2 — moderation", operation moderateVideo,
schemas VideoModeration / ModerateVideoRequest, the optional `moderation` field on Video and StudioVideo),
contracts/events/video.moderated.schema.json + examples/video.moderated.json.
You own: services/video, libs/go. Branch: agent/sonnet/s4-video-moderation.

# TASK S4 — implement exactly
- PUT /v1/videos/{video_id}/moderation: X-User-Roles must contain moderator or admin (403 otherwise);
  HIDDEN requires reason (400 problem+json); VISIBLE clears reason. Same state again → 200, no event.
  Row update (moderation_state/reason/moderated_by/moderated_at) + video.moderated outbox row in ONE
  transaction (ADR-008). Returns Video with `moderation`.
- Read rules: HIDDEN = PRIVATE for everyone except owner, moderator, admin → 404 on getVideo, excluded from
  every feed/list (listVideos, owner feed), recordView answers 202 {counted:false} (the video is not readable).
  `moderation` appears on Video/StudioVideo ONLY for owner/moderator/admin; never for anyone else.
- Cache: invalidate the video's cached entries on change (or show why CACHE_TTL is enough); a hidden video
  must not stay publicly cached (Cache-Control private for HIDDEN).
- Moderators/admins can still GET hidden videos (so the moderation UI can review them).

# DEFINITION OF DONE
- Tests on real PostgreSQL + NATS (testkit; WINKEY_REQUIRE_DOCKER=1): role matrix (anon, viewer, owner,
  moderator, admin × VISIBLE/HIDDEN), no-op sets emit nothing, outbox row matches video.moderated schema,
  hidden video absent from feeds and 404 for others, `moderation` field presence rules, contract Spec.Check on
  every new response (race-safe, as in #52).
- go vet, golangci-lint (repo config), go test -race for services/video; cross-build linux/arm64.
- README updated. PR description = Handoff Report with real test output (show the suite really ran).

# OUT OF SCOPE
- social-svc projection of video.moderated and reports (Antigravity 3, A2). Web UI (Antigravity 1, U4).
- Signed media cookies (SEC1). Any contract/migration change (open a `contract-change` issue).
````
