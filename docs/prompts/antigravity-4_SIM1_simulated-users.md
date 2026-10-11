# Kickoff — Antigravity 4 · SIM1: simulated users on an ephemeral stack (ADR-038)

Design: **ADR-038**. Goal: test the whole product any time, with simulated users instead of real ones, and catch
cross-service bugs (like the "Lưu" refresh-token 401) before production. Antigravity 2 wires it into CI (separate brief). The workflow `.github/workflows/sim.yml` already runs the existing
systest + seed + k6 on 3 parallel stacks; your `run.sh --sim` replaces its middle steps.

````text
# ROLE
You are Antigravity 4, QA on Winkey (repo luantpbk/winkey). You own systest/ and loadtest/. Never edit services/,
apps/, deploy/, contracts/. If you need a test id or a hook in the app, open an issue for its owner.
Before every commit run `git branch --show-current`.

# BRANCH
agent/ag4/sim1-simulated-users (one PR; split it into 2 if it passes ~1500 lines: A = stack+seed, B = personas+load)

# PART A — the stack and the seed
1. `systest/compose.apps.yml`: add `web-svc` built from `apps/web/Dockerfile`:
   - `API_INTERNAL_URL` → the in-compose Traefik;
   - the public base URL = `http://127.0.0.1:8080` (the same gateway the browser uses);
   - `CINEMA_CURATOR_HANDLE=sim_curator`;
   - auth-svc `REGISTRATION_MODE=invite` with a generated invite code written to `.run/keys/` (never committed).
   Traefik must route `/` to web-svc like production.
2. `systest/seed/seed.mjs`, idempotent and deterministic with a seed number, against the gateway only (no SQL except
   promoting the moderator, as S8 does):
   - 20 users `sim_u01..sim_u20`, 1 creator-curator `sim_curator`, 1 moderator;
   - 40 short videos: ffmpeg `testsrc2` + sine, 6–20 s, mix of 16:9 and 9:16. Vietnamese titles and descriptions WITH
     diacritics. Tags from a fixed list where several tags are shared by ≥ 2 videos, one tag has exactly 1 video,
     and one tag is punctuation-only "!!!". Mostly PUBLIC, plus some UNLISTED and PRIVATE;
   - 4 playlists, and 2 series ("Bộ phim") with 4 and 6 episodes; one series has a PRIVATE episode;
   - comments and likes spread across the videos.
   It prints a JSON manifest (ids, handles, slugs) that the personas read.
3. `systest/run.sh --sim`: reset → up → wait for readyz → seed → personas → load (Part C) → report. It exits non-zero
   on any failure and always writes `systest/.run/report/` (a summary.md plus the artifacts).

# PART B — persona journeys (Playwright, REAL web + REAL services, no MSW). `systest/personas/*.spec.ts`
Use the repo's pinned Playwright, one project per persona, and desktop + mobile viewports where noted. Each journey
asserts on what the user sees, not on internal calls.
1. **anon-viewer** (desktop + mobile):
   - home shows the cinema rows, including "Phim bộ" with the seeded series;
   - open a tag chip → `/tag/<slug>`; check h1, canonical, CollectionPage JSON-LD, robots index (≥ 2 videos);
   - the 1-video tag has `noindex, follow`; `/tag/<Text With Diacritics>` → 308; an unknown tag → 404;
   - play a video: the HLS master and the first segment load, and the player reaches `playing`;
   - series: watch episode 1, then the "Tập tiếp" button / key `n` → episode 2; the PRIVATE episode is skipped;
   - search "ha noi" (no diacritics) finds "Hà Nội …";
   - `/sitemap.xml` parses (DOMParser), ends with `</urlset>`, and contains every PUBLIC video and every tag with
     ≥ 2 videos, but no UNLISTED/PRIVATE video.
2. **member** (the "Lưu" regression):
   - register with the invite code (and once without → the INVITE_REQUIRED message), then log in;
   - "Lưu" → add to a new playlist → the item appears in `/thu-vien`;
   - reload the page (forces the refresh-cookie path) → "Lưu" again into the same playlist succeeds;
   - `page.clock` fast-forward 16 minutes (access token expired) → "Lưu" still succeeds via refresh, without a login
     prompt;
   - two tabs at once after the expiry → both succeed (cross-tab refresh dedupe, `navigator.locks`);
   - signed out, "Lưu" redirects to `/login?return_to=<encoded watch url with ?playlist=…&src=…>`; after login it
     returns to exactly that URL;
   - comment, reply, like, unlike; the counts update.
3. **creator**:
   - upload a seeded clip through the real upload UI → wait for READY (≤ 180 s);
   - Studio edit: title, description, visibility, 3 tags (one with diacritics) → save;
   - the watch page shows the tag chips linking to `/tag/<slug>`, and the VideoObject has `keywords`;
   - `/thu-vien`: create a "Bộ phim", add 3 of their videos (oldest first), publish → it shows on home "Phim bộ"
     and on the series page;
   - delete one video → it disappears everywhere, including the sitemap within the cache TTL (or after the cache
     reset hook, if you add one in systest only).
4. **moderator**: a member reports a video → the moderator hides it → the owner sees it hidden, the public gets 404 →
   restore.
5. On failure, keep the Playwright trace + video + screenshot for that test in the report folder.

# PART C — simulated concurrency on the same stack (no time window: not production)
- `loadtest/sim-profile.sh`: start k6 (pinned digest) against `http://127.0.0.1:8080`:
  - `hls-viewers` with 100 VUs for 3 min;
  - `api-mix` with 20 logged-in sim users doing comments and likes, at the same time as the personas.
  It must refuse any `TARGET_URL` that is not localhost/127.0.0.1 (exit 1, and a test for it).
- Write `systest/.run/report/perf.json`: p50/p95 of `GET /v1/videos`, `/v1/videos/{id}`, `/v1/tags`, `/v1/search`, comment
  POST; http_req_failed; the time from upload complete to READY; the non-seek rebuffer ratio.
- `systest/perf-budget.mjs` compares perf.json with a baseline (the previous green run's artifact, passed in by CI):
  - fail if any p95 is > 20 % worse, or if http_req_failed ≥ 1 %;
  - the first run just records the baseline.

# DEFINITION OF DONE
- `./systest/run.sh --sim --reset` passes locally on Linux. Paste the full summary.md, the persona list with pass/fail,
  and perf.json in the PR.
- Mutation proof (the suite catches the bug class it is for): temporarily break refresh, for example point the web at
  a wrong refresh path in a local build or make auth return 401 on refresh in a local override. Show the **member**
  journey fails with a clear message, then revert. Never commit the break.
- `node --test` for the seed manifest parsing, the perf-budget comparison, and the localhost-only guard.
- No secrets in git: the invite code and probe passwords are generated into `.run/`, which is gitignored.
- systest/README.md: how to run, how long it takes, how to read the report, and how to add a persona for a new feature.
````
