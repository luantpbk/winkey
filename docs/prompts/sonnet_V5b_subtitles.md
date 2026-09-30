# Kickoff — Sonnet 5.5 · Task V5b (WebVTT subtitles uploaded by the owner)

Starts after C4-b (#87, merged). ADR-018, migration 000010 (`media.video_subtitles`) and the contract
(`putSubtitle`, `deleteSubtitle`, `SubtitleTrack`, `Playback.subtitles`) are on main. Auto-captions are V5c (not now).

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-v5b -b agent/sonnet/v5b-subtitles origin/main
READ FIRST: docs/DECISIONS.md ADR-018 (and ADR-017), db/migrations/000010_subtitles.up.sql, contracts/openapi/
video.v1.yaml (info "Task V5b", tag `subtitles`, putSubtitle, deleteSubtitle, SubtitleTrack, PutSubtitleRequest,
Playback.subtitles), services/video (models.go playback + signMediaURL, the visibility rules of getVideo/updateVideo,
the storage client used by the delete path), services/transcoder (Cache-Control of immutable outputs).
You own: services/video, libs/go. Branch: agent/sonnet/v5b-subtitles.

# TASK V5b — implement exactly
1. putSubtitle (PUT /v1/videos/{video_id}/subtitles/{lang}):
   - auth like updateVideo: owner only (403 for a visible video the caller does not own, moderators/admins
     included; 404 when the caller may not see it or it does not exist); status FAILED → 409.
   - validate `lang` (pattern), `label`, then `content` with a small WebVTT validator in its own package
     (pure function, table-tested): size ≤ 524288 bytes (else 400 SUBTITLE_TOO_LARGE); valid UTF-8, no NUL;
     optional BOM then first line `WEBVTT` alone or followed by space/tab + text; blocks separated by blank
     lines; NOTE/STYLE/REGION blocks allowed; a cue = optional identifier line, then a timing line
     `[HH:]MM:SS.mmm --> [HH:]MM:SS.mmm[ settings]` with MM/SS < 60 and end > start, then ≥ 0 text lines;
     at least one cue. Errors → 400 INVALID_WEBVTT, `detail` = "line N: reason". Normalise: drop BOM,
     CRLF/CR → LF, ensure a trailing newline.
   - upload the normalised bytes to the media bucket at v/{video_id}/subtitles/{lang}-{uuidv7}.vtt with
     Content-Type `text/vtt; charset=utf-8` and the SAME Cache-Control as the transcoder's immutable outputs;
     THEN in one transaction upsert the row (INSERT … ON CONFLICT (video_id, lang) DO UPDATE, returning whether
     it was an insert) with the 20-track limit checked under a lock on the video row (SELECT … FOR UPDATE):
     a 21st language → 409 TOO_MANY_SUBTITLES (replacing an existing language is always allowed).
     If the transaction fails, delete the object you just uploaded (best effort). After the commit, delete the
     previous object of that language (best effort, warn log with video id + key, never fail the request).
   - 201 on create, 200 on replace, body = SubtitleTrack (url signed exactly like hls_url when the video is
     not publicly watchable — reuse signMediaURL).
2. deleteSubtitle: owner only; 204; 404 when the track does not exist; delete the row, then the object (best effort).
3. Playback.subtitles: always present (empty array when none), sorted by lang, on every response that carries
   `playback` (getVideo, updateVideo, moderateVideo, studio if it has playback); ONE extra query per request
   (no N+1 on lists — batch by video ids if a list carries playback), signed/plain like hls_url.
4. deleteVideo / media janitor: verify objects under v/{id}/subtitles/ are removed too (test).
5. README: endpoints, limits, validation rules, error codes, object layout.

# DEFINITION OF DONE
- Unit: the WebVTT validator table (valid: minimal file, BOM, CRLF, header text, NOTE/STYLE blocks, cue ids,
  cue settings, hours optional, multi-line text; invalid: missing header, `WEBVTTX`, no cue, bad timing,
  end ≤ start, MM=60, NUL, invalid UTF-8, over the size limit — each with the expected line number).
- Integration (testkit PostgreSQL 17 + Garage, WINKEY_REQUIRE_DOCKER=1, 0 skipped): create 201 → replace 200
  (new key, old object gone, row updated), object content-type/cache-control/normalised body in Garage;
  21st language 409; non-owner 403, moderator 403, invisible 404, anonymous 401, FAILED 409; delete 204 then
  404; Playback.subtitles plain for a public video and signed for a private one; deleting the video removes
  the subtitle objects; Spec.Check on EVERY response.
- go vet, golangci-lint, go test -race, arm64 cross-build, CI green. PR = Handoff Report with real output.

# OUT OF SCOPE
Player / studio UI (Antigravity 1, later), auto-captions (V5c), any contract or migration change
(→ `contract-change` issue).
````
