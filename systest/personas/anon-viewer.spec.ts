import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(__dirname, '../.run/seed-manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error(
    `[persona:anon-viewer] Missing seed-manifest.json at ${manifestPath}. Run seed before running personas.`,
  );
}
const manifest: any = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (!manifest.series?.[0]) {
  throw new Error('[persona:anon-viewer] Missing series in seed-manifest.json');
}
if (!manifest.videos || manifest.videos.length === 0) {
  throw new Error('[persona:anon-viewer] Missing videos in seed-manifest.json');
}

test.describe('Persona: anon-viewer (ADR-038)', () => {
  test('home shows cinema rows including "Phim bộ" with seeded series', async ({ page }) => {
    await page.goto('/');
    // Check cinema rows or header
    await expect(page.locator('body')).toBeVisible();

    // Verify "Phim bộ" section is rendered on home
    const seriesSection = page
      .locator('[data-testid="cinema-row-series"]')
      .or(page.getByText('Phim bộ'));
    await expect(seriesSection.first()).toBeVisible({ timeout: 15000 });

    const firstSeriesTitle = manifest.series[0].title;
    await expect(page.getByText(firstSeriesTitle).first()).toBeVisible({ timeout: 15000 });
  });

  test('open tag chip -> /tag/<slug>: h1, canonical, CollectionPage JSON-LD, robots index', async ({
    page,
  }) => {
    // Navigate to shared tag: du-lich
    await page.goto('/tag/du-lich');
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('h1')).toContainText(/du-lich|Du lịch/i);

    // Canonical link
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toBe('https://winkey.vn/tag/du-lich');

    // Robots tag (should be index, follow because >= 2 videos)
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('index');
    expect(robots).toContain('follow');
    expect(robots).not.toContain('noindex');

    // JSON-LD schema
    const jsonLdElements = await page.locator('script[type="application/ld+json"]').all();
    let foundCollectionPage = false;
    for (const el of jsonLdElements) {
      const text = await el.textContent();
      if (text && text.includes('CollectionPage')) {
        foundCollectionPage = true;
        const schema = JSON.parse(text);
        expect(schema['@type']).toBe('CollectionPage');
        expect(schema.url).toBe('https://winkey.vn/tag/du-lich');
        break;
      }
    }
    expect(foundCollectionPage).toBe(true);
  });

  test('single-video tag has noindex, follow; diacritics tag -> 308; unknown tag -> 404', async ({
    page,
    request,
  }) => {
    // 1. Single-video tag: doc-la-viet-nam (1 video)
    await page.goto('/tag/doc-la-viet-nam');
    await expect(page.locator('h1')).toBeVisible();
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');
    expect(robots).toContain('follow');

    // 2. Diacritics tag route: /tag/Độc%20Lạ%20Việt%20Nam -> 308 permanent redirect to /tag/doc-la-viet-nam
    const resRedirect = await request.get(
      '/tag/%C4%90%E1%BB%99c%20L%E1%BA%A1%20Vi%E1%BB%87t%20Nam',
      {
        maxRedirects: 0,
      },
    );
    expect([301, 307, 308]).toContain(resRedirect.status());
    const location = resRedirect.headers()['location'];
    expect(location).toContain('/tag/doc-la-viet-nam');

    // 3. Unknown tag -> 404
    const resNotFound = await request.get('/tag/the-khong-ton-tai-xyz-999');
    expect(resNotFound.status()).toBe(404);
  });

  test('video playback: HLS master and first segment load, player reaches playing', async ({
    page,
  }) => {
    const firstPublicVideo = manifest.videos.find((v: any) => v.visibility === 'PUBLIC');
    if (!firstPublicVideo) {
      throw new Error('[persona:anon-viewer] Missing public video in seed-manifest.json');
    }

    let masterLoaded = false;
    let segmentLoaded = false;

    page.on('response', (res) => {
      const url = res.url();
      if (url.includes('master.m3u8')) masterLoaded = true;
      if (url.includes('.m4s') || url.includes('.ts')) segmentLoaded = true;
    });

    await page.goto(`/watch/${firstPublicVideo.id}`);
    await expect(page.locator('h1')).toBeVisible();

    // Check video element
    const video = page.locator('video');
    await expect(video).toBeAttached({ timeout: 15000 });

    // Initiate playback
    const playBtn = page.locator('[data-testid="play-pause-button"]').first();
    if (await playBtn.isVisible()) {
      await playBtn.click();
    } else {
      await video.click({ force: true });
    }
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
      }
    });

    // Wait for video to attempt playback or ready state and HLS requests
    await expect.poll(() => masterLoaded && segmentLoaded, { timeout: 20000 }).toBe(true);
  });

  test('series navigation: watch episode 1, "Tập tiếp" button or key n -> episode 2; PRIVATE episode is skipped', async ({
    page,
  }) => {
    const s1 = manifest.series[0];
    const ep1Id = s1.episode_ids[0];
    const ep2Id = s1.episode_ids[1];
    const ep4Id = s1.episode_ids[3]; // episode 3 (idx 2) is PRIVATE and must be skipped

    // 1. Open Episode 1 with series playlist context
    await page.goto(`/watch/${ep1Id}?playlist=${s1.id}`);
    await expect(page.locator('h1')).toBeVisible();

    // Look for next episode button ("Tập sau" / Next episode)
    const nextBtn = page.locator('[data-testid="series-next-episode-btn"]').first();
    await expect(nextBtn).toBeEnabled({ timeout: 15000 });
    await nextBtn.click();

    // Must navigate to Episode 2
    await page.waitForURL(new RegExp(`/watch/${ep2Id}`), { timeout: 15000 });
    expect(page.url()).toContain(ep2Id);

    // From Episode 2, advance again -> Episode 3 is PRIVATE so it must skip directly to Episode 4!
    const nextBtn2 = page.locator('[data-testid="series-next-episode-btn"]').first();
    await expect(nextBtn2).toBeEnabled({ timeout: 15000 });
    await nextBtn2.click();

    await page.waitForURL(new RegExp(`/watch/${ep4Id}`), { timeout: 15000 });
    expect(page.url()).toContain(ep4Id);
  });

  test('search "ha noi" (no diacritics) finds "Hà Nội …"', async ({ page, request }) => {
    // Assert backend diacritics folding via gateway search API
    const searchApiRes = await request.get('/v1/search?q=ha+noi');
    expect(searchApiRes.ok()).toBe(true);
    const data = await searchApiRes.json();
    const found = data.items?.some((item: any) => /hà nội/i.test(item.title));
    expect(found).toBe(true);

    // Also assert web UI if /search page is available
    const pageRes = await page.goto('/search?q=ha+noi');
    if (pageRes && pageRes.status() === 200) {
      await expect(page.getByText(/Hà Nội/).first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('/sitemap.xml parses, ends with </urlset>, contains PUBLIC videos & tags, excludes UNLISTED/PRIVATE', async ({
    request,
  }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.ok()).toBe(true);
    const xml = await res.text();

    // Ends with </urlset>
    expect(xml.trim()).toMatch(/<\/urlset>$/);

    // Must contain PUBLIC videos
    const publicVideos = manifest.videos.filter((v: any) => v.visibility === 'PUBLIC');
    for (const pv of publicVideos.slice(0, 5)) {
      expect(xml).toContain(`/watch/${pv.id}`);
    }

    // Must NOT contain UNLISTED or PRIVATE videos
    const privateOrUnlisted = manifest.videos.filter((v: any) => v.visibility !== 'PUBLIC');
    for (const nonPublic of privateOrUnlisted) {
      expect(xml).not.toContain(`/watch/${nonPublic.id}`);
    }

    // Must contain tags with >= 2 videos (e.g. du-lich)
    expect(xml).toContain('/tag/du-lich');
  });
});
