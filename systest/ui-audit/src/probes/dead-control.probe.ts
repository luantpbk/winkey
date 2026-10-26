// systest/ui-audit/src/probes/dead-control.probe.ts
import { Page } from 'playwright';
import { AuditFinding, PersonaRole, ViewportSpec } from '../types.js';
import { DENYLIST_REGEX, DENYLIST_SELECTOR } from '../config/denylist.js';

interface StateSignature {
  url: string;
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  activeElement: { tag: string; id: string; className: string } | null;
  ariaStates: {
    pressed: string | null;
    expanded: string | null;
    selected: string | null;
    checked: string | null;
    current: string | null;
    hidden: string | null;
  };
  domLength: number;
  domHash: string;
  visibleCounts: {
    elements: number;
    dialogs: number;
  };
  networkRequestsCount: number;
}

interface TargetCandidate {
  index: number;
  tag: string;
  href: string | null;
  text: string;
  description: string;
}

export async function captureStateSignature(
  page: Page,
  networkCounter: { count: number },
): Promise<StateSignature> {
  const sig = (await page.evaluate(`(() => {
    var htmlAttrs = {};
    for (var i = 0; i < document.documentElement.attributes.length; i++) {
      var a = document.documentElement.attributes[i];
      htmlAttrs[a.name] = a.value;
    }
    var bodyAttrs = {};
    if (document.body) {
      for (var j = 0; j < document.body.attributes.length; j++) {
        var b = document.body.attributes[j];
        bodyAttrs[b.name] = b.value;
      }
    }
    var active = document.activeElement;
    var htmlStr = document.body ? document.body.innerHTML : '';
    var hash = 0;
    for (var k = 0; k < htmlStr.length; k++) {
      hash = ((hash << 5) - hash + htmlStr.charCodeAt(k)) | 0;
    }
    var localStore = {};
    try {
      for (var l = 0; l < localStorage.length; l++) {
        var key = localStorage.key(l);
        if (key) localStore[key] = localStorage.getItem(key) || '';
      }
    } catch (e) {}
    var sessionStore = {};
    try {
      for (var m = 0; m < sessionStorage.length; m++) {
        var sKey = sessionStorage.key(m);
        if (sKey) sessionStore[sKey] = sessionStorage.getItem(sKey) || '';
      }
    } catch (e) {}

    return {
      url: window.location.href,
      htmlAttrs: htmlAttrs,
      bodyAttrs: bodyAttrs,
      localStorage: localStore,
      sessionStorage: sessionStore,
      activeElement: active ? { tag: active.tagName.toLowerCase(), id: active.id || '', className: active.className || '' } : null,
      ariaStates: {
        pressed: active ? active.getAttribute('aria-pressed') : null,
        expanded: active ? active.getAttribute('aria-expanded') : null,
        selected: active ? active.getAttribute('aria-selected') : null,
        checked: active ? active.getAttribute('aria-checked') : null,
        current: active ? active.getAttribute('aria-current') : null,
        hidden: active ? active.getAttribute('hidden') : null
      },
      domLength: htmlStr.length,
      domHash: hash.toString(16),
      visibleCounts: {
        elements: document.querySelectorAll(':not([hidden])').length,
        dialogs: document.querySelectorAll('dialog[open], [role="dialog"]:not([hidden])').length
      }
    };
  })()`)) as Omit<StateSignature, 'networkRequestsCount'>;

  return { ...sig, networkRequestsCount: networkCounter.count };
}

export function diffSignatures(before: StateSignature, after: StateSignature): boolean {
  if (before.url !== after.url) return true;
  if (before.networkRequestsCount !== after.networkRequestsCount) return true;

  const cleanBefore = { ...before, networkRequestsCount: 0 };
  const cleanAfter = { ...after, networkRequestsCount: 0 };

  const bStr = JSON.stringify(cleanBefore);
  const aStr = JSON.stringify(cleanAfter);

  return bStr !== aStr;
}

export async function runDeadControlProbes(
  page: Page,
  vp: ViewportSpec,
  persona: PersonaRole,
  route: string,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const initialPageUrl = page.url();

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

  const initialLocators = await page.locator(interactiveSelectors).all();
  const candidates: TargetCandidate[] = [];

  for (let i = 0; i < initialLocators.length; i++) {
    if (candidates.length >= 80) break;

    const loc = initialLocators[i];
    try {
      const isVis = await loc.isVisible().catch(() => false);
      const isEn = await loc.isEnabled().catch(() => false);
      if (!isVis || !isEn) {
        continue;
      }

      const rawText = await loc.innerText().catch(() => '');
      const ariaLabel = (await loc.getAttribute('aria-label').catch(() => '')) || '';
      const title = (await loc.getAttribute('title').catch(() => '')) || '';
      const text = `${rawText} ${ariaLabel} ${title}`.trim();

      // Denylist safety check by regex
      if (DENYLIST_REGEX.test(text)) {
        continue;
      }

      // Denylist check by selector
      const isDenied = await loc
        .evaluate((el, selector) => el.matches(selector), DENYLIST_SELECTOR)
        .catch(() => false);
      if (isDenied) {
        continue;
      }

      const tagName = (await loc
        .evaluate((el) => el.tagName.toLowerCase())
        .catch(() => 'control')) as string;
      const href = await loc.getAttribute('href').catch(() => null);

      // Skip self-referencing links
      if (tagName === 'a' && href) {
        try {
          const resolved = new URL(href, initialPageUrl);
          const current = new URL(initialPageUrl);
          if (
            resolved.origin === current.origin &&
            resolved.pathname === current.pathname &&
            (!resolved.hash || resolved.hash === '#' || resolved.hash === current.hash) &&
            resolved.search === current.search
          ) {
            continue;
          }
        } catch {
          // If URL parsing fails, ignore self-check
        }
      }

      const accessibleName = (text || title || href || tagName).slice(0, 40);
      const description = `${tagName}${href ? `[href="${href}"]` : ''}: "${accessibleName}"`;

      candidates.push({
        index: i,
        tag: tagName,
        href,
        text,
        description,
      });
    } catch {
      continue;
    }
  }

  // Reload and test each candidate in a clean state to prevent state leaks
  for (const target of candidates) {
    try {
      await page
        .goto(initialPageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
        .catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});

      const currentLocators = await page.locator(interactiveSelectors).all();
      const loc = currentLocators[target.index];
      if (!loc || !(await loc.isVisible().catch(() => false))) {
        continue;
      }

      // 0. Skip elements that are already in active / selected state
      const isAlreadyActive = await loc
        .evaluate((el) => {
          const ac = el.getAttribute('aria-current');
          const as = el.getAttribute('aria-selected');
          const ap = el.getAttribute('aria-pressed');
          const da = el.getAttribute('data-active');
          const ds = el.getAttribute('data-state');
          return (
            (ac && ac !== 'false') ||
            as === 'true' ||
            ap === 'true' ||
            da === 'true' ||
            ds === 'active'
          );
        })
        .catch(() => false);

      if (isAlreadyActive) {
        continue;
      }

      // 1. Trial click to detect pointer interception / overlay
      try {
        await loc.click({ trial: true, timeout: 1500 });
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        let interceptor = '';
        const match =
          errMsg.match(/intercepts pointer events[^<]*<([^>]+)>/i) ||
          errMsg.match(/<([^>]+)>\s*intercepts/i);
        if (match) interceptor = match[1];

        findings.push({
          id: '',
          severity: 'P2',
          category: 'click-failed',
          persona,
          viewport: vp.id,
          route,
          selector: target.description,
          message: `Click failed or intercepted (${interceptor || 'pointer interception / timeout'}): ${errMsg.slice(0, 150)}`,
        });
        continue;
      }

      // Check if this is a search submit button with an empty query
      const isSearchWithEmptyQuery = await loc
        .evaluate((el) => {
          const tag = el.tagName.toLowerCase();
          const isButton = tag === 'button' || el.getAttribute('role') === 'button';
          if (!isButton) return false;

          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const text = (el.textContent || '').toLowerCase();
          const isSearch =
            el.getAttribute('type') === 'submit' ||
            ariaLabel.includes('search') ||
            ariaLabel.includes('tìm') ||
            text.includes('search') ||
            text.includes('tìm') ||
            el.className.includes('search');

          if (!isSearch) return false;

          const form = el.closest('form');
          const input = form
            ? (form.querySelector('input') as HTMLInputElement | null)
            : (document.querySelector(
                'input[type="search"], input[name="q"], input[placeholder*="Tìm"], input[placeholder*="Search"]',
              ) as HTMLInputElement | null);

          return input ? input.value.trim() === '' : false;
        })
        .catch(() => false);

      // 2. Pre-focus target element to align activeElement baseline
      await loc.focus({ timeout: 1000 }).catch(() => {});

      const networkCounter = { count: 0 };
      const onRequest = () => {
        networkCounter.count++;
      };
      page.on('request', onRequest);

      // Listen for popup / new tab (target="_blank" or window.open)
      let popupDetected = false;
      const onPopup = (p: Page) => {
        popupDetected = true;
        p.close().catch(() => {});
      };
      const onContextPage = (p: Page) => {
        if (p !== page) {
          popupDetected = true;
          p.close().catch(() => {});
        }
      };
      page.on('popup', onPopup);
      page.context().on('page', onContextPage);

      const beforeSig = await captureStateSignature(page, networkCounter);

      // 3. Perform click / interaction
      if (vp.inputMode === 'keyboard') {
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(400);
      } else if (
        target.tag === 'a' &&
        target.href &&
        !target.href.startsWith('#') &&
        !target.href.startsWith('javascript:')
      ) {
        await Promise.all([
          page.waitForURL((u) => u.href !== beforeSig.url, { timeout: 5000 }).catch(() => {}),
          loc.click({ timeout: 2000 }).catch(() => {}),
        ]);
        await page.waitForTimeout(400);
      } else {
        await loc.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(400);
      }

      const afterSig = await captureStateSignature(page, networkCounter);
      page.off('request', onRequest);
      page.off('popup', onPopup);
      page.context().off('page', onContextPage);

      // 4. Change detection
      const urlChanged = beforeSig.url !== afterSig.url;
      const networkChanged = networkCounter.count > 0;
      const stateChanged = diffSignatures(beforeSig, afterSig);

      if (!urlChanged && !networkChanged && !stateChanged && !popupDetected) {
        if (isSearchWithEmptyQuery) {
          findings.push({
            id: '',
            severity: 'P2',
            category: 'click-failed',
            persona,
            viewport: vp.id,
            route,
            selector: target.description,
            message: `Search button clicked with empty query: did not trigger navigation (expected empty search behavior, polish P2).`,
          });
          continue;
        }

        const isKnownBackendGap =
          target.href === '#history' ||
          target.text.toLowerCase().includes('lịch sử') ||
          target.text.toLowerCase().includes('thích');

        findings.push({
          id: '',
          severity: 'P0',
          category: 'dead-control',
          persona,
          viewport: vp.id,
          route,
          selector: target.description,
          message: `Dead control detected: Clicking element "${target.description}" did not trigger URL navigation, DOM mutation, storage change, active element change, popup/tab, or network requests.`,
          isBackendSuspect: isKnownBackendGap,
        });
      }
    } catch (err: any) {
      findings.push({
        id: '',
        severity: 'P2',
        category: 'click-failed',
        persona,
        viewport: vp.id,
        route,
        selector: target.description,
        message: `Unexpected interaction error: ${err?.message?.slice(0, 150) || String(err)}`,
      });
    }
  }

  return findings;
}
