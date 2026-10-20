// systest/ui-audit/src/core/vitals.ts
import { Page } from 'playwright';

export interface VitalsResult {
  lcp: number | null;
  cls: number;
}

export const VITALS_INIT_SCRIPT = `
  (function() {
    window.__vitals = { lcp: null, cls: 0 };

    try {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) {
          window.__vitals.lcp = lastEntry.startTime;
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });

      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            window.__vitals.cls += entry.value || 0;
          }
        }
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
    } catch (e) {
      console.warn('[Vitals] PerformanceObserver error:', e);
    }
  })();
`;

/**
 * Collect performance vitals from current page context
 */
export async function collectVitals(page: Page): Promise<VitalsResult> {
  return await page.evaluate(() => {
    const rawVitals = (window as any).__vitals;
    return {
      lcp: rawVitals?.lcp ?? null,
      cls: rawVitals?.cls ?? 0,
    };
  });
}
