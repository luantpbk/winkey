import { test, expect } from '@playwright/test';

const DIAGNOSTIC_INIT_SCRIPT = `
  (function() {
    window.__shifts = [];
    window.__cls = 0;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            window.__cls += entry.value;
            const sources = [];
            if (entry.sources) {
              for (const s of entry.sources) {
                const node = s.node;
                sources.push({
                  nodeTag: node?.tagName || (node?.nodeType === 3 ? '#text' : 'unknown'),
                  nodeId: node?.id || '',
                  nodeClass: typeof node?.className === 'string' ? node.className : '',
                  nodeText: node?.textContent?.slice(0, 80)?.trim() || '',
                  outerHtml: node?.outerHTML?.slice(0, 100) || '',
                  prevY: s.previousRect?.y,
                  currY: s.currentRect?.y,
                  prevHeight: s.previousRect?.height,
                  currHeight: s.currentRect?.height,
                });
              }
            }
            window.__shifts.push({
              value: entry.value,
              sources,
            });
          }
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
    } catch (e) {
      console.warn('Observer error:', e);
    }
  })();
`;

test.describe('CLS Diagnostic Measurement with Authenticated Personas', () => {
  test('Diagnose /thu-vien on mobile-s (360x800) with member persona', async ({
    page,
    context,
  }) => {
    // 1. Log in as member persona
    await page.goto('/login');
    await page.fill(
      'input[type="email"], input[name="email"], input[name="login"]',
      'sim_u01@example.com',
    );
    await page.fill('input[type="password"], input[name="password"]', 'TestPassword123!');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1000);

    // 2. Open /thu-vien with PerformanceObserver
    const auditPage = await context.newPage();
    await auditPage.setViewportSize({ width: 360, height: 800 });
    await auditPage.addInitScript(DIAGNOSTIC_INIT_SCRIPT);

    await auditPage.goto('/thu-vien', { waitUntil: 'domcontentloaded' });
    await auditPage.waitForTimeout(2500);

    const result = await auditPage.evaluate(() => ({
      cls: (window as any).__cls,
      shifts: (window as any).__shifts,
    }));

    console.log('=== AUTHENTICATED CLS RESULT FOR /thu-vien (mobile-s) ===');
    console.log(`TOTAL CLS: ${result.cls}`);
    console.log(`SHIFTS DETAIL:`, JSON.stringify(result.shifts, null, 2));
    expect(result.cls).toBeLessThan(0.05);
    await auditPage.close();
  });

  test('Diagnose /playlist/:id on mobile-s (360x800) with anon persona', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.addInitScript(DIAGNOSTIC_INIT_SCRIPT);

    await page.goto('/playlist/0192f5e4-7c1a-7b3e-9d2a-a00000000001', {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(2500);

    const result = await page.evaluate(() => ({
      cls: (window as any).__cls,
      shifts: (window as any).__shifts,
    }));

    console.log('=== CLS RESULT FOR /playlist/:id (mobile-s) ===');
    console.log(`TOTAL CLS: ${result.cls}`);
    console.log(`SHIFTS DETAIL:`, JSON.stringify(result.shifts, null, 2));
    expect(result.cls).toBeLessThan(0.05);
  });

  test('Diagnose /upload on tablet-l (1024x768) with creator persona', async ({
    page,
    context,
  }) => {
    // 1. Log in as creator persona
    await page.goto('/login');
    await page.fill(
      'input[type="email"], input[name="email"], input[name="login"]',
      'sim_curator@example.com',
    );
    await page.fill('input[type="password"], input[name="password"]', 'TestPassword123!');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1000);

    // 2. Open /upload with PerformanceObserver
    const auditPage = await context.newPage();
    await auditPage.setViewportSize({ width: 1024, height: 768 });
    await auditPage.addInitScript(DIAGNOSTIC_INIT_SCRIPT);

    await auditPage.goto('/upload', { waitUntil: 'domcontentloaded' });
    await auditPage.waitForTimeout(2500);

    const result = await auditPage.evaluate(() => ({
      cls: (window as any).__cls,
      shifts: (window as any).__shifts,
    }));

    console.log('=== AUTHENTICATED CLS RESULT FOR /upload (tablet-l) ===');
    console.log(`TOTAL CLS: ${result.cls}`);
    console.log(`SHIFTS DETAIL:`, JSON.stringify(result.shifts, null, 2));
    expect(result.cls).toBeLessThan(0.05);
    await auditPage.close();
  });
});
