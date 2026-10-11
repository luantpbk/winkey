#!/usr/bin/env node
/**
 * deploy/synthetic/probe.mjs
 *
 * MON1 production synthetic monitoring probe (ADR-038).
 * Node 22 native ESM, zero external dependencies.
 * User-Agent: WinkeySynthetic/1.0
 * 8-second timeout per request.
 *
 * Output: one JSON line per check { name, status: "PASS"|"FAIL", ms, error? }
 * Exits with non-zero code on any failure.
 */

const BASE_URL = (process.env.PROBE_BASE_URL || process.env.BASE_URL || 'https://winkey.vn').replace(/\/+$/, '');
const USER_AGENT = 'WinkeySynthetic/1.0';
const TIMEOUT_MS = 8000;

const PROBE_EMAIL = process.env.PROBE_EMAIL || 'synthetic_probe@winkey.vn';
const PROBE_PASSWORD = process.env.PROBE_PASSWORD || '';

/**
 * Fetch wrapper with timeout and standard User-Agent.
 */
async function probeFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', USER_AGENT);
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    ...options,
    headers,
    signal,
  });

  return res;
}

/**
 * Helper to record and output check result as JSON line.
 */
async function runCheck(name, checkFn) {
  const start = performance.now();
  try {
    await checkFn();
    const ms = Math.round(performance.now() - start);
    const result = { name, status: 'PASS', ms };
    console.log(JSON.stringify(result));
    return true;
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const result = {
      name,
      status: 'FAIL',
      ms,
      error: err instanceof Error ? err.message : String(err),
    };
    console.log(JSON.stringify(result));
    return false;
  }
}

async function main() {
  const results = [];
  let sharedVideoId = null;

  // 1. healthz
  results.push(await runCheck('healthz', async () => {
    const res = await probeFetch(`${BASE_URL}/healthz`);
    if (res.status !== 200) {
      throw new Error(`Expected HTTP 200, got ${res.status}`);
    }
  }));

  // 2. readyz
  results.push(await runCheck('readyz', async () => {
    const res = await probeFetch(`${BASE_URL}/readyz`);
    if (res.status !== 200) {
      throw new Error(`Expected HTTP 200, got ${res.status}`);
    }
  }));

  // 3. home (cinema markup)
  results.push(await runCheck('home', async () => {
    const res = await probeFetch(`${BASE_URL}/`);
    if (res.status !== 200) {
      throw new Error(`Expected HTTP 200, got ${res.status}`);
    }
    const html = await res.text();
    const hasCinema = html.includes('"cinema"') ||
                      html.includes('initialHeroVideos') ||
                      html.includes('cinema-');
    if (!hasCinema) {
      throw new Error('Home page response does not contain cinema markup');
    }
  }));

  // 4. watch page & LD+JSON VideoObject
  results.push(await runCheck('watch', async () => {
    const listRes = await probeFetch(`${BASE_URL}/v1/videos?limit=5`);
    if (listRes.status !== 200) {
      throw new Error(`Failed to list videos: HTTP ${listRes.status}`);
    }
    const listData = await listRes.json();
    if (!Array.isArray(listData.items) || listData.items.length === 0) {
      throw new Error('No public videos returned from /v1/videos');
    }
    sharedVideoId = listData.items[0].id;
    if (!sharedVideoId) {
      throw new Error('Missing video ID in first video item');
    }

    const watchRes = await probeFetch(`${BASE_URL}/watch/${sharedVideoId}`);
    if (watchRes.status !== 200) {
      throw new Error(`Watch page returned HTTP ${watchRes.status}`);
    }
    const html = await watchRes.text();
    if (!html.includes('application/ld+json')) {
      throw new Error('Watch page missing application/ld+json schema markup');
    }
    if (!html.includes('VideoObject')) {
      throw new Error('Watch page missing VideoObject in LD+JSON schema');
    }
  }));

  // 5. HLS master playlist and first segment (zero view events/heartbeats)
  results.push(await runCheck('hls', async () => {
    if (!sharedVideoId) {
      throw new Error('No video ID available from watch check');
    }

    const detailRes = await probeFetch(`${BASE_URL}/v1/videos/${sharedVideoId}`);
    if (detailRes.status !== 200) {
      throw new Error(`Video detail returned HTTP ${detailRes.status}`);
    }
    const detail = await detailRes.json();
    const masterUrl = detail.playback?.hls_url;
    if (!masterUrl) {
      throw new Error('Video playback object missing hls_url');
    }

    // GET master playlist
    const masterRes = await probeFetch(masterUrl);
    if (masterRes.status !== 200) {
      throw new Error(`HLS master playlist returned HTTP ${masterRes.status}`);
    }
    const masterText = await masterRes.text();
    const playlistLines = masterText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    if (playlistLines.length === 0) {
      throw new Error('HLS master playlist does not contain rendition stream URIs');
    }

    // Resolve rendition playlist URL and fetch it
    const renditionUrl = new URL(playlistLines[0], masterUrl).href;
    const renditionRes = await probeFetch(renditionUrl);
    if (renditionRes.status !== 200) {
      throw new Error(`Rendition playlist returned HTTP ${renditionRes.status}`);
    }
    const renditionText = await renditionRes.text();
    const segmentLines = renditionText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    if (segmentLines.length === 0) {
      throw new Error('Rendition playlist does not contain segment URIs');
    }

    // Resolve first segment URL and fetch it (HTTP 200)
    const segmentUrl = new URL(segmentLines[0], renditionUrl).href;
    const segmentRes = await probeFetch(segmentUrl);
    if (segmentRes.status !== 200) {
      throw new Error(`HLS first segment returned HTTP ${segmentRes.status}`);
    }
  }));

  // 6. tag landing page & canonical link
  results.push(await runCheck('tag', async () => {
    const tagsRes = await probeFetch(`${BASE_URL}/v1/tags?min_videos=2&limit=1`);
    if (tagsRes.status !== 200) {
      throw new Error(`GET /v1/tags returned HTTP ${tagsRes.status}`);
    }
    const tagsData = await tagsRes.json();
    if (!Array.isArray(tagsData.items) || tagsData.items.length === 0) {
      throw new Error('No tags with min_videos=2 found');
    }
    const slug = tagsData.items[0].slug;
    if (!slug) {
      throw new Error('Tag item missing slug');
    }

    const tagPageRes = await probeFetch(`${BASE_URL}/tag/${encodeURIComponent(slug)}`);
    if (tagPageRes.status !== 200) {
      throw new Error(`Tag page /tag/${slug} returned HTTP ${tagPageRes.status}`);
    }
    const html = await tagPageRes.text();
    if (!html.includes('rel="canonical"')) {
      throw new Error('Tag landing page missing rel="canonical"');
    }
    if (!html.includes(`/tag/${slug}`)) {
      throw new Error(`Tag landing page missing link/reference to /tag/${slug}`);
    }
  }));

  // 7. sitemap.xml
  results.push(await runCheck('sitemap', async () => {
    const sitemapRes = await probeFetch(`${BASE_URL}/sitemap.xml`);
    if (sitemapRes.status !== 200) {
      throw new Error(`GET /sitemap.xml returned HTTP ${sitemapRes.status}`);
    }
    const xml = await sitemapRes.text();
    const trimmed = xml.trim();
    if (!trimmed.endsWith('</urlset>')) {
      throw new Error('Sitemap does not terminate with </urlset>');
    }
    const urlMatches = xml.match(/<url>/g);
    if (!urlMatches || urlMatches.length < 1) {
      throw new Error('Sitemap does not contain at least 1 <url> entry');
    }
  }));

  // 8. auth flow (login -> me -> refresh -> me -> logout)
  results.push(await runCheck('auth', async () => {
    if (!PROBE_PASSWORD) {
      throw new Error('PROBE_PASSWORD environment variable is not set');
    }

    const origin = new URL(BASE_URL).origin;

    // Login
    const loginRes = await probeFetch(`${BASE_URL}/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({
        email: PROBE_EMAIL,
        password: PROBE_PASSWORD,
      }),
    });

    if (loginRes.status !== 200) {
      const body = await loginRes.text().catch(() => '');
      throw new Error(`Login failed with HTTP ${loginRes.status}: ${body}`);
    }

    const loginData = await loginRes.json();
    const accessToken = loginData.access_token;
    if (!accessToken) {
      throw new Error('Login response missing access_token');
    }

    // Extract refresh cookie wk_rt
    const rawSetCookies = loginRes.headers.getSetCookie
      ? loginRes.headers.getSetCookie()
      : [loginRes.headers.get('set-cookie')].filter(Boolean);

    const rtCookieEntry = rawSetCookies.find(c => c && c.startsWith('wk_rt='));
    if (!rtCookieEntry) {
      throw new Error('Login response missing wk_rt Set-Cookie header');
    }
    const rtCookie = rtCookieEntry.split(';')[0];

    // GET /v1/auth/me (initial)
    const meRes1 = await probeFetch(`${BASE_URL}/v1/auth/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (meRes1.status !== 200) {
      throw new Error(`Initial /v1/auth/me returned HTTP ${meRes1.status}`);
    }
    const meData1 = await meRes1.json();
    if (meData1.email !== PROBE_EMAIL) {
      throw new Error(`Expected user email ${PROBE_EMAIL}, got ${meData1.email}`);
    }

    // POST /v1/auth/refresh (rotate refresh cookie)
    const refreshRes = await probeFetch(`${BASE_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        Cookie: rtCookie,
        Origin: origin,
      },
    });
    if (refreshRes.status !== 200) {
      const body = await refreshRes.text().catch(() => '');
      throw new Error(`Refresh failed with HTTP ${refreshRes.status}: ${body}`);
    }

    const refreshData = await refreshRes.json();
    const newAccessToken = refreshData.access_token;
    if (!newAccessToken) {
      throw new Error('Refresh response missing new access_token');
    }

    const refreshSetCookies = refreshRes.headers.getSetCookie
      ? refreshRes.headers.getSetCookie()
      : [refreshRes.headers.get('set-cookie')].filter(Boolean);

    const newRtCookieEntry = refreshSetCookies.find(c => c && c.startsWith('wk_rt='));
    if (!newRtCookieEntry) {
      throw new Error('Refresh response missing rotated wk_rt Set-Cookie header');
    }
    const newRtCookie = newRtCookieEntry.split(';')[0];

    // GET /v1/auth/me (with new token)
    const meRes2 = await probeFetch(`${BASE_URL}/v1/auth/me`, {
      headers: {
        Authorization: `Bearer ${newAccessToken}`,
      },
    });
    if (meRes2.status !== 200) {
      throw new Error(`Refreshed /v1/auth/me returned HTTP ${meRes2.status}`);
    }
    const meData2 = await meRes2.json();
    if (meData2.email !== PROBE_EMAIL) {
      throw new Error(`Expected refreshed user email ${PROBE_EMAIL}, got ${meData2.email}`);
    }

    // POST /v1/auth/logout
    const logoutRes = await probeFetch(`${BASE_URL}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        Cookie: newRtCookie,
        Origin: origin,
      },
    });
    if (logoutRes.status !== 200 && logoutRes.status !== 204) {
      throw new Error(`Logout returned HTTP ${logoutRes.status}`);
    }
  }));

  const allPassed = results.every(Boolean);
  if (!allPassed) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal probe execution error:', err);
  process.exit(1);
});
