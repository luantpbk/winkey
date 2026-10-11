/* global process */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
      fs.writeFileSync(k6Shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      try {
        for (const target of [
          'http://127.0.0.1:8080',
          'http://localhost:8080',
          'http://[::1]:8080',
        ]) {
          const res = spawnSync(scriptPath, [], {
            env: { ...process.env, TARGET_URL: target, PATH: `${tmpDir}:${process.env.PATH}` },
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
  });
});
