import http from 'node:http';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';

// In-memory cache tracking
const cacheStore = new Set();
let mockPort = 0;
let mockBaseUrl = '';

const TAP3_ID = '01a14a88-33bb-7dfd-bdbb-22f045fd938e'; // Hot video
const TAP1_ID = '01a12eb3-c8c5-7c32-a439-dc670cc8ab3a'; // Cold catalog video (Thiên Cơ Biến Tập 1)
const TAP2_ID = '01a132fb-0094-7b84-882f-f815bfe8a766'; // Cold catalog video (Thiên Cơ Biến Tập 2)

function createMockServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, mockBaseUrl);
    const pathname = url.pathname;

    // 1. Trending API
    if (pathname === '/v1/videos' && url.searchParams.get('sort') === 'trending') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          items: [
            {
              id: TAP3_ID,
              title: '《Thiên Cơ Biến》 Tập 3 - Lạc Kình',
              published_at: '2026-10-15T00:00:00Z',
            },
          ],
        }),
      );
    }

    // 2. Newest Catalogue API (regardless of age)
    if (pathname === '/v1/videos' && url.searchParams.get('sort') === 'newest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          items: [
            {
              id: TAP3_ID,
              title: '《Thiên Cơ Biến》 Tập 3 - Lạc Kình',
              published_at: '2026-10-15T00:00:00Z',
            },
            {
              id: TAP2_ID,
              title: '《Thiên Cơ Biến》 Tập 2 - Trích Tiên Nhân',
              published_at: '2026-10-14T00:00:00Z',
            },
            {
              id: TAP1_ID,
              title: '《Thiên Cơ Biến》 Tập 1 - Thiên Sinh Dị Biến',
              published_at: '2026-10-12T00:00:00Z',
            },
          ],
        }),
      );
    }

    // 3. Video Metadata / Playback API
    const videoMatch = pathname.match(/^\/v1\/videos\/([^/]+)$/);
    if (videoMatch) {
      const vid = videoMatch[1];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: vid,
          title: `Video ${vid}`,
          playback: {
            hls_url: `${mockBaseUrl}/v/${vid}/a1/hls/master.m3u8`,
          },
        }),
      );
    }

    // 4. HLS Master Playlist
    const masterMatch = pathname.match(/^\/v\/([^/]+)\/a1\/hls\/master\.m3u8$/);
    if (masterMatch) {
      const vid = masterMatch[1];
      const masterContent = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Vietnamese",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio"
480p/index.m3u8
`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'X-Cache-Status': cacheStore.has(pathname) ? 'HIT' : 'MISS',
      });
      cacheStore.add(pathname);
      return res.end(masterContent);
    }

    // 5. Variant Rendition Playlists (720p, 480p, audio)
    const variantMatch = pathname.match(/^\/v\/([^/]+)\/a1\/hls\/(720p|480p|audio)\/index\.m3u8$/);
    if (variantMatch) {
      const [, vid, variant] = variantMatch;
      const renditionContent = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init_0.mp4"
#EXTINF:4.00000,
seg_00000.m4s
#EXTINF:4.00000,
seg_00001.m4s
#EXTINF:4.00000,
seg_00002.m4s
#EXTINF:4.00000,
seg_00003.m4s
#EXTINF:4.00000,
seg_00004.m4s
#EXT-X-ENDLIST
`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'X-Cache-Status': cacheStore.has(pathname) ? 'HIT' : 'MISS',
      });
      cacheStore.add(pathname);
      return res.end(renditionContent);
    }

    // 6. Media Segments (.m4s, .mp4)
    if (pathname.endsWith('.m4s') || pathname.endsWith('.mp4')) {
      const isCached = cacheStore.has(pathname);
      res.writeHead(200, {
        'Content-Type': 'video/iso.segment',
        'X-Cache-Status': isCached ? 'HIT' : 'MISS',
      });
      cacheStore.add(pathname);
      // Dummy 1KB binary payload
      return res.end(Buffer.alloc(1024, 0xaa));
    }

    res.writeHead(404);
    res.end();
  });
}

async function runTests() {
  const server = createMockServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      mockPort = server.address().port;
      mockBaseUrl = `http://127.0.0.1:${mockPort}`;
      resolve();
    });
  });

  process.env.MEDIA_BASE_URL = mockBaseUrl;
  process.env.API_BASE_URL = mockBaseUrl;

  const { checkVideoCached, main, stats, resetStats } = await import('./warmer.mjs');

  console.log(`Mock Winkey Server listening on ${mockBaseUrl}`);

  try {
    // -------------------------------------------------------------
    // Test 1: Verify Idempotency Logic
    // -------------------------------------------------------------
    console.log('\n--- TEST 1: Idempotency Logic (Hot-Full vs Start-Only) ---');
    // Simulate: Tap 3 first segment is ALREADY cached (viewer watched it)
    cacheStore.clear();
    cacheStore.add(`/v/${TAP3_ID}/a1/hls/720p/seg_00000.m4s`);

    // 1a. For hot-full video, checking first segment would give false HIT.
    // Our fix checks the LAST segment (seg_00004.m4s), which is NOT cached yet.
    const hotCheck = await checkVideoCached(
      `${mockBaseUrl}/v/${TAP3_ID}/a1/hls/master.m3u8`,
      true, // isHotFull
    );
    assert.strictEqual(
      hotCheck.cached,
      false,
      'Hot-full video must NOT be skipped when last segment is missing',
    );
    assert(
      hotCheck.testSegmentUrl.endsWith('seg_00004.m4s'),
      'Hot-full check must target the last segment of 720p',
    );
    console.log(
      '✓ Hot-full correctly inspects 720p last segment (seg_00004.m4s) -> MISS (not skipped).',
    );

    // 1b. For start-only video (Tap 1), inspects FIRST segment
    const startOnlyCheck = await checkVideoCached(
      `${mockBaseUrl}/v/${TAP1_ID}/a1/hls/master.m3u8`,
      false, // isHotFull
    );
    assert.strictEqual(startOnlyCheck.cached, false);
    assert(
      startOnlyCheck.testSegmentUrl.endsWith('seg_00000.m4s'),
      'Start-only check must target the first segment',
    );
    console.log(
      '✓ Start-only correctly inspects first segment (seg_00000.m4s) -> MISS (not skipped).',
    );

    // -------------------------------------------------------------
    // Test 2: Full Warming Execution (Run 1)
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: First Execution (Warming Uncached Assets) ---');
    // Keep Tap 3 first segment cached (simulate viewer watched), but everything else cold
    cacheStore.clear();
    cacheStore.add(`/v/${TAP3_ID}/a1/hls/720p/seg_00000.m4s`);

    resetStats();
    await main();

    assert.strictEqual(
      stats.videosScanned,
      3,
      'Must scan 3 candidate videos (1 trending + 2 catalogue)',
    );
    assert.strictEqual(stats.videosWarmed, 3, 'All 3 videos must be warmed');
    assert.strictEqual(stats.videosSkipped, 0, 'No videos should be skipped on first run');
    assert(stats.bytesTransferred > 0, 'Bytes must be transferred');
    console.log(`✓ Run 1 complete: 3/3 warmed, ${stats.filesDownloaded} files downloaded.`);

    // -------------------------------------------------------------
    // Test 3: Idempotent Second Execution (Run 2)
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Second Execution (Idempotent Skip as HIT) ---');
    resetStats();
    await main();

    assert.strictEqual(stats.videosScanned, 3);
    assert.strictEqual(stats.videosSkipped, 3, 'All 3 videos must be skipped as HIT');
    assert.strictEqual(stats.videosWarmed, 0, 'No videos should be warmed');
    assert.strictEqual(stats.filesDownloaded, 0, 'No files should be downloaded');
    assert.strictEqual(stats.bytesTransferred, 0, 'Zero bytes transferred');
    console.log('✓ Run 2 complete: 3/3 skipped as HIT in < 0.1s.');

    // -------------------------------------------------------------
    // Test 4: Verify TTFB difference
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: TTFB Measurement Simulation ---');
    const uncachedUrl = `${mockBaseUrl}/v/uncached-test/a1/hls/720p/seg_00000.m4s`;
    const t0 = performance.now();
    const resMiss = await fetch(uncachedUrl);
    await resMiss.arrayBuffer();
    const ttfbMiss = (performance.now() - t0).toFixed(2);
    assert.strictEqual(resMiss.headers.get('x-cache-status'), 'MISS');

    const t1 = performance.now();
    const resHit = await fetch(uncachedUrl);
    await resHit.arrayBuffer();
    const ttfbHit = (performance.now() - t1).toFixed(2);
    assert.strictEqual(resHit.headers.get('x-cache-status'), 'HIT');
    console.log(`✓ TTFB measurement: MISS=${ttfbMiss}ms vs HIT=${ttfbHit}ms`);

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
