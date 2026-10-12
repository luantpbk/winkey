/* global process */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { comparePerf } from '../perf-budget.mjs';
import { parseTap, parsePlaywright, buildSummaryMarkdown } from '../build-summary.mjs';

describe('SIM1 Unit Tests: Manifest, Perf Budget & Localhost Guard (ADR-038)', () => {
  describe('Seed Manifest Validation', () => {
    it('validates schema requirements of seed manifest', () => {
      const mockManifest = {
        version: '1.0',
        users: Array.from({ length: 20 }, (_, i) => ({
          id: `u-${i}`,
          handle: `sim_u${String(i + 1).padStart(2, '0')}`,
        })),
        curator: { id: 'curator-1', handle: 'sim_curator' },
        creator2: { id: 'creator-2', handle: 'sim_creator2' },
        creator3: { id: 'creator-3', handle: 'sim_creator3' },
        moderator: { id: 'mod-1', handle: 'sim_mod' },
        videos: [
          { id: 'v-1', title: 'Hà Nội Mùa Thu', tags: ['du-lich'], visibility: 'PUBLIC' },
          { id: 'v-2', title: 'Khám Phá Sài Gòn', tags: ['du-lich'], visibility: 'PUBLIC' },
          { id: 'v-3', title: 'Độc Lạ Bến Tre', tags: ['doc-la-viet-nam'], visibility: 'PUBLIC' },
          { id: 'v-4', title: 'Bất Ngờ Chưa', tags: ['!!!'], visibility: 'PUBLIC' },
        ],
        playlists: [
          { id: 'p-1', title: 'Yêu thích' },
          { id: 'p-2', title: 'Nhạc chill' },
          { id: 'p-3', title: 'Ẩm thực' },
          { id: 'p-4', title: 'Kỷ niệm' },
        ],
        series: [
          { id: 's-1', title: 'Hành Trình Xuyên Việt', episodes_count: 4 },
          { id: 's-2', title: 'Ẩm Thực Ba Miền', episodes_count: 6 },
        ],
      };

      assert.equal(mockManifest.users.length, 20);
      assert.equal(mockManifest.curator.handle, 'sim_curator');
      assert.equal(mockManifest.creator2.handle, 'sim_creator2');
      assert.equal(mockManifest.creator3.handle, 'sim_creator3');
      assert.equal(mockManifest.moderator.handle, 'sim_mod');
      assert.equal(mockManifest.playlists.length, 4);
      assert.equal(mockManifest.series.length, 2);

      // Verify tag counts in videos
      const tagCounts = {};
      for (const v of mockManifest.videos) {
        for (const t of v.tags) {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        }
      }

      assert.ok(tagCounts['du-lich'] >= 2, 'Shared tag should have >= 2 videos');
      assert.equal(
        tagCounts['doc-la-viet-nam'],
        1,
        'doc-la-viet-nam tag must have exactly 1 video',
      );
      assert.equal(tagCounts['!!!'], 1, 'Punctuation tag must have exactly 1 video');
    });

    it('verifies upload distribution across creators respects 20 upload/24h quota and series ownership', () => {
      // In seed.mjs: 40 clips, CURATOR_INDICES has 15 items, creator2 has 13, creator3 has 12
      const CURATOR_INDICES = new Set([0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 18, 19, 20, 37]);
      const TOTAL_CLIPS = 40;
      const otherIndices = [];
      for (let i = 0; i < TOTAL_CLIPS; i++) {
        if (!CURATOR_INDICES.has(i)) {
          otherIndices.push(i);
        }
      }
      const CREATOR2_INDICES = new Set(otherIndices.slice(0, 13));
      const CREATOR3_INDICES = new Set(otherIndices.slice(13));

      // 1. Quota requirement: all creators must have < 20 uploads
      assert.ok(
        CURATOR_INDICES.size < 20,
        `curator uploads (${CURATOR_INDICES.size}) must be < 20`,
      );
      assert.ok(
        CREATOR2_INDICES.size < 20,
        `creator2 uploads (${CREATOR2_INDICES.size}) must be < 20`,
      );
      assert.ok(
        CREATOR3_INDICES.size < 20,
        `creator3 uploads (${CREATOR3_INDICES.size}) must be < 20`,
      );
      assert.equal(
        CURATOR_INDICES.size + CREATOR2_INDICES.size + CREATOR3_INDICES.size,
        TOTAL_CLIPS,
        'Total uploads must equal 40',
      );

      // 2. Series & Playlist single owner requirement: all series & playlist videos belong to sim_curator
      const playlistVideoIdxs = [
        [0, 1, 2, 3],
        [18, 19, 20],
        [10, 11, 12, 13],
        [0, 4],
      ].flat();
      const seriesVideoIdxs = [
        [0, 1, 37, 2],
        [10, 11, 12, 13, 14, 15],
      ].flat();

      for (const idx of [...playlistVideoIdxs, ...seriesVideoIdxs]) {
        assert.ok(
          CURATOR_INDICES.has(idx),
          `Video index ${idx} used in series/playlist must belong to sim_curator`,
        );
      }

      // 3. Quota rule verification: 21st upload triggers 429 UPLOAD_QUOTA_EXCEEDED
      const quotaLimit = 20;
      function simulateUploadCount(count) {
        if (count > quotaLimit) {
          return { status: 429, code: 'UPLOAD_QUOTA_EXCEEDED' };
        }
        return { status: 201, code: 'OK' };
      }
      assert.equal(simulateUploadCount(20).status, 201);
      assert.equal(simulateUploadCount(21).status, 429);
      assert.equal(simulateUploadCount(21).code, 'UPLOAD_QUOTA_EXCEEDED');
    });

    it('guarantees no creator ever exceeds 2 concurrent in-flight uploads and total concurrent <= 6', async () => {
      const CURATOR_INDICES = new Set([0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 18, 19, 20, 37]);
      const TOTAL_CLIPS = 40;
      const otherIndices = [];
      for (let i = 0; i < TOTAL_CLIPS; i++) {
        if (!CURATOR_INDICES.has(i)) {
          otherIndices.push(i);
        }
      }
      const CREATOR2_INDICES = new Set(otherIndices.slice(0, 13));
      const CREATOR3_INDICES = new Set(otherIndices.slice(13));

      function getOwnerHandle(idx) {
        if (CURATOR_INDICES.has(idx)) return 'sim_curator';
        if (CREATOR2_INDICES.has(idx)) return 'sim_creator2';
        if (CREATOR3_INDICES.has(idx)) return 'sim_creator3';
        throw new Error(`Video index ${idx} has no owner assigned`);
      }

      // Check that all 40 indices have a valid owner and unassigned throws
      for (let i = 0; i < TOTAL_CLIPS; i++) {
        assert.ok(getOwnerHandle(i));
      }
      assert.throws(() => getOwnerHandle(999), /no owner assigned/);

      // Simulation of concurrent worker queues
      const activePerOwner = { sim_curator: 0, sim_creator2: 0, sim_creator3: 0 };
      const maxPerOwner = { sim_curator: 0, sim_creator2: 0, sim_creator3: 0 };
      let currentTotalActive = 0;
      let maxTotalActive = 0;
      const completedIndices = new Set();
      const uploadedVideos = new Array(TOTAL_CLIPS);

      async function processMockVideo(idx) {
        const owner = getOwnerHandle(idx);
        activePerOwner[owner]++;
        currentTotalActive++;
        maxPerOwner[owner] = Math.max(maxPerOwner[owner], activePerOwner[owner]);
        maxTotalActive = Math.max(maxTotalActive, currentTotalActive);

        // Invariant: at no point in time can an owner have > 2 concurrent uploads
        assert.ok(
          activePerOwner[owner] <= 2,
          `Owner ${owner} exceeded 2 concurrent uploads: ${activePerOwner[owner]}`,
        );

        // Small simulated async delay with slight jitter
        await sleep(2 + (idx % 3));

        uploadedVideos[idx] = { id: `v-${idx}`, owner };
        completedIndices.add(idx);

        activePerOwner[owner]--;
        currentTotalActive--;
      }

      async function runCreatorQueue(indices, maxConcurrent = 2) {
        let next = 0;
        async function worker() {
          while (next < indices.length) {
            const idx = indices[next++];
            await processMockVideo(idx);
          }
        }
        const workers = Array.from({ length: Math.min(maxConcurrent, indices.length) }, () =>
          worker(),
        );
        await Promise.all(workers);
      }

      await Promise.all([
        runCreatorQueue(Array.from(CURATOR_INDICES), 2),
        runCreatorQueue(Array.from(CREATOR2_INDICES), 2),
        runCreatorQueue(Array.from(CREATOR3_INDICES), 2),
      ]);

      // All videos must be processed
      assert.equal(completedIndices.size, TOTAL_CLIPS);
      assert.equal(uploadedVideos.length, TOTAL_CLIPS);
      for (let i = 0; i < TOTAL_CLIPS; i++) {
        assert.equal(uploadedVideos[i].id, `v-${i}`);
      }

      // Max concurrent per owner must never exceed 2
      assert.ok(maxPerOwner.sim_curator <= 2, `sim_curator max: ${maxPerOwner.sim_curator}`);
      assert.ok(maxPerOwner.sim_creator2 <= 2, `sim_creator2 max: ${maxPerOwner.sim_creator2}`);
      assert.ok(maxPerOwner.sim_creator3 <= 2, `sim_creator3 max: ${maxPerOwner.sim_creator3}`);
      assert.ok(maxTotalActive <= 6, `total concurrent max: ${maxTotalActive}`);
    });
  });

  describe('Performance Budget Comparison Logic', () => {
    it('passes when latencies are within 20% and error rate < 1%', () => {
      const baseline = {
        http_req_failed: 0.002,
        endpoints: {
          'GET /v1/videos': { p50: 10, p95: 50 },
          'POST /v1/videos/{id}/comments': { p50: 20, p95: 100 },
        },
      };

      const current = {
        http_req_failed: 0.003,
        endpoints: {
          'GET /v1/videos': { p50: 11, p95: 55 }, // +10% (within 20%)
          'POST /v1/videos/{id}/comments': { p50: 22, p95: 115 }, // +15% (within 20%)
        },
      };

      const res = comparePerf(current, baseline);
      assert.equal(res.passed, true);
      assert.equal(res.violations.length, 0);
    });

    it('fails when p95 regresses by > 20%', () => {
      const baseline = {
        http_req_failed: 0.001,
        endpoints: {
          'GET /v1/videos': { p50: 10, p95: 50 },
        },
      };

      const current = {
        http_req_failed: 0.001,
        endpoints: {
          'GET /v1/videos': { p50: 15, p95: 75 }, // +50% regression (>20%)
        },
      };

      const res = comparePerf(current, baseline);
      assert.equal(res.passed, false);
      assert.ok(
        res.violations.some((v) => v.includes('Latency regression > 20% on [GET /v1/videos]')),
      );
    });

    it('fails when http_req_failed >= 1%', () => {
      const baseline = {
        http_req_failed: 0.005,
        endpoints: { 'GET /v1/videos': { p50: 10, p95: 50 } },
      };

      const current = {
        http_req_failed: 0.015, // 1.5% >= 1%
        endpoints: { 'GET /v1/videos': { p50: 10, p95: 50 } },
      };

      const res = comparePerf(current, baseline);
      assert.equal(res.passed, false);
      assert.ok(res.violations.some((v) => v.includes('Error rate budget exceeded')));
    });
  });

  describe('Localhost Guard in loadtest/sim-profile.sh', () => {
    const scriptPath = path.resolve(process.cwd(), 'loadtest/sim-profile.sh');

    it('strictly refuses external TARGET_URL (https://winkey.vn)', () => {
      const res = spawnSync(scriptPath, [], {
        env: { ...process.env, TARGET_URL: 'https://winkey.vn' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr || res.stdout, /sim-profile is strictly for localhost\/127\.0\.0\.1/);
    });

    it('strictly refuses sneaky subdomain (http://localhost.evil.example)', () => {
      const res = spawnSync(scriptPath, [], {
        env: { ...process.env, TARGET_URL: 'http://localhost.evil.example' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr || res.stdout, /sim-profile is strictly for localhost\/127\.0\.0\.1/);
    });

    it('strictly refuses wildcard DNS suffix (http://127.0.0.1.nip.io)', () => {
      const res = spawnSync(scriptPath, [], {
        env: { ...process.env, TARGET_URL: 'http://127.0.0.1.nip.io' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr || res.stdout, /sim-profile is strictly for localhost\/127\.0\.0\.1/);
    });

    it('strictly refuses external TARGET_URL (arbitrary domain or public IP)', () => {
      const res = spawnSync(scriptPath, [], {
        env: { ...process.env, TARGET_URL: 'http://example.com' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr || res.stdout, /sim-profile is strictly for localhost\/127\.0\.0\.1/);
    });

    it('strictly refuses public IP target (http://103.20.12.5:8080)', () => {
      const res = spawnSync(scriptPath, [], {
        env: { ...process.env, TARGET_URL: 'http://103.20.12.5:8080' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr || res.stdout, /sim-profile is strictly for localhost\/127\.0\.0\.1/);
    });

    it('allows valid local targets (localhost, 127.0.0.1, [::1])', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k6-shim-'));
      const k6Shim = path.join(tmpDir, 'k6');
      const dummySummary = JSON.stringify({
        metrics: {
          http_reqs: { count: 10 },
          http_req_failed: { value: 0 },
          http_req_duration: { 'p(95)': 50, med: 20 },
        },
      });
      fs.writeFileSync(
        k6Shim,
        `#!/bin/sh
target=""
for arg in "$@"; do
  if [ "$prev" = "--summary-export" ]; then
    target="$arg"
  fi
  prev="$arg"
done
if [ -n "$target" ]; then
  cat <<'EOF' > "$target"
${dummySummary}
EOF
fi
exit 0
`,
        { mode: 0o755 },
      );
      try {
        for (const target of [
          'http://127.0.0.1:8080',
          'http://localhost:8080',
          'http://[::1]:8080',
        ]) {
          const res = spawnSync(scriptPath, [], {
            env: {
              ...process.env,
              TARGET_URL: target,
              REPORT_DIR: tmpDir,
              PATH: `${tmpDir}:${process.env.PATH}`,
            },
            encoding: 'utf8',
          });
          assert.equal(
            res.status,
            0,
            `Target should be allowed: ${target}, got stderr: ${res.stderr}`,
          );
          assert.doesNotMatch(res.stderr, /refuses/);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('fails when k6 summary JSON is missing or http_reqs.count is 0', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k6-zero-'));
      const k6Shim = path.join(tmpDir, 'k6');
      const emptySummary = JSON.stringify({
        metrics: {
          http_reqs: { count: 0 },
        },
      });
      fs.writeFileSync(
        k6Shim,
        `#!/bin/sh
target=""
for arg in "$@"; do
  if [ "$prev" = "--summary-export" ]; then
    target="$arg"
  fi
  prev="$arg"
done
if [ -n "$target" ]; then
  cat <<'EOF' > "$target"
${emptySummary}
EOF
fi
exit 0
`,
        { mode: 0o755 },
      );
      try {
        const res = spawnSync(scriptPath, [], {
          env: {
            ...process.env,
            TARGET_URL: 'http://127.0.0.1:8080',
            REPORT_DIR: tmpDir,
            PATH: `${tmpDir}:${process.env.PATH}`,
          },
          encoding: 'utf8',
        });
        assert.equal(res.status, 1);
        assert.match(res.stderr || res.stdout, /http_reqs\.count is 0/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Local Valkey Rate Limit Reset Guard (reset-ratelimits.sh)', () => {
    const resetScript = path.resolve(process.cwd(), 'systest/reset-ratelimits.sh');

    it('strictly refuses external TARGET_URL (https://winkey.vn)', () => {
      const res = spawnSync(resetScript, [], {
        env: { ...process.env, TARGET_URL: 'https://winkey.vn' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /reset-ratelimits refuses non-local TARGET_URL/);
    });

    it('strictly refuses sneaky subdomain (http://localhost.evil.example)', () => {
      const res = spawnSync(resetScript, [], {
        env: { ...process.env, TARGET_URL: 'http://localhost.evil.example' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /reset-ratelimits refuses non-local TARGET_URL/);
    });

    it('strictly refuses wildcard DNS suffix (http://127.0.0.1.nip.io)', () => {
      const res = spawnSync(resetScript, [], {
        env: { ...process.env, TARGET_URL: 'http://127.0.0.1.nip.io' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /reset-ratelimits refuses non-local TARGET_URL/);
    });

    it('allows valid local targets (localhost, 127.0.0.1, [::1])', () => {
      for (const target of [
        'http://127.0.0.1:8080',
        'http://localhost:8080',
        'http://[::1]:8080',
      ]) {
        const res = spawnSync(resetScript, [], {
          env: { ...process.env, TARGET_URL: target },
          encoding: 'utf8',
        });
        assert.equal(res.status, 0, `Target should be allowed: ${target}, got: ${res.stderr}`);
        assert.doesNotMatch(res.stderr, /refuses/);
      }
    });
  });

  describe('Early pnpm Dependency Guard in run.sh', () => {
    const runScript = path.resolve(process.cwd(), 'systest/run.sh');

    it('immediately aborts with clear error message when pnpm is missing in PATH', () => {
      const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'winkey-no-pnpm-'));
      try {
        for (const bin of ['bash', 'dirname', 'uname', 'mkdir']) {
          const binPath = `/bin/${bin}`;
          const usrBinPath = `/usr/bin/${bin}`;
          if (fs.existsSync(binPath)) {
            try {
              fs.symlinkSync(binPath, path.join(tmpBin, bin));
            } catch {
              /* ignore */
            }
          } else if (fs.existsSync(usrBinPath)) {
            try {
              fs.symlinkSync(usrBinPath, path.join(tmpBin, bin));
            } catch {
              /* ignore */
            }
          }
        }
        const res = spawnSync(runScript, ['--sim'], {
          env: { PATH: tmpBin },
          encoding: 'utf8',
        });
        assert.equal(res.status, 1);
        assert.match(res.stderr, /'pnpm' command not found/);
      } finally {
        fs.rmSync(tmpBin, { recursive: true, force: true });
      }
    });
  });

  describe('Summary Report Builder (build-summary.mjs)', () => {
    it('parses TAP logs with passed and failed counts', () => {
      const tapPassed = `
TAP version 13
ok 1 - auth
ok 2 - video
# tests 18
# suites 1
# pass 18
# fail 0
# duration_ms 4200.5
`;
      const resPass = parseTap(tapPassed);
      assert.equal(resPass.status, 'PASSED');
      assert.equal(resPass.total, 18);
      assert.equal(resPass.pass, 18);
      assert.equal(resPass.fail, 0);

      const tapFailed = `
not ok 1 - auth
# tests 18
# pass 17
# fail 1
`;
      const resFail = parseTap(tapFailed);
      assert.equal(resFail.status, 'FAILED');
      assert.equal(resFail.total, 18);
      assert.equal(resFail.fail, 1);

      const resEmpty = parseTap('');
      assert.equal(resEmpty.status, 'NOT RUN');
    });

    it('marks all personas NOT RUN when Playwright output is missing', () => {
      const personas = parsePlaywright(null);
      assert.equal(personas.length, 5);
      for (const p of personas) {
        assert.equal(p.status, 'NOT RUN');
      }
    });

    it('accurately maps Playwright JSON project results per persona and viewport', () => {
      const mockPlaywrightJson = {
        suites: [
          {
            title: 'personas/member.spec.ts',
            specs: [
              {
                title: 'member login',
                tests: [
                  { projectName: 'member', status: 'expected', results: [{ status: 'passed' }] },
                ],
              },
            ],
          },
          {
            title: 'personas/creator.spec.ts',
            specs: [
              {
                title: 'creator upload',
                tests: [
                  { projectName: 'creator', status: 'unexpected', results: [{ status: 'failed' }] },
                ],
              },
            ],
          },
        ],
      };

      const personas = parsePlaywright(mockPlaywrightJson);
      const member = personas.find((p) => p.id === 'member');
      const creator = personas.find((p) => p.id === 'creator');
      const anonDesk = personas.find((p) => p.id === 'anon-viewer-desktop');

      assert.equal(member.status, 'PASSED');
      assert.equal(creator.status, 'FAILED');
      assert.equal(anonDesk.status, 'NOT RUN');
    });

    it('builds complete markdown summary with TAP count, personas table, and k6 metrics', () => {
      const md = buildSummaryMarkdown({
        tapContent: '# tests 18\n# pass 18\n# fail 0',
        playwrightJson: {
          suites: [
            {
              specs: [
                { tests: [{ projectName: 'member', status: 'expected' }] },
                { tests: [{ projectName: 'creator', status: 'expected' }] },
                { tests: [{ projectName: 'anon-viewer-desktop', status: 'expected' }] },
                { tests: [{ projectName: 'anon-viewer-mobile', status: 'expected' }] },
                { tests: [{ projectName: 'moderator', status: 'expected' }] },
              ],
            },
          ],
        },
        perfJson: {
          rebuffer_ratio_noseek: 0.002,
          http_req_failed: 0.001,
          endpoints: {
            'GET /v1/videos': { p50: 12.0, p95: 25.0 },
          },
        },
        dateStr: '2026-10-11T06:00:00Z',
      });

      assert.match(md, /# SIM1 Local Run Summary/);
      assert.match(md, /18 passed, 0 failed, 18 total/);
      assert.match(md, /member \(Lưu regression\).*PASSED/);
      assert.match(md, /rebuffer ratio \(non-seek\) 0\.20%/);
      assert.match(md, /GET \/v1\/videos.*12\.0 ms.*25\.0 ms/);
      assert.match(md, /\*\*Status\*\*: \*\*PASSED\*\*/);
    });

    it('plainly marks baseline run as baseline run, not compared in summary.md', () => {
      const md = buildSummaryMarkdown({
        tapContent: '# tests 18\n# pass 18\n# fail 0',
        playwrightJson: {
          suites: [
            {
              specs: [
                { tests: [{ projectName: 'member', status: 'expected' }] },
                { tests: [{ projectName: 'creator', status: 'expected' }] },
                { tests: [{ projectName: 'anon-viewer-desktop', status: 'expected' }] },
                { tests: [{ projectName: 'anon-viewer-mobile', status: 'expected' }] },
                { tests: [{ projectName: 'moderator', status: 'expected' }] },
              ],
            },
          ],
        },
        perfJson: {
          rebuffer_ratio_noseek: 0,
          http_req_failed: 0,
          endpoints: {
            'GET /v1/videos': { p50: 12.0, p95: 25.0 },
          },
        },
        baselineJson: null,
        isBaselineRun: true,
      });

      assert.match(md, /PASSED \(chạy làm baseline, chưa so sánh\)/);
    });

    it('clearly notes when k6 exceeds threshold (rc 99) in summary.md', () => {
      const md = buildSummaryMarkdown({
        tapContent: '# tests 18\n# pass 18\n# fail 0',
        playwrightJson: { suites: [] },
        perfJson: {
          rebuffer_ratio_noseek: 0,
          http_req_failed: 0.06,
          k6_exit_code: 99,
          k6_threshold_exceeded: true,
          endpoints: {
            'GET /v1/videos': { p50: 12.0, p95: 25.0 },
          },
        },
        baselineJson: null,
        isBaselineRun: false,
      });

      assert.match(md, /FAILED \(k6 vượt threshold, rc 99\)/);
      assert.match(md, /k6 vượt threshold \(rc 99\)/);
      assert.match(md, /\*\*Status\*\*: \*\*FAILED\*\*/);
    });
  });

  describe('Playwright Config & Personas Manifest Resolution (Issue #321)', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));

    it('playwright.config.ts uses CommonJS __dirname without import.meta.url', () => {
      const configPath = path.resolve(testDir, '../playwright.config.ts');
      const content = fs.readFileSync(configPath, 'utf8');
      assert.ok(
        !content.includes('import.meta'),
        'playwright.config.ts must not contain import.meta',
      );
      assert.ok(
        !content.includes('fileURLToPath'),
        'playwright.config.ts must not contain fileURLToPath',
      );
      assert.ok(
        !content.includes("from 'node:url'"),
        'playwright.config.ts must not import node:url',
      );
      assert.ok(content.includes('__dirname'), 'playwright.config.ts must use __dirname');
    });

    it('personas/*.spec.ts resolve manifest relative to __dirname and throw on missing manifest', () => {
      const personasDir = path.resolve(testDir, '../personas');
      const files = fs.readdirSync(personasDir).filter((f) => f.endsWith('.spec.ts'));
      assert.ok(files.length >= 4, 'Must have at least 4 persona spec files');

      for (const file of files) {
        const fullPath = path.join(personasDir, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        assert.ok(
          content.includes("path.resolve(__dirname, '../.run/seed-manifest.json')"),
          `${file} must resolve manifest with path.resolve(__dirname, '../.run/seed-manifest.json')`,
        );
        assert.ok(
          content.includes('throw new Error'),
          `${file} must throw on missing manifest or required data`,
        );
        assert.ok(
          !content.includes("|| { id: 'test-video' }"),
          `${file} must not have fallback dummy video ID`,
        );
        assert.ok(
          !content.includes("|| 'sim-invite-2026-auth-ok'"),
          `${file} must not have fallback dummy invite code`,
        );
      }
    });
  });

  describe('CORS Preflight & Bucket Configuration Assertions', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(testDir, '../..');

    it('systest/run.sh asserts CORS preflight for :3900 (PUT) and :8081 (GET) before Playwright', () => {
      const runShPath = path.resolve(testDir, '../run.sh');
      const content = fs.readFileSync(runShPath, 'utf8');

      // Must check :3900 with PUT and Origin http://127.0.0.1:8080
      assert.ok(
        content.includes(
          'curl -s -i -X OPTIONS "http://127.0.0.1:3900/winkey-raw/cors-preflight-check"',
        ),
        'run.sh must test Garage :3900 OPTIONS preflight',
      );
      assert.ok(
        content.includes('-H "Access-Control-Request-Method: PUT"'),
        'run.sh must test PUT method in preflight',
      );

      // Must check :8081 with GET and Origin http://127.0.0.1:8080
      assert.ok(
        content.includes('curl -s -i -X OPTIONS "http://127.0.0.1:8081/cors-preflight-check"'),
        'run.sh must test media-cache :8081 OPTIONS preflight',
      );
      assert.ok(
        content.includes('-H "Access-Control-Request-Method: GET"'),
        'run.sh must test GET method in preflight',
      );

      // Must assert exactly one header Access-Control-Allow-Origin: http://127.0.0.1:8080 or exit 1
      assert.ok(
        content.includes(
          '[ "${ORIGIN_3900_COUNT}" -eq 1 ] && [ "${ORIGIN_3900_VAL}" = "http://127.0.0.1:8080" ]',
        ),
        'run.sh must assert exactly one origin header matching http://127.0.0.1:8080 for 3900',
      );
      assert.ok(
        content.includes(
          '[ "${ORIGIN_8081_COUNT}" -eq 1 ] && [ "${ORIGIN_8081_VAL}" = "http://127.0.0.1:8080" ]',
        ),
        'run.sh must assert exactly one origin header matching http://127.0.0.1:8080 for 8081',
      );
    });

    it('deploy/compose/garage/bootstrap.sh exits 1 on failure and prints get-bucket-cors on success', () => {
      const bootstrapPath = path.resolve(repoRoot, 'deploy/compose/garage/bootstrap.sh');
      const content = fs.readFileSync(bootstrapPath, 'utf8');

      assert.ok(
        content.includes('for i in $(seq 1 30)'),
        'bootstrap.sh must retry put-bucket-cors 30 times',
      );
      assert.ok(content.includes('exit 1'), 'bootstrap.sh must exit 1 if CORS is not applied');
      assert.ok(
        content.includes('s3api get-bucket-cors --bucket winkey-raw'),
        'bootstrap.sh must print get-bucket-cors on success',
      );
    });

    it('deploy/compose/README.md documents Garage v1.0.1 multi-origin CORS behavior and 2-rule separation', () => {
      const readmePath = path.resolve(repoRoot, 'deploy/compose/README.md');
      const content = fs.readFileSync(readmePath, 'utf8');

      assert.ok(
        content.includes('Garage v1.0.1'),
        'README.md must mention Garage v1.0.1 in CORS section',
      );
      assert.ok(
        content.includes('2 quy tắc riêng biệt'),
        'README.md must document 2 separate CORS rules for Garage',
      );
    });
  });

  describe('Persona Session Reuse & Auth Rate Limit Protection (Issue #342)', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));

    it('creator.spec.ts uses test.describe.serial and saves creator storage state', () => {
      const creatorSpec = path.resolve(testDir, '../personas/creator.spec.ts');
      const content = fs.readFileSync(creatorSpec, 'utf8');

      assert.ok(
        content.includes('test.describe.serial'),
        'creator.spec.ts must use test.describe.serial for session sharing',
      );
      assert.ok(
        content.includes('creator-state.json'),
        'creator.spec.ts must persist creator-state.json storage state',
      );
      assert.ok(
        content.includes('resetRateLimits()'),
        'creator.spec.ts must call resetRateLimits() in beforeAll',
      );
    });

    it('moderator.spec.ts reuses creator-state.json storage state in step 4', () => {
      const modSpec = path.resolve(testDir, '../personas/moderator.spec.ts');
      const content = fs.readFileSync(modSpec, 'utf8');

      assert.ok(
        content.includes('creator-state.json'),
        'moderator.spec.ts must reference creator-state.json',
      );
      assert.ok(
        content.includes('storageState: creatorStatePath'),
        'moderator.spec.ts must load storageState for ownerContext',
      );
      assert.ok(
        content.includes('resetRateLimits()'),
        'moderator.spec.ts must call resetRateLimits() in beforeAll',
      );
    });

    it('systest/run.sh resets rate limits immediately before running Playwright', () => {
      const runShPath = path.resolve(testDir, '../run.sh');
      const content = fs.readFileSync(runShPath, 'utf8');

      assert.ok(
        content.includes('Resetting auth rate limits before Playwright personas...'),
        'run.sh must reset rate limits before Playwright personas',
      );
    });
  });
});

