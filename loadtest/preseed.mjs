/* global fetch, console, process, setTimeout */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'https://winkey.vn';
const envPassword = process.env.LOADTEST_USER_PASSWORD;
const inviteCode = process.env.LT2_INVITE_CODE || '';

const isLocalhost =
  TARGET_URL.includes('localhost') ||
  TARGET_URL.includes('127.0.0.1') ||
  TARGET_URL.includes('[::1]');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const defaultPass = isLocalhost ? 'Password123!' : undefined;
  const password = envPassword || defaultPass;

  if (!password) {
    console.error(
      '[preseed] ERROR: LOADTEST_USER_PASSWORD environment variable is required for production / non-localhost targets.',
    );
    process.exit(1);
  }

  console.log(`[preseed] Preparing 5 lt2 temporary accounts for target ${TARGET_URL}...`);

  // Fixed 5 handles for lt2 test accounts
  const accountMeta = [];

  for (let i = 1; i <= 5; i++) {
    const handle = `lt2_user${i}_${Math.random().toString(36).substring(2, 8)}`;
    const email = `${handle}@example.com`;
    accountMeta.push({ handle, email });
  }

  // 1. Write lt2_accounts.json IMMEDIATELY (no passwords or tokens in this file)
  const accountsFile = path.join(__dirname, 'lt2_accounts.json');
  fs.writeFileSync(accountsFile, JSON.stringify(accountMeta, null, 2), 'utf8');
  console.log(`[preseed] Pre-created ${accountsFile} (handles and emails only).`);

  // Initialize empty comments file if missing
  const commentsFile = path.join(__dirname, 'lt2_comments.json');
  if (!fs.existsSync(commentsFile)) {
    fs.writeFileSync(commentsFile, JSON.stringify([], null, 2), 'utf8');
  }

  // 2. Register each of the 5 accounts via POST /v1/auth/register
  const pacingMs = parseInt(process.env.PRESEED_PACING_MS || '1200', 10);

  for (const acc of accountMeta) {
    try {
      console.log(`[preseed] Registering account ${acc.handle}...`);
      const regRes = await fetch(`${TARGET_URL}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: acc.email,
          password,
          handle: acc.handle,
          display_name: `LT2 Test User ${acc.handle}`,
          ...(inviteCode ? { invite_code: inviteCode } : {}),
        }),
      });

      if (regRes.status === 201) {
        console.log(`[preseed] Registered ${acc.handle} successfully (201).`);
      } else if (regRes.status === 409) {
        // If account already existed, log in
        console.log(`[preseed] Account ${acc.handle} exists (409). Logging in...`);
        const loginRes = await fetch(`${TARGET_URL}/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: acc.email, password }),
        });
        if (loginRes.ok) {
          console.log(`[preseed] Logged in ${acc.handle} successfully.`);
        }
      } else {
        console.error(
          `[preseed] ERROR: Registration returned status ${regRes.status} for ${acc.handle}. Fail-closed abort.`,
        );
        process.exit(1);
      }
    } catch (err) {
      console.error(
        `[preseed] ERROR: Registration request failed for ${acc.handle}: ${err.message}. Fail-closed abort.`,
      );
      process.exit(1);
    }
    await sleep(pacingMs); // pacing to respect rate limits
  }

  console.log(
    `[preseed] Successfully prepared ${accountMeta.length} accounts (handles and emails persisted to lt2_accounts.json).`,
  );
}

main().catch((err) => {
  console.error('[preseed] Fatal error:', err);
  process.exit(1);
});
