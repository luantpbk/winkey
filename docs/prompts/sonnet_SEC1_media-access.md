# Kickoff — SEC1 (block media of non-public videos) · ADR-017

Two parts. **SEC1-a** (Sonnet, video-svc) starts now. **SEC1-b** (Antigravity 2, nginx + Traefik on edge-1)
comes after I2. The contract (`mediaAccess`, `Playback.expires_at`, the signed URL format in video.v1.yaml)
and ADR-017 are on main.

## SEC1-a — Sonnet 5.5 · video-svc

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-sec1 -b agent/sonnet/sec1-media-access origin/main
READ FIRST: docs/DECISIONS.md ADR-017 (and ADR-014, ADR-016), contracts/openapi/video.v1.yaml (info.description
"Task SEC1", tag `internal`, `mediaAccess`, `Playback.expires_at`), services/video (models.go mediaURL, the
visibility rules of getVideo/studio, moderation from S4, config, contract Spec.Check).
You own: services/video, libs/go. Branch: agent/sonnet/sec1-media-access.

# TASK SEC1-a — implement exactly
1. Config `MEDIA_LINK_SECRET` (required in production, ≥ 32 bytes; tests use a fixed value). Never log it.
2. Signed media URLs. A video is "publicly watchable" when READY AND visibility IN (PUBLIC, UNLISTED) AND
   moderation_state = VISIBLE AND the owner is in auth.public_profiles. For every response that carries
   `playback` for a video that is NOT publicly watchable (owner, moderator or admin viewing it; studio), build
   hls_url and thumbnail_url as
     MEDIA_BASE_URL + "s/" + expires + "/" + sig + "/" + key
   with expires = now + 6h (Unix seconds) and
     sig = base64.RawURLEncoding(md5(expires + "/v/" + video_id + "/ " + MEDIA_LINK_SECRET))
   (exactly nginx `secure_link_md5 "$secure_link_expires/v/$vid/ $media_link_secret"`), and set
   playback.expires_at. Publicly watchable videos keep plain URLs and no expires_at (their responses stay
   cacheable). One function, one golden test with a fixed secret/time/id/expected sig.
3. GET /internal/media-access/{video_id} (mediaAccess): 204 when publicly watchable, 403 otherwise, including
   unknown ids; 400 for a malformed id. One primary-key query joined to auth.public_profiles, no body,
   `Cache-Control: max-age=30` on 204 and 403. Mount it on the same router but outside /v1; no auth headers.
   Log at debug only (it is hot). Metric video_media_access_total{result="allow|deny"}.
4. README: the signing scheme, the secret, the internal endpoint and that it must never be routed publicly.

# DEFINITION OF DONE
- Tests on real PostgreSQL 17 (testkit, WINKEY_REQUIRE_DOCKER=1): mediaAccess answers for every row of the
  matrix (READY/PROCESSING × PUBLIC/UNLISTED/PRIVATE × VISIBLE/HIDDEN × owner ACTIVE/SUSPENDED) and unknown id;
  getVideo/studio return signed URLs + expires_at exactly when the video is not publicly watchable; the golden
  signature test; Spec.Check on every response (race-safe).
- go vet, golangci-lint, go test -race; arm64 cross-build. PR description = Handoff Report with real output.

# OUT OF SCOPE
nginx, Traefik, Ansible (SEC1-b). Any contract or migration change → `contract-change` issue.
````

## SEC1-b — Antigravity 2 · nginx + Traefik (after I2)

````text
You own deploy/. Branch agent/ag2/sec1-media-edge from origin/main. Read ADR-017 first.
1. Traefik: an IngressRoute that matches ONLY Host(`media-auth.internal`) && PathPrefix(`/internal/media-access/`)
   → video-svc. No forwardAuth, no public entrypoint change. Every public nginx vhost already overrides Host,
   so clients cannot reach it — keep it that way and add a smoke check for it.
2. nginx vhost media.winkey.vn (Ansible template; secret from vault/env as `media_link_secret`, never in git):
   location ~ ^/s/(?<exp>\d+)/(?<sig>[A-Za-z0-9_-]+)/(?<path>v/(?<vid>[0-9a-f-]{36})/.+)$ {
       secure_link $sig,$exp;
       secure_link_md5 "$exp/v/$vid/ $media_link_secret";
       if ($secure_link = "")  { return 403; }
       if ($secure_link = "0") { return 410; }
       rewrite ^ /$path break;       # then the same proxy/cache settings as the plain location
   }
   location ~ ^/v/(?<vid>[0-9a-f-]{36})/ {
       auth_request /_media_access;   # + existing proxy_pass / proxy_cache settings
   }
   location = /_media_access {
       internal;
       proxy_pass http://winkey_traefik/internal/media-access/$vid;
       proxy_set_header Host media-auth.internal;
       proxy_pass_request_body off; proxy_set_header Content-Length "";
       proxy_cache winkey_media_auth; proxy_cache_key $vid; proxy_cache_valid 204 403 30s;
   }
   Anything else under media.winkey.vn → 404 (keeps /v/smoke/… only if the smoke test is updated to use a
   real public video id or a signed URL).
3. Smoke test (run from outside edge-1, paste output):
   - a PUBLIC READY video: 200 on the plain URL;
   - the same video after setting it PRIVATE: 403 on the plain URL within 30 s;
   - a signed URL from getVideo as the owner: 200;
   - an expired signed URL: 410;
   - a tampered sig: 403;
   - curl -H 'Host: media-auth.internal' https://winkey.vn/internal/media-access/<id>: must NOT return 204.
````
