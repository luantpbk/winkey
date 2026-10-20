// systest/ui-audit/src/core/auth.ts
import { Browser, BrowserContext } from 'playwright';
import { PersonaRole, ViewportSpec } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';

const AUTH_CACHE_DIR = path.resolve(process.cwd(), 'systest/ui-audit/.auth-cache');

export async function createPersonaContext(
  browser: Browser,
  persona: PersonaRole,
  baseUrl: string,
  vp: ViewportSpec,
): Promise<BrowserContext> {
  if (!fs.existsSync(AUTH_CACHE_DIR)) {
    fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true });
  }

  const statePath = path.join(AUTH_CACHE_DIR, `${persona}-state.json`);

  if (persona === 'anon') {
    return browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr,
      hasTouch: vp.inputMode === 'touch',
      isMobile: vp.id.startsWith('mobile'),
    });
  }

  if (fs.existsSync(statePath)) {
    return browser.newContext({
      storageState: statePath,
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr,
      hasTouch: vp.inputMode === 'touch',
      isMobile: vp.id.startsWith('mobile'),
    });
  }

  // Pre-authenticate persona
  const tempContext = await browser.newContext();
  const page = await tempContext.newPage();
  try {
    const creds: Record<string, { email: string; pass: string }> = {
      member: { email: 'sim_u01@example.com', pass: 'TestPassword123!' },
      creator: { email: 'sim_curator@example.com', pass: 'TestPassword123!' },
      admin: { email: 'sim_mod@example.com', pass: 'TestPassword123!' },
    };

    const targetCred = creds[persona] || {
      email: `${persona}@example.com`,
      pass: 'TestPassword123!',
    };

    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.fill(
      'input[type="email"], input[name="email"], input[name="login"]',
      targetCred.email,
    );
    await page.fill('input[type="password"], input[name="password"]', targetCred.pass);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
    await tempContext.storageState({ path: statePath });
  } catch (err) {
    console.warn(`[Auth] Warning: Could not pre-authenticate persona ${persona}:`, err);
  } finally {
    await tempContext.close();
  }

  const opts: any = {
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    hasTouch: vp.inputMode === 'touch',
    isMobile: vp.id.startsWith('mobile'),
  };
  if (fs.existsSync(statePath)) {
    opts.storageState = statePath;
  }
  return browser.newContext(opts);
}
