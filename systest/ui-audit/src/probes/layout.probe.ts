// systest/ui-audit/src/probes/layout.probe.ts
import { Page } from 'playwright';
import { AuditFinding, PersonaRole, ViewportSpec } from '../types.js';

export async function runLayoutProbes(
  page: Page,
  vp: ViewportSpec,
  persona: PersonaRole,
  route: string
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  const layoutEval = await page.evaluate(
    ({ isTouch }) => {
      const issues: { category: string; severity: string; selector: string; message: string }[] = [];

      // 1. Horizontal Overflow
      const scroller = document.scrollingElement || document.documentElement;
      if (scroller.scrollWidth > scroller.clientWidth + 2) {
        // Find widest offending element
        let widestEl: Element | null = null;
        let maxWidth = scroller.clientWidth;
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const rect = el.getBoundingClientRect();
          if (rect.right > maxWidth) {
            maxWidth = rect.right;
            widestEl = el;
          }
        }
        const selector = widestEl
          ? `${widestEl.tagName.toLowerCase()}${widestEl.id ? '#' + widestEl.id : ''}${widestEl.className ? '.' + String(widestEl.className).split(' ')[0] : ''}`
          : 'document.scrollingElement';

        issues.push({
          category: 'overflow-x',
          severity: 'P1',
          selector,
          message: `Horizontal overflow detected (scrollWidth: ${scroller.scrollWidth}px > clientWidth: ${scroller.clientWidth}px). Widest element exceeds by ${Math.round(maxWidth - scroller.clientWidth)}px.`,
        });
      }

      // 2. Touch targets < 44x44 CSS px
      if (isTouch) {
        const interactives = document.querySelectorAll<HTMLElement>(
          'button, a[href], [role="button"], [role="tab"], [role="menuitem"], select, input, textarea'
        );
        for (const el of interactives) {
          // Allow inline text links inside paragraphs/spans
          const parentTag = el.parentElement?.tagName.toLowerCase();
          if (el.tagName.toLowerCase() === 'a' && (parentTag === 'p' || parentTag === 'span')) {
            continue;
          }

          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.width < 44 || rect.height < 44) {
            const selector = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`;
            issues.push({
              category: 'touch-target',
              severity: 'P1',
              selector,
              message: `Touch target is ${Math.round(rect.width)}x${Math.round(rect.height)}px, smaller than required 44x44px. Text: "${el.innerText?.trim().slice(0, 30) || el.getAttribute('aria-label') || ''}"`,
            });
          }
        }
      }

      // 3. Clipped or overlapping text (scrollWidth > clientWidth without ellipsis)
      const textNodes = document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, p, span, a, button');
      for (const el of textNodes) {
        if (el.children.length > 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'inline' || style.overflow === 'visible') continue;
        if (el.scrollWidth > el.clientWidth + 4 && style.textOverflow !== 'ellipsis') {
          const selector = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`;
          issues.push({
            category: 'text-clip-overlap',
            severity: 'P1',
            selector,
            message: `Clipped text without ellipsis: text "${el.innerText?.slice(0, 30)}" overflows container width by ${el.scrollWidth - el.clientWidth}px.`,
          });
        }
      }

      return issues;
    },
    { isTouch: vp.inputMode === 'touch' }
  );

  for (const item of layoutEval) {
    findings.push({
      id: '',
      severity: item.severity as any,
      category: item.category as any,
      persona,
      viewport: vp.id,
      route,
      selector: item.selector,
      message: item.message,
    });
  }

  return findings;
}
