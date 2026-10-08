import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use controlled module adapter for k6 imports
import { setMockHttpHandler, resetHttpState, httpCalls } from '../adapters/k6-http.mjs';
import { resetCoreState, lastFailedMessage } from '../adapters/k6-core.mjs';
import { metricInstances, resetMetricsState } from '../adapters/k6-metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const hlsModulePath = path.join(repoRoot, 'loadtest', 'hls-viewers.js');

describe('[LT2 Regression] Actual HLS Viewers Contract & Metric Verification', () => {
  let hlsModule;

  beforeEach(async () => {
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    if (!hlsModule) {
      hlsModule = await import(pathToFileURL(hlsModulePath).href);
    }
  });

  test('Finding 16: Contract playback: must not invent non-contract /manifest.m3u8 fallback URL', () => {
    // OpenAPI contracts define video playback exclusively through playback.hls_url.
    // If playback.hls_url is missing, workload must NOT invent /manifest.m3u8 fallback.
    setMockHttpHandler((req) => {
      if (req.url.includes('/v1/videos/vid-no-playback-1')) {
        // Detail response returns valid video record without playback.hls_url
        return {
          status: 200,
          body: JSON.stringify({ id: 'vid-no-playback-1', title: 'Sample' }),
          timings: { duration: 10 },
        };
      }
      return { status: 404, body: 'Not Found', timings: { duration: 10 } };
    });

    const mockData = {
      videos: [{ id: 'vid-no-playback-1' }],
    };

    hlsModule.default(mockData);

    // Inspect actual HTTP requests executed by the workload
    const inventedManifestCalls = httpCalls.filter((c) => c.url.includes('/manifest.m3u8'));
    assert.strictEqual(
      inventedManifestCalls.length,
      0,
      `Contract finding: hls-viewers.js must adhere strictly to OpenAPI playback.hls_url and not request uncontracted ${inventedManifestCalls.map((c) => c.url).join(', ')}`,
    );
  });

  test('Finding 17: Failed / invalid segment must abort playback immediately, not continue fake watch time', () => {
    // When a video segment download fails (e.g. 404, 500, network drop),
    // the viewer must abort playback immediately. It must NOT continue downloading
    // subsequent segments or accumulating watch time.
    setMockHttpHandler((req) => {
      if (req.url.includes('.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n#EXTINF:2.0\nseg1.ts\n#EXTINF:2.0\nseg2.ts\n#EXTINF:2.0\nseg3.ts\n#EXTINF:2.0\nseg4.ts\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('seg1.ts')) {
        // First segment fails with 500 Internal Server Error
        return {
          status: 500,
          body: 'Internal Server Error',
          timings: { duration: 50 },
        };
      }
      return { status: 200, body: 'segment-data', timings: { duration: 10 } };
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
    // and continues looping, requesting seg2.ts, seg3.ts, etc.!
    const subsequentSegmentCalls = httpCalls.filter(
      (c) => c.url.includes('seg2.ts') || c.url.includes('seg3.ts') || c.url.includes('seg4.ts'),
    );

    assert.strictEqual(
      subsequentSegmentCalls.length === 0 && (threwError || lastFailedMessage !== null),
      true,
      `Playback safety finding: hls-viewers.js must abort playback on segment failure, not continue downloading subsequent segments (requested: ${subsequentSegmentCalls.map((c) => c.url).join(', ')})`,
    );
  });

  test('Finding 18: Aggregate rebuffer ratio formula: near 1% threshold case', () => {
    // Near 1% threshold verification:
    // By contract & LT2 specification:
    // Rebuffer Ratio = stallTime / (watchTime + stallTime)
    //
    // Prevent seek so isSeekPoint is false:
    const originalRandom = Math.random;
    Math.random = () => 0.5;

    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('variant.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXTINF:2.0\nseg0.ts\n#EXTINF:23.8\nseg1.ts\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('seg0.ts')) {
        return { status: 200, body: 'bytes', timings: { duration: 50 } };
      }
      if (req.url.includes('seg1.ts')) {
        // dl 2.26s against 2.0s buffer: stall is 0.26s
        // total watch is 25.8s
        // True ratio = 0.26 / (25.8 + 0.26) = 0.0099769 (< 1% PASS)
        // Skewed ratio = 0.26 / 25.8 = 0.0100775 (>= 1% FALSE FAIL)
        return { status: 200, body: 'bytes', timings: { duration: 2260 } };
      }
      return { status: 200, body: '', timings: { duration: 10 } };
    });

    const mockData = {
      videos: [{ id: 'vid-1', playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' } }],
    };

    try {
      hlsModule.default(mockData);
    } finally {
      Math.random = originalRandom;
    }

    const ratioTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio');
    assert.ok(ratioTrend && ratioTrend.values.length > 0, 'rebuffer_ratio metric must be recorded');

    const recordedRatio = ratioTrend.values[0];

    const watchTrend = metricInstances.find((m) => m.name === 'total_watch_time_ms');
    const stallTrend = metricInstances.find((m) => m.name === 'total_stall_time_ms');
    const watchSec = (watchTrend?.count || 0) / 1000.0;
    const stallSec = (stallTrend?.count || 0) / 1000.0;

    const expectedTrueRatio = stallSec / (watchSec + stallSec);

    // Assert that the recorded ratio must match true ratio formula stall / (watch + stall),
    // and specifically must NOT trigger a false-alarm SLA failure >= 1% when true ratio is < 1%.
    assert.strictEqual(
      recordedRatio < 0.01,
      true,
      `Metric accuracy finding: at near 1% threshold, true ratio is ${expectedTrueRatio.toFixed(6)} (< 1% PASS), but skewed ratio recorded ${recordedRatio.toFixed(6)} (>= 1% FALSE FAIL)`,
    );
  });

  test('Finding 18: Aggregate rebuffer ratio formula: weighted unequal-duration segments', () => {
    // Segments with unequal durations: 2.0s, 6.0s, 1.5s, 4.0s
    const originalRandom = Math.random;
    Math.random = () => 0.5;

    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('variant.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXTINF:2.0\nseg0.ts\n#EXTINF:6.0\nseg1.ts\n#EXTINF:1.5\nseg2.ts\n#EXTINF:4.0\nseg3.ts\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('seg0.ts')) {
        return { status: 200, body: 'data', timings: { duration: 50 } };
      }
      if (req.url.includes('seg1.ts')) {
        return { status: 200, body: 'data', timings: { duration: 3000 } };
      }
      return { status: 200, body: 'data', timings: { duration: 100 } };
    });

    const mockData = {
      videos: [{ id: 'vid-1', playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' } }],
    };

    try {
      hlsModule.default(mockData);
    } finally {
      Math.random = originalRandom;
    }

    const ratioTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio');
    assert.ok(ratioTrend && ratioTrend.values.length > 0, 'rebuffer_ratio metric must be recorded');
    const recordedRatio = ratioTrend.values[0];

    const watchTrend = metricInstances.find((m) => m.name === 'total_watch_time_ms');
    const stallTrend = metricInstances.find((m) => m.name === 'total_stall_time_ms');
    const watchSec = (watchTrend?.count || 0) / 1000.0;
    const stallSec = (stallTrend?.count || 0) / 1000.0;

    const expectedTrueRatio = stallSec / (watchSec + stallSec);
    assert.strictEqual(
      Math.abs(recordedRatio - expectedTrueRatio) < 0.0001,
      true,
      `Weighted duration finding: expected ratio ${expectedTrueRatio.toFixed(6)}, got ${recordedRatio.toFixed(6)}`,
    );
  });

  test('Finding 18: Zero-playback handling: empty variants list does not record NaN or crash', () => {
    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n# No variants\n`,
          timings: { duration: 10 },
        };
      }
      return { status: 404, body: '', timings: { duration: 10 } };
    });

    const mockData = {
      videos: [{ id: 'vid-1', playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' } }],
    };

    // Zero playback must exit cleanly without division by zero NaN in metrics
    hlsModule.default(mockData);

    const ratioTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio');
    for (const val of ratioTrend?.values || []) {
      assert.strictEqual(Number.isNaN(val), false, 'Recorded ratio must never be NaN');
      assert.strictEqual(Number.isFinite(val), true, 'Recorded ratio must be finite');
    }
  });

  test('Finding 18: Seek vs No-Seek separation: rebufferRatioInclSeekTrend includes seek stall', () => {
    // When a seek occurs, stallTimeSeekOnly is accumulated into ratioInclSeek but NOT ratioNoSeek
    const originalRandom = Math.random;
    let seekDone = false;
    Math.random = () => {
      if (!seekDone) {
        seekDone = true;
        return 0.05; // Trigger seek once
      }
      return 0.5; // Do not seek again, avoid infinite seek loop
    };

    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('variant.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXTINF:2.0\nseg0.ts\n#EXTINF:2.0\nseg1.ts\n`,
          timings: { duration: 10 },
        };
      }
      return { status: 200, body: 'data', timings: { duration: 500 } };
    });

    const mockData = {
      videos: [{ id: 'vid-1', playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' } }],
    };

    try {
      hlsModule.default(mockData);
    } finally {
      Math.random = originalRandom;
    }

    const ratioNoSeekTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio');
    const ratioInclSeekTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio_incl_seek');

    assert.ok(ratioNoSeekTrend && ratioInclSeekTrend, 'Both ratio trends must be defined');
    if (ratioInclSeekTrend.values.length > 0 && ratioNoSeekTrend.values.length > 0) {
      assert.ok(
        ratioInclSeekTrend.values[0] >= ratioNoSeekTrend.values[0],
        'Ratio including seek must be >= ratio without seek',
      );
    }
  });
});
