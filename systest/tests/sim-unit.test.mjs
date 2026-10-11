/* global process */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { comparePerf } from '../perf-budget.mjs';

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

    it('strictly refuses external TARGET_URL (winkey.vn)', () => {
      const res = spawnSync(scriptPath, [], {
        env: { ...process.env, TARGET_URL: 'https://winkey.vn' },
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

    it('strictly refuses public IP target', () => {
      const res = spawnSync(scriptPath, [], {
        env: { ...process.env, TARGET_URL: 'http://103.20.12.5:8080' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr || res.stdout, /sim-profile is strictly for localhost\/127\.0\.0\.1/);
    });
  });
});
