import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use controlled module adapter for k6 imports
import { setMockHttpHandler, resetHttpState, httpCalls } from '../adapters/k6-http.mjs';
import { resetCoreState, lastFailedMessage } from '../adapters/k6-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const hlsModulePath = path.join(repoRoot, 'loadtest', 'hls-viewers.js');

describe('[LT2 Regression] Actual HLS Viewers Contract & Metric Verification', () => {
  let hlsModule;

  beforeEach(async () => {
    resetHttpState();
    resetCoreState();
    if (!hlsModule) {
      hlsModule = await import(pathToFileURL(hlsModulePath).href);
    }
  });

  test('Finding 16: Contract playback: must not invent non-contract /manifest.m3u8 fallback URL', () => {
    // OpenAPI contracts define video HLS streaming exclusively through playback.hls_url.
    // Inventing an uncontracted `${TARGET_URL}/v1/videos/${id}/manifest.m3u8` path is prohibited.
    const src = fs.readFileSync(hlsModulePath, 'utf8');
    const hasInventedManifest = src.includes('/manifest.m3u8');
    assert.strictEqual(
      hasInventedManifest,
      false,
      'Contract finding: hls-viewers.js must adhere strictly to OpenAPI playback.hls_url and not invent /manifest.m3u8',
    );
  });

  test('Finding 17: Failed / invalid segment must abort playback immediately, not continue fake watch time', () => {
    // When a video segment download fails (e.g. 404, 500, corrupt),
    // the viewer must abort playback immediately. It must NOT continue the playback loop
    // and accumulate fake watch time as if the video played successfully.
    let segmentAttempts = 0;
    setMockHttpHandler((req) => {
      if (req.url.includes('.m3u8')) {
        // Return valid master & variant playlists
        return {
          status: 200,
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n#EXTINF:2.0\nseg1.ts\n#EXTINF:2.0\nseg2.ts\n#EXTINF:2.0\nseg3.ts\n#EXTINF:2.0\nseg4.ts\n`,
          headers: {},
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('.ts')) {
        segmentAttempts++;
        // Simulate segment download failure on first segment
        return {
          status: 404,
          body: 'Not Found',
          headers: {},
          timings: { duration: 50 },
        };
      }
      return { status: 200, body: '{}', timings: { duration: 10 } };
    });

    const mockData = {
      videos: [
        {
          id: 'video-test-1',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    };

    let threwError = false;
    try {
      hlsModule.default(mockData);
    } catch {
      threwError = true;
    }

    // In current SHA, on segRes.status !== 200, the code only calls httpReqFailed.add(true)
    // and continues looping, downloading subsequent segments and adding to totalWatchTime!
    assert.strictEqual(
      threwError || lastFailedMessage !== null,
      true,
      'Playback safety finding: hls-viewers.js must abort playback on segment failure, not continue fake watch loop',
    );
  });

  test('Finding 18: Aggregate rebuffer ratio formula: denominator must be (watch + stall), not watch only', () => {
    // By industry standard & task specification:
    // Rebuffer Ratio = stallTime / (watchTime + stallTime)
    // Current SHA line 268: const ratioNoSeek = stallTimeNoSeek / watchTimeNoZero;
    // divides by watchTime only, skewing the metric.
    const src = fs.readFileSync(hlsModulePath, 'utf8');

    // Check if denominator includes stall: e.g. (watchTime + stallTime) or (totalWatchTime + stallTime)
    const hasProperDenominator =
      /\/\s*\(\s*(totalWatchTime|watchTime)\w*\s*\+\s*(stallTime|totalStall)\w*\s*\)/.test(src) ||
      /\/\s*Math\.max\([^)]*,\s*(totalWatchTime|watchTime)\w*\s*\+\s*(stallTime|totalStall)\w*\s*\)/.test(
        src,
      );

    assert.strictEqual(
      hasProperDenominator,
      true,
      'Metric accuracy finding: rebuffer ratio denominator must be (watchTime + stallTime), not watchTime alone',
    );
  });
});
