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
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
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
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
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

  function evaluateZeroPlaybackRejection() {
    const watchTime = metricInstances.find((m) => m.name === 'total_watch_time_ms')?.count || 0;
    const httpFailed = metricInstances.find((m) => m.name === 'http_req_failed')?.rate() || 0;
    const rebufferRate =
      metricInstances.find((m) => m.name === 'aggregate_rebuffer_ratio')?.rate() || 0;

    // Zero valid playback must trigger a final gate failure (e.g. error gate,
    // rebuffer penalty, or dedicated playback gate) rather than exiting cleanly with 0 watch time.
    const hasGateFailure = httpFailed >= 0.01 || rebufferRate >= 0.01;
    return {
      watchTime,
      httpFailed,
      rebufferRate,
      isRejectedByGate: watchTime === 0 && hasGateFailure,
    };
  }

  test('Finding 18 (Zero-playback 1/3): empty video pool must reject run via final gate, not exit cleanly', () => {
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    try {
      hlsModule.default({ videos: [] });
    } catch {
      // k6 fail() throws at iteration level; test verifies final gate rejection
    }
    const result = evaluateZeroPlaybackRejection();
    assert.strictEqual(
      result.isRejectedByGate,
      true,
      `Empty video pool with zero valid playback must breach final error/playback gate, got watchTime=${result.watchTime}, httpFailed=${result.httpFailed}`,
    );
  });

  test('Finding 18 (Zero-playback 2/3): empty 200 master playlist must reject run via final gate, not exit cleanly', () => {
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: '#EXTM3U\n# No variants\n',
          timings: { duration: 10 },
        };
      }
      return { status: 404, body: '', timings: { duration: 10 } };
    });

    hlsModule.default({
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    });

    const result = evaluateZeroPlaybackRejection();
    assert.strictEqual(
      result.isRejectedByGate,
      true,
      `Empty 200 master playlist must breach final error/playback gate on zero valid playback, got watchTime=${result.watchTime}, httpFailed=${result.httpFailed}`,
    );
  });

  test('Finding 18 (Zero-playback 3/3): empty 200 variant playlist must reject run via final gate, not exit cleanly', () => {
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n',
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('variant.m3u8')) {
        return { status: 200, body: '#EXTM3U\n', timings: { duration: 10 } };
      }
      return { status: 404, body: '', timings: { duration: 10 } };
    });

    hlsModule.default({
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    });

    const result = evaluateZeroPlaybackRejection();
    assert.strictEqual(
      result.isRejectedByGate,
      true,
      `Empty 200 variant playlist must breach final error/playback gate on zero valid playback, got watchTime=${result.watchTime}, httpFailed=${result.httpFailed}`,
    );
  });

  test('Finding 18 (Zero-playback negative control): arbitrary uncaught exception is not valid gate rejection', () => {
    // Negative control: an unrelated crash (e.g. malformed JSON or TypeError)
    // does not constitute a valid final threshold gate rejection.
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    setMockHttpHandler(() => {
      throw new Error('Unrelated network crash');
    });

    let threw = false;
    try {
      hlsModule.default({
        videos: [
          {
            id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
            playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
          },
        ],
      });
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, true, 'Uncaught crash throws');
    const result = evaluateZeroPlaybackRejection();
    // A crash must NOT be credited as a valid threshold gate rejection
    assert.strictEqual(
      result.isRejectedByGate,
      false,
      'Unrelated exception must not be credited as a valid threshold gate rejection',
    );
  });

  test('Finding 18: Seek vs No-Seek separation: rebufferRatioInclSeekTrend includes seek stall', () => {
    // When a seek occurs, stallTimeSeekOnly is accumulated into ratioInclSeek but NOT ratioNoSeek.
    // Sequence Math.random deterministically:
    // Call 1: Hot video selection check (0.5 >= 0.2 -> uniform)
    // Call 2: Video pool selection index 0
    // Call 3: playDuration (30.0s)
    // Call 4: Iteration 1 isSeekPoint (0.05 < 0.1 -> seek event triggers!)
    // Call 5: Iteration 1 seek destination segIdx (index 0)
    // Call 6+: Subsequent iterations isSeekPoint (0.5 >= 0.1 -> no further seeks)
    let randomCallCount = 0;
    let seekEventsTriggered = 0;
    const originalRandom = Math.random;
    Math.random = () => {
      randomCallCount++;
      if (randomCallCount === 1) return 0.5;
      if (randomCallCount === 2) return 0.0;
      if (randomCallCount === 3) return 0.5;
      if (randomCallCount === 4) {
        seekEventsTriggered++;
        return 0.05;
      }
      if (randomCallCount === 5) return 0.0;
      return 0.5;
    };

    let seg0Calls = 0;
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
          body: `#EXTM3U\n#EXTINF:2.0\nseg0.ts\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('seg0.ts')) {
        seg0Calls++;
        // First call is startup firstSegRes (10ms). Second call is post-seek download (500ms -> 0.5s stall).
        // Subsequent loop calls are 10ms (no stall).
        const duration = seg0Calls === 2 ? 500 : 10;
        return { status: 200, body: 'data', timings: { duration } };
      }
      return { status: 200, body: '', timings: { duration: 10 } };
    });

    const mockData = {
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    };

    try {
      hlsModule.default(mockData);
    } finally {
      Math.random = originalRandom;
    }

    const ratioNoSeekTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio');
    const ratioInclSeekTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio_incl_seek');
    const _watchTrend = metricInstances.find((m) => m.name === 'total_watch_time_ms');

    // 1. Assert seek event occurred exactly once
    assert.strictEqual(seekEventsTriggered, 1, 'Seek event must occur exactly once');

    // 2. Assert exact sample counts (no missing or skipped samples)
    assert.ok(ratioNoSeekTrend && ratioInclSeekTrend, 'Both ratio trends must be defined');
    assert.strictEqual(ratioNoSeekTrend.values.length, 1, 'Exact 1 sample for rebuffer_ratio');
    assert.strictEqual(
      ratioInclSeekTrend.values.length,
      1,
      'Exact 1 sample for rebuffer_ratio_incl_seek',
    );

    // 3. Assert no-seek ratio is exactly 0
    assert.strictEqual(ratioNoSeekTrend.values[0], 0, 'No-seek rebuffer ratio must be 0');

    // 4. Assert inclusive ratio is strictly greater than no-seek ratio
    assert.strictEqual(
      ratioInclSeekTrend.values[0] > ratioNoSeekTrend.values[0],
      true,
      'Inclusive ratio must be strictly greater than no-seek ratio',
    );

    // 5. Assert independently computed contract values (formula: stall / (watch + stall))
    // Independently calculated from test input sequence:
    // Watch time = 2.0s (startup) + 0.01s (iter 2) + 0.01s (iter 3) = 2.02s
    // Non-seek stall = 0.0s; Seek stall = 0.5s; Total stall = 0.5s
    const expectedWatchTimeSec = 2.02;
    const expectedStallNoSeekSec = 0.0;
    const expectedStallSeekOnlySec = 0.5;
    const expectedTotalStallSec = expectedStallNoSeekSec + expectedStallSeekOnlySec;

    const expectedRatioNoSeek =
      expectedStallNoSeekSec / (expectedWatchTimeSec + expectedStallNoSeekSec); // 0.0
    const expectedRatioInclSeek =
      expectedTotalStallSec / (expectedWatchTimeSec + expectedTotalStallSec); // 0.5 / 2.52 = 0.1984127

    assert.strictEqual(
      ratioNoSeekTrend.values[0],
      expectedRatioNoSeek,
      `No-seek rebuffer ratio must be exactly ${expectedRatioNoSeek}`,
    );
    assert.strictEqual(
      Math.abs(ratioInclSeekTrend.values[0] - expectedRatioInclSeek) < 1e-4,
      true,
      `Inclusive ratio must match specification formula stall / (watch + stall) = ${expectedRatioInclSeek.toFixed(6)} (got ${ratioInclSeekTrend.values[0].toFixed(6)})`,
    );
  });
});
