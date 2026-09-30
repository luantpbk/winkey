# Kickoff — Antigravity 4 · Task LT1 (load test harness for the P2 exit criterion)

Starts after QA1 is merged. P2 Beta is done only when **1,000 concurrent viewers play with rebuffering < 1 %**
(docs/ROADMAP.md). LT1 builds and calibrates the harness locally. The real run against edge-1 happens only
after I2 + SEC1-b are live and the user has approved the time window (it loads a production VPS).

````text
# ROLE
You are the QA / performance engineer on "Winkey" (Linux + Docker). The architect reviews and merges.

# REPO
git worktree add ../winkey-ag4-lt1 -b agent/ag4/lt1-load-test origin/main
You own: loadtest/ (new) and systest/. Use k6 through the grafana/k6 Docker image (pinned by digest); nothing
installed on the host.

# TASK LT1
1. loadtest/hls-viewers.js — each VU is one viewer:
   - GET the watch API → master.m3u8, then pick a rendition like a player: start at the middle one, move up or down
     on measured throughput;
   - fetch the segments at real-time pace, keeping a ~10 s buffer;
   - a STALL = the buffer reaches 0; rebuffer ratio = stall time / watch time;
   - watch time 2–5 min, random seek 10 % of sessions, 20 % of viewers on the same "hot" video;
   - thresholds: rebuffer ratio p95 < 1 %, startup (first segment) p75 < 2 s, HTTP error rate < 0.5 %.
2. loadtest/api-mix.js — the browsing traffic around the viewers: 70 % feed/watch/search reads, 25 % like/comment
   reads, 5 % writes (comment, like) with real registered users; respects the rate limits, never hammers auth.
3. loadtest/seed.sh — prepares N READY videos and M users through the public API (reuses systest helpers).
4. Calibrate on the local systest stack at 50 and 200 viewers. Report CPU/RAM of every container
   (docker stats) and the first bottleneck you see.
5. loadtest/README.md: how to run locally; how to run against a target URL; safety (a ramp-up profile;
   abort on error rate > 5 %; NEVER run against winkey.vn without the architect's go-ahead in the PR/issue).

# DEFINITION OF DONE
Local runs at 50 and 200 viewers with k6 summaries + docker stats pasted in the PR; thresholds evaluated;
bottleneck notes. Handoff Report. The 1,000-viewer run on edge-1 is a follow-up (LT2), scheduled with the user.
````
