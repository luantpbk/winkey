// systest/ui-audit/src/probes/tv-nav.probe.ts
import { Page } from 'playwright';
import { AuditFinding, PersonaRole, ViewportSpec } from '../types.js';

export async function runTvNavProbes(
  page: Page,
  vp: ViewportSpec,
  persona: PersonaRole,
  route: string
): Promise<AuditFinding[]> {
  if (vp.inputMode !== 'keyboard') {
    return [];
  }

  const findings: AuditFinding[] = [];
  const tabSteps = 25;
  const visitedTags = new Set<string>();

  for (let i = 0; i < tabSteps; i++) {
    await page.keyboard.press('Tab');

    const focusInfo = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;

      const style = window.getComputedStyle(active);
      const hasOutline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      const hasBoxShadow = style.boxShadow !== 'none';
      const hasFocusRing = hasOutline || hasBoxShadow;

      return {
        tag: active.tagName.toLowerCase(),
        id: active.id || undefined,
        className: active.className ? String(active.className).split(' ')[0] : undefined,
        hasFocusRing,
        text: (active as HTMLElement).innerText?.slice(0, 30) || active.getAttribute('aria-label') || '',
      };
    });

    if (focusInfo) {
      const selector = `${focusInfo.tag}${focusInfo.id ? '#' + focusInfo.id : ''}${focusInfo.className ? '.' + focusInfo.className : ''}`;
      visitedTags.add(selector);

      if (!focusInfo.hasFocusRing) {
        findings.push({
          id: '',
          severity: 'P1',
          category: 'tv-focus',
          persona,
          viewport: vp.id,
          route,
          selector,
          message: `TV focus indicator missing: Element <${selector}> at Tab step ${i + 1} lacks a visible focus ring (outline or box-shadow).`,
        });
      }
    }
  }

  // Check dialog Esc behavior if dialog opened
  const dialogCount = await page.locator('dialog[open], [role="dialog"]').count();
  if (dialogCount > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const stillOpenCount = await page.locator('dialog[open], [role="dialog"]').count();
    if (stillOpenCount > 0) {
      findings.push({
        id: '',
        severity: 'P0',
        category: 'tv-focus',
        persona,
        viewport: vp.id,
        route,
        selector: 'dialog[open]',
        message: 'TV dialog trap: Pressing Escape key did not close open dialog.',
      });
    }
  }

  return findings;
}
