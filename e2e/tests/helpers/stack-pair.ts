import { expect, type Browser, type BrowserContext, type Page, request } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two fresh users on a running stack (systest compose or `make dev` + web), who follow each other and share an
 * ACTIVE DIRECT conversation. Needs the invite code when registration is invite-only:
 * E2E_INVITE_CODE, or systest/.run/keys/invite_code.txt.
 */
export const STACK_URL = process.env.E2E_STACK_URL ?? 'http://127.0.0.1:8080';

function inviteCode(): string | undefined {
  if (process.env.E2E_INVITE_CODE) return process.env.E2E_INVITE_CODE;
  const file = path.resolve(here, '../../../systest/.run/keys/invite_code.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : undefined;
}

export interface StackUser {
  id: string;
  handle: string;
  email: string;
  password: string;
  name: string;
  token: string;
}

export async function createUser(label: string, name: string): Promise<StackUser> {
  const api = await request.newContext({ baseURL: STACK_URL });
  const suffix = crypto.randomBytes(4).toString('hex');
  const handle = `e2e_${label}_${suffix}`;
  const email = `${handle}@example.test`;
  const password = crypto.randomBytes(16).toString('hex');
  const reg = await api.post('/v1/auth/register', {
    data: { handle, email, display_name: name, password, invite_code: inviteCode() },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  const login = await api.post('/v1/auth/login', { data: { email, password } });
  expect(login.status()).toBe(200);
  const { access_token: token, user } = await login.json();
  await api.dispose();
  return { id: user.id, handle, email, password, name, token };
}

/**
 * Registration allows 5 sign-ups per IP per hour, so specs that do not need brand-new accounts share one pair,
 * kept in e2e/.stack-users.json (git-ignored, local test accounts only) and logged in again on every run.
 * Delete the file after resetting the stack.
 */
const SHARED_FILE = path.resolve(here, '../../.stack-users.json');

async function relogin(user: StackUser): Promise<StackUser | null> {
  const api = await request.newContext({ baseURL: STACK_URL });
  const res = await api.post('/v1/auth/login', {
    data: { email: user.email, password: user.password },
  });
  const token = res.ok() ? ((await res.json()).access_token as string) : null;
  await api.dispose();
  if (!token) return null;
  // chat-svc allows 10 active devices per user and every browser context registers one: drop the old ones.
  const authed = await request.newContext({
    baseURL: STACK_URL,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  const devices = await authed.get('/v1/chat/devices');
  for (const d of devices.ok() ? ((await devices.json()).items as { id: string }[]) : []) {
    expect((await authed.delete(`/v1/chat/devices/${d.id}`)).ok()).toBe(true);
  }
  await authed.dispose();
  return { ...user, token };
}

export async function sharedPair(): Promise<[StackUser, StackUser]> {
  if (fs.existsSync(SHARED_FILE)) {
    const [a, b] = JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8')) as [StackUser, StackUser];
    const [ra, rb] = await Promise.all([relogin(a), relogin(b)]);
    if (ra && rb) return [ra, rb];
  }
  const pair: [StackUser, StackUser] = [
    await createUser('an', 'An Thử Nghiệm'),
    await createUser('binh', 'Bình Thử Nghiệm'),
  ];
  fs.writeFileSync(SHARED_FILE, JSON.stringify(pair.map(({ token: _token, ...u }) => u)));
  return pair;
}

export async function apiAs(user: StackUser) {
  return request.newContext({
    baseURL: STACK_URL,
    extraHTTPHeaders: { authorization: `Bearer ${user.token}` },
  });
}

/** A and B follow each other; A starts a DIRECT conversation (B is ACTIVE because B follows A). */
export async function pairWithConversation(a: StackUser, b: StackUser): Promise<string> {
  const apiA = await apiAs(a);
  const apiB = await apiAs(b);
  expect((await apiA.put(`/v1/channels/${b.id}/subscription`)).status()).toBe(200);
  expect((await apiB.put(`/v1/channels/${a.id}/subscription`)).status()).toBe(200);
  const conv = await apiA.post('/v1/chat/conversations', {
    data: { kind: 'DIRECT', user_ids: [b.id] },
  });
  expect([200, 201]).toContain(conv.status());
  const id = (await conv.json()).id as string;
  await apiA.dispose();
  await apiB.dispose();
  return id;
}

/** A browser context with fake camera/microphone, permissions granted, CSP violations recorded on window.__csp. */
export async function mediaContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: STACK_URL,
    permissions: ['camera', 'microphone'],
    locale: 'vi-VN',
  });
  await context.addInitScript(() => {
    (window as unknown as { __csp: unknown[] }).__csp = [];
    window.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: unknown[] }).__csp.push({
        directive: e.violatedDirective,
        blocked: e.blockedURI,
      }),
    );
  });
  return context;
}

export async function login(page: Page, user: StackUser, returnTo = '/tin-nhan'): Promise<void> {
  await page.goto(`/vi/login?return_to=${encodeURIComponent(returnTo)}`);
  await page.locator('input[type="email"]').fill(user.email);
  await page.locator('input[type="password"]').fill(user.password);
  await page.locator('main form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
}

/** Opens /tin-nhan, waits for the E2EE device, then opens the conversation with `peerName`. */
export async function openConversation(page: Page, peerName: string): Promise<void> {
  if (!page.url().includes('/tin-nhan')) await page.goto('/vi/tin-nhan');
  const item = page.getByRole('button', { name: new RegExp(peerName) }).first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.click();
  await expect(page.getByPlaceholder(/Nhập tin nhắn/)).toBeEnabled({ timeout: 30_000 });
}

export async function cspViolations(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { __csp: unknown[] }).__csp ?? []);
}
