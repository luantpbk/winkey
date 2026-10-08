import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import { spawn, execSync, type ChildProcess } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Production Artifact Runtime FEEDBACK_URL Regression Test (ADR-034).
 *
 * Verifies that:
 * 1. Legal routes (/dieu-khoan, /quyen-rieng-tu, /quy-tac-cong-dong) remain statically prerendered ● (SSG).
 * 2. A SINGLE pre-compiled build artifact (.next) is used without any rebuilding.
 * 3. Successively starting the same artifact with empty, https, mailto, and unsafe FEEDBACK_URL
 *    dynamically configures the footer link at request/runtime on BOTH shells:
 *    - Cinema home shell (/)
 *    - Sidebar route shell (/dieu-khoan)
 * 4. Empty and unsafe protocol values completely hide the "Góp ý beta" link.
 * 5. Allowed https: and mailto: values render the exact URL with secure target/rel attributes.
 * 6. Mobile 375px sidebar drawer opens, exposes footer link, and is in viewport.
 * 7. Process management terminates ONLY the ChildProcess spawned by this suite (no port-based killing of unowned processes).
 */

const PROD_PORT = 3055;
const PROD_BASE_URL = `http://localhost:${PROD_PORT}`;
const webDir = path.resolve(__dirname, '../../apps/web');
const nextBin = path.resolve(webDir, 'node_modules/next/dist/bin/next');
const screenshotsDir = path.resolve(__dirname, '../screenshots');

function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  const isFree = await checkPortFree(port);
  if (!isFree) {
    throw new Error(
      `Port ${port} is already occupied by an external process. Refusing to kill unowned process. Please free port ${port} before running this suite.`,
    );
  }
}

function waitForHealth(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const check = () => {
      if (settled) return;
      if (Date.now() - start > timeoutMs) {
        cleanup();
        return reject(new Error(`Timeout waiting for ${url} after ${timeoutMs}ms`));
      }

      const req = http.get(url, { timeout: 2000 }, (res) => {
        // Drain response stream so socket is released and cannot hang
        res.resume();
        if (res.statusCode === 200) {
          cleanup();
          resolve();
        } else {
          timer = setTimeout(check, 250);
        }
      });

      req.on('timeout', () => {
        req.destroy();
      });

      req.on('error', () => {
        if (!settled) {
          timer = setTimeout(check, 250);
        }
      });

      req.end();
    };

    check();
  });
}

function fetchFeedbackApi(
  url: string,
  timeoutMs = 5000,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: { feedbackUrl: string | null };
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({ status: res.statusCode ?? 500, headers: res.headers, body: parsed });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout fetching ${url} after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.end();
  });
}

async function stopServer(proc: ChildProcess | null): Promise<void> {
  if (!proc || !proc.pid) return;

  const pid = proc.pid;
  const exitPromise = new Promise<void>((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', () => resolve());
    setTimeout(resolve, 8000);
  });

  try {
    if (process.platform === 'win32') {
      // Gracefully terminate the process tree owned by proc.pid only
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 2000);
    }
  } catch {
    // Process might have already exited
  }

  await exitPromise;

  // Poll until port is released by the exiting process (up to 5s)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const isFree = await checkPortFree(PROD_PORT);
    if (isFree) break;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function startServer(feedbackUrl: string): Promise<ChildProcess> {
  await assertPortAvailable(PROD_PORT);
  const proc = spawn('node', [nextBin, 'start', '-p', String(PROD_PORT)], {
    cwd: webDir,
    env: {
      ...process.env,
      PORT: String(PROD_PORT),
      NODE_ENV: 'production',
      FEEDBACK_URL: feedbackUrl,
      NEXT_PUBLIC_API_MOCKS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForHealth(`${PROD_BASE_URL}/healthz`);
  return proc;
}

test.describe.serial('BETA1-web: Production Artifact Runtime FEEDBACK_URL Verification', () => {
  let serverProcess: ChildProcess | null = null;

  test.beforeAll(async () => {
    fs.mkdirSync(screenshotsDir, { recursive: true });

    // 1. Verify production build artifact exists
    const dotNextDir = path.join(webDir, '.next');
    expect(fs.existsSync(dotNextDir)).toBe(true);

    // 2. Verify static prerendering in prerender-manifest.json
    const prerenderManifestPath = path.join(dotNextDir, 'prerender-manifest.json');
    expect(fs.existsSync(prerenderManifestPath)).toBe(true);

    const prerenderManifest = JSON.parse(fs.readFileSync(prerenderManifestPath, 'utf8'));
    const routes = Object.keys(prerenderManifest.routes ?? {});

    // Ensure legal routes are statically generated
    const hasTerms = routes.some((r) => r.includes('/dieu-khoan'));
    const hasPrivacy = routes.some((r) => r.includes('/quyen-rieng-tu'));
    const hasCommunity = routes.some((r) => r.includes('/quy-tac-cong-dong'));

    expect(hasTerms).toBe(true);
    expect(hasPrivacy).toBe(true);
    expect(hasCommunity).toBe(true);
  });

  test.afterEach(async () => {
    await stopServer(serverProcess);
    serverProcess = null;
  });

  test.afterAll(async () => {
    await stopServer(serverProcess);
    serverProcess = null;
  });

  test('Scenario 1: Empty FEEDBACK_URL on production build artifact -> hides link in both shells', async ({
    page,
  }) => {
    serverProcess = await startServer('');

    // 1. HTTP Endpoint check
    const httpRes = await fetchFeedbackApi(`${PROD_BASE_URL}/api/feedback-url`);
    expect(httpRes.status).toBe(200);
    expect(httpRes.body).toEqual({ feedbackUrl: null });

    // 2. Cinema Home Shell (/)
    await page.goto(`${PROD_BASE_URL}/`);
    await page.waitForLoadState('domcontentloaded');
    const cinemaFooter = page.locator('[data-testid="cinema-footer"]');
    await expect(cinemaFooter).toBeVisible();
    await expect(cinemaFooter.locator('a[href*="/dieu-khoan"]')).toBeVisible();
    await expect(
      cinemaFooter.locator('a').filter({ hasText: /Góp ý beta|Beta Feedback/ }),
    ).toHaveCount(0);

    // 3. Sidebar Shell Route (/dieu-khoan)
    await page.goto(`${PROD_BASE_URL}/dieu-khoan`);
    await page.waitForLoadState('domcontentloaded');
    const sidebarFooter = page.locator('[data-testid="sidebar-footer"]');
    await expect(sidebarFooter).toBeVisible();
    await expect(sidebarFooter.locator('a[href*="/quyen-rieng-tu"]')).toBeVisible();
    await expect(
      sidebarFooter.locator('a').filter({ hasText: /Góp ý beta|Beta Feedback/ }),
    ).toHaveCount(0);
  });

  test('Scenario 2: HTTPS FEEDBACK_URL on EXACT same build artifact -> renders URL in both shells', async ({
    page,
  }, testInfo) => {
    const testUrl = 'https://feedback.winkey.vn/beta-regression';

    serverProcess = await startServer(testUrl);

    // 1. HTTP Endpoint check
    const httpRes = await fetchFeedbackApi(`${PROD_BASE_URL}/api/feedback-url`);
    expect(httpRes.status).toBe(200);
    expect(httpRes.body).toEqual({ feedbackUrl: testUrl });

    // 2. Cinema Home Shell (/) - Desktop
    await page.goto(`${PROD_BASE_URL}/`);
    await page.waitForLoadState('domcontentloaded');
    const cinemaFooter = page.locator('[data-testid="cinema-footer"]');
    await expect(cinemaFooter).toBeVisible();

    const cinemaFeedbackLink = cinemaFooter
      .locator('a')
      .filter({ hasText: /Góp ý beta|Beta Feedback/ });
    await expect(cinemaFeedbackLink).toBeVisible({ timeout: 10000 });
    await expect(cinemaFeedbackLink).toHaveAttribute('href', testUrl);
    await expect(cinemaFeedbackLink).toHaveAttribute('target', '_blank');
    await expect(cinemaFeedbackLink).toHaveAttribute('rel', 'noopener noreferrer');

    const cinemaFooterImg = path.join(screenshotsDir, 'beta1-prod-cinema-footer-https.png');
    await cinemaFooter.scrollIntoViewIfNeeded();
    await page.screenshot({ path: cinemaFooterImg });
    await testInfo.attach('beta1-prod-cinema-footer-https', {
      path: cinemaFooterImg,
      contentType: 'image/png',
    });

    // 3. Sidebar Shell Route (/dieu-khoan) - Desktop
    await page.goto(`${PROD_BASE_URL}/dieu-khoan`);
    await page.waitForLoadState('domcontentloaded');
    const sidebarFooter = page.locator('[data-testid="sidebar-footer"]');
    await expect(sidebarFooter).toBeVisible();

    const sidebarFeedbackLink = sidebarFooter
      .locator('a')
      .filter({ hasText: /Góp ý beta|Beta Feedback/ });
    await expect(sidebarFeedbackLink).toBeVisible({ timeout: 10000 });
    await expect(sidebarFeedbackLink).toHaveAttribute('href', testUrl);
    await expect(sidebarFeedbackLink).toHaveAttribute('target', '_blank');
    await expect(sidebarFeedbackLink).toHaveAttribute('rel', 'noopener noreferrer');

    const sidebarFooterImg = path.join(screenshotsDir, 'beta1-prod-sidebar-footer-https.png');
    await sidebarFooter.scrollIntoViewIfNeeded();
    await page.screenshot({ path: sidebarFooterImg });
    await testInfo.attach('beta1-prod-sidebar-footer-https', {
      path: sidebarFooterImg,
      contentType: 'image/png',
    });

    // 4. Mobile viewport check (375px) on production build: open drawer, scroll to footer, verify in viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${PROD_BASE_URL}/dieu-khoan`);
    await page.waitForLoadState('domcontentloaded');

    // Click mobile drawer toggle button
    const menuBtn = page.locator('[data-testid="sidebar-toggle-btn"]');
    await expect(menuBtn).toBeVisible({ timeout: 10000 });
    await menuBtn.click();

    // Verify drawer sidebar footer
    const mobileSidebarFooter = page.locator('[data-testid="sidebar-footer"]');
    await expect(mobileSidebarFooter).toBeVisible({ timeout: 5000 });
    const mobileFeedbackLink = mobileSidebarFooter
      .locator('a')
      .filter({ hasText: /Góp ý beta|Beta Feedback/ });
    await expect(mobileFeedbackLink).toBeVisible({ timeout: 5000 });
    await expect(mobileFeedbackLink).toHaveAttribute('href', testUrl);

    // Scroll inside drawer so footer link is visibly in the active viewport
    await mobileFeedbackLink.scrollIntoViewIfNeeded();
    await expect(mobileFeedbackLink).toBeInViewport();

    const mobileSidebarImg = path.join(
      screenshotsDir,
      'beta1-prod-mobile-sidebar-footer-https.png',
    );
    await page.screenshot({ path: mobileSidebarImg });
    await testInfo.attach('beta1-prod-mobile-sidebar-footer-https', {
      path: mobileSidebarImg,
      contentType: 'image/png',
    });
  });

  test('Scenario 3: Mailto FEEDBACK_URL on EXACT same build artifact -> renders mailto link in both shells', async ({
    page,
  }) => {
    const mailtoUrl = 'mailto:beta@winkey.vn?subject=Feedback%20Test';

    serverProcess = await startServer(mailtoUrl);

    // 1. HTTP Endpoint check
    const httpRes = await fetchFeedbackApi(`${PROD_BASE_URL}/api/feedback-url`);
    expect(httpRes.status).toBe(200);
    expect(httpRes.body).toEqual({ feedbackUrl: mailtoUrl });

    // 2. Cinema Home Shell (/)
    await page.goto(`${PROD_BASE_URL}/`);
    await page.waitForLoadState('domcontentloaded');
    const cinemaFooter = page.locator('[data-testid="cinema-footer"]');
    const cinemaLink = cinemaFooter.locator('a').filter({ hasText: /Góp ý beta|Beta Feedback/ });
    await expect(cinemaLink).toBeVisible({ timeout: 10000 });
    await expect(cinemaLink).toHaveAttribute('href', mailtoUrl);

    // 3. Sidebar Shell Route (/dieu-khoan)
    await page.goto(`${PROD_BASE_URL}/dieu-khoan`);
    await page.waitForLoadState('domcontentloaded');
    const sidebarFooter = page.locator('[data-testid="sidebar-footer"]');
    const sidebarLink = sidebarFooter.locator('a').filter({ hasText: /Góp ý beta|Beta Feedback/ });
    await expect(sidebarLink).toBeVisible({ timeout: 10000 });
    await expect(sidebarLink).toHaveAttribute('href', mailtoUrl);
  });

  test('Scenario 4: Unsafe protocol FEEDBACK_URL on EXACT same build artifact -> hides link in both shells', async ({
    page,
  }) => {
    const unsafeUrl = 'http://insecure.example.com/feedback';

    serverProcess = await startServer(unsafeUrl);

    // 1. HTTP Endpoint check
    const httpRes = await fetchFeedbackApi(`${PROD_BASE_URL}/api/feedback-url`);
    expect(httpRes.status).toBe(200);
    expect(httpRes.body).toEqual({ feedbackUrl: null });

    // 2. Cinema Home Shell (/)
    await page.goto(`${PROD_BASE_URL}/`);
    await page.waitForLoadState('domcontentloaded');
    const cinemaFooter = page.locator('[data-testid="cinema-footer"]');
    await expect(
      cinemaFooter.locator('a').filter({ hasText: /Góp ý beta|Beta Feedback/ }),
    ).toHaveCount(0);

    // 3. Sidebar Shell Route (/dieu-khoan)
    await page.goto(`${PROD_BASE_URL}/dieu-khoan`);
    await page.waitForLoadState('domcontentloaded');
    const sidebarFooter = page.locator('[data-testid="sidebar-footer"]');
    await expect(
      sidebarFooter.locator('a').filter({ hasText: /Góp ý beta|Beta Feedback/ }),
    ).toHaveCount(0);
  });
});
