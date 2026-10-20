// systest/ui-audit/src/probes/dead-control.probe.ts
import { Page } from 'playwright';
import { AuditFinding, PersonaRole, ViewportSpec } from '../types.js';
import { DENYLIST_REGEX, DENYLIST_SELECTOR } from '../config/denylist.js';

export async function runDeadControlProbes(
  page: Page,
  vp: ViewportSpec,
  persona: PersonaRole,
  route: string
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  const interactiveSelectors = [
    'button',
    'a[href]',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="switch"]',
    '[role="checkbox"]',
    'select',
    'summary',
  ].join(', ');

  const locators = await page.locator(interactiveSelectors).all();
  let testedCount = 0;
  const initialPageUrl = page.url();

  for (const loc of locators) {
    if (testedCount >= 80) break;

    try {
      if (!(await loc.isVisible()) || !(await loc.isEnabled())) {
        continue;
      }

      const text = ((await loc.innerText().catch(() => '')) + ' ' + (await loc.getAttribute('aria-label') || '')).trim();

      // Denylist safety check by regex
      if (DENYLIST_REGEX.test(text)) {
        continue;
      }

      // Denylist check by selector
      const isDenied = await loc.evaluate((el, selector) => el.matches(selector), DENYLIST_SELECTOR).catch(() => false);
      if (isDenied) {
        continue;
      }

      testedCount++;

      // Record before state
      const beforeUrl = page.url();
      const beforeAriaExpanded = await loc.getAttribute('aria-expanded');
      const beforeAriaSelected = await loc.getAttribute('aria-selected');
      const beforeChecked = await loc.getAttribute('aria-checked');
      const beforeDialogCount = await page.locator('dialog[open], [role="dialog"]').count();
      const beforeDomLength = await page.evaluate(() => document.body.innerHTML.length);

      let networkRequestCount = 0;
      const onRequest = () => { networkRequestCount++; };
      page.on('request', onRequest);

      // Perform interaction
      if (vp.inputMode === 'keyboard') {
        await loc.focus({ timeout: 1000 }).catch(() => {});
        await page.keyboard.press('Enter').catch(() => {});
      } else {
        await loc.click({ timeout: 1500, noWaitAfter: true }).catch(() => {});
      }

      // Wait for either networkidle or 1 second
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {}),
        page.waitForTimeout(1000),
      ]);

      page.off('request', onRequest);

      // Record after state
      const afterUrl = page.url();
      const afterAriaExpanded = await loc.getAttribute('aria-expanded').catch(() => null);
      const afterAriaSelected = await loc.getAttribute('aria-selected').catch(() => null);
      const afterChecked = await loc.getAttribute('aria-checked').catch(() => null);
      const afterDialogCount = await page.locator('dialog[open], [role="dialog"]').count();
      const afterDomLength = await page.evaluate(() => document.body.innerHTML.length);

      const urlChanged = beforeUrl !== afterUrl;
      const stateChanged =
        beforeAriaExpanded !== afterAriaExpanded ||
        beforeAriaSelected !== afterAriaSelected ||
        beforeChecked !== afterChecked ||
        beforeDialogCount !== afterDialogCount ||
        Math.abs(beforeDomLength - afterDomLength) > 10;
      const networkChanged = networkRequestCount > 0;

      if (!urlChanged && !stateChanged && !networkChanged) {
        const tagName = await loc.evaluate(el => el.tagName.toLowerCase()).catch(() => 'control');
        const href = await loc.getAttribute('href').catch(() => null);
        const accessibleName = text || (await loc.getAttribute('title')) || tagName;

        const isKnownBackendGap =
          href === '#history' ||
          accessibleName.toLowerCase().includes('lịch sử') ||
          accessibleName.toLowerCase().includes('thích');

        findings.push({
          id: '',
          severity: 'P0',
          category: 'dead-control',
          persona,
          viewport: vp.id,
          route,
          selector: `${tagName}${href ? `[href="${href}"]` : ''}: "${accessibleName.slice(0, 30)}"`,
          message: `Dead control detected: Clicking element "${accessibleName.slice(0, 30)}" did not trigger URL change, DOM mutation, aria state change, or network requests.`,
          isBackendSuspect: isKnownBackendGap,
        });
      }

      // If URL navigated, restore back to test next element
      if (urlChanged) {
        await page.goto(initialPageUrl, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
      }
    } catch {
      // Element might have detached or errored on click
      continue;
    }
  }

  return findings;
}
