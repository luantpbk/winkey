// systest/ui-audit/src/probes/a11y.probe.ts
import { Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { AuditFinding, PersonaRole, ViewportSpec } from '../types.js';

export async function runA11yProbes(
  page: Page,
  vp: ViewportSpec,
  persona: PersonaRole,
  route: string,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  try {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    for (const v of results.violations) {
      if (v.impact === 'critical' || v.impact === 'serious') {
        const severity = v.impact === 'critical' ? 'P0' : 'P1';

        if (v.id === 'color-contrast') {
          for (const node of v.nodes) {
            const data = node.any?.[0]?.data || {};
            const selector = node.target?.join(' ') || 'document';
            const fg = data.fgColor || 'unknown';
            const bg = data.bgColor || 'unknown';
            const ratio = data.contrastRatio != null ? Number(data.contrastRatio).toFixed(2) : 'unknown';
            const expected = data.expectedContrastRatio != null ? `${data.expectedContrastRatio}:1` : '4.5:1';

            findings.push({
              id: '',
              severity,
              category: 'axe-a11y',
              persona,
              viewport: vp.id,
              route,
              selector,
              message: `[Axe a11y] color-contrast: Contrast ratio ${ratio}:1 (fg: ${fg}, bg: ${bg}, required: >= ${expected}) at selector "${selector}". Reported for #428.`,
            });
          }
        } else {
          const targetSelector = v.nodes[0]?.target?.join(' ') || 'document';
          findings.push({
            id: '',
            severity,
            category: 'axe-a11y',
            persona,
            viewport: vp.id,
            route,
            selector: targetSelector,
            message: `[Axe a11y] ${v.id}: ${v.help} (${v.description})`,
          });
        }
      }
    }
  } catch (error) {
    findings.push({
      id: '',
      severity: 'P1',
      category: 'axe-a11y',
      persona,
      viewport: vp.id,
      route,
      selector: 'document',
      message: `Failed to execute Axe core analyzer: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return findings;
}
