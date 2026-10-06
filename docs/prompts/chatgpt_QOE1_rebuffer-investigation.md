# Brief — ChatGPT · QOE1: investigate the 2.6 % rebuffer ratio (investigation only)

````text
# ROLE
You are ChatGPT, acting owner of services/video, services/analytics, libs/go, services/transcoder and services/upload on
Winkey. This task is an INVESTIGATION. Do not change code, configs, contracts or production settings. The deliverable
is a written report posted as a new GitHub issue titled "[QOE1] Rebuffer ratio root cause". The architect decides the
fixes and assigns them to their owners. apps/web belongs to Antigravity 1, and deploy/ and nginx belong to
Antigravity 2.

# READ FIRST
- AGENTS.md
- ADR-005 and ADR-017 (media path: nginx gate + proxy_cache), ADR-022 (playback events / ClickHouse), ADR-029
  (observability), ADR-032 (R2 + media-origin, migrated 2026-10-05)
- contracts/events/analytics.playback.schema.json, db/clickhouse/0001_playback.sql (+ video_qoe_hourly MV)
- apps/web/src/lib/video/playback-tracker.ts and apps/web/src/components/video/video-player.tsx (read only; this is
  how rebuffer_ms / rebuffer_count are measured and how hls.js is configured)
- the Grafana "QoE" dashboard: rebuffer_ratio = sum(rebuffer_ms) / (sum(watched_ms) + sum(rebuffer_ms))

# DATA ACCESS (read-only)
- ClickHouse on gpu-01, database winkey, with a READ-ONLY user. The user sets the password on the host with
  `read -rs`. Never paste it, log it or commit it. Do not use the writer account.
- Grafana/Loki, read only, for edge logs if they are shipped. If you need nginx upstream timings from edge-1, ask
  Antigravity 2 on #47 for an export. Do not SSH to edge-1 yourself.

# QUESTIONS TO ANSWER (with the SQL you ran and its real output)
1. Is the 2.6 % real? Report how many playbacks, viewers and videos it comes from, and how many seconds watched.
   Check whether a handful of sessions dominate: give the top 10 playbacks by rebuffer_ms and their share of the
   total. Check whether test traffic (agents' smoke tests, headless browsers, deleted test videos) dominates.
   Recompute the ratio with and without it.
2. Where do stalls happen? Split by:
   - startup vs mid-stream: the first 10 s of position vs later;
   - rendition and bitrate;
   - client;
   - country;
   - video;
   - time of day;
   - **before vs after 2026-10-05**, when media moved from Garage to R2 through media-origin, so nginx cache misses
     now go nginx → Traefik → rclone → R2.
3. Is the measurement correct? Read the tracker. Could the following be counted as rebuffer:
   - seek latency;
   - initial buffering before the first frame;
   - background or hidden tabs;
   - pauses;
   - the `waiting` event fired on quality switches?

   Show evidence (code lines, and event patterns in the data, for example rebuffer that always lands right after a
   seek).
4. Is it delivery?
   - Cache MISS share and upstream time, if logs are available.
   - Segment size vs bitrate ladder (ADR-006: 4 s fMP4).
   - hls.js config: currently defaults except `enableWorker`. Compare startLevel, capLevelToPlayerSize, ABR
     estimates and buffer lengths against what the data shows.

# REPORT FORMAT (the issue body)
- **Verdict:** is the number real, what fraction of it is measurement artefact, and what fraction is real stalls.
- **Top 1–3 root causes,** ranked by share of rebuffer_ms, each with its evidence.
- **Proposed fixes,** each with: owner (Antigravity 1 for player/tracker, Antigravity 2 for nginx/media-origin, you
  for backend), expected impact, and how to verify it on the QoE dashboard.
- **The open questions** you could not answer, and what data would answer them.
Time box: one working session. Stop and report even if some questions stay open. Never merge anything.
````
