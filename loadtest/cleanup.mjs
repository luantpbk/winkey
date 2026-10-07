/* global fetch, console, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_URL = process.env.GATEWAY_URL || process.env.TARGET_URL || 'https://winkey.vn';

const isLocalhost =
  GATEWAY_URL.includes('localhost') ||
  GATEWAY_URL.includes('127.0.0.1') ||
  GATEWAY_URL.includes('[::1]');

const defaultPassword = isLocalhost ? 'Password123!' : undefined;
const envPassword = process.env.LOADTEST_USER_PASSWORD || defaultPassword;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCleanup(opts = {}) {
  const targetUrl = opts.targetUrl || GATEWAY_URL;
  const password = opts.password || envPassword;
  const customFetch = opts.fetchFn || fetch;

  console.log(`[cleanup] Starting data cleanup for target ${targetUrl}...`);

  // 1. Process lt2_comments.json
  const commentsPath = path.join(__dirname, 'lt2_comments.json');
  let comments = [];
  if (fs.existsSync(commentsPath)) {
    try {
      const raw = fs.readFileSync(commentsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) comments = parsed;
    } catch (e) {
      console.warn(`[cleanup] Could not parse lt2_comments.json: ${e.message}`);
    }
  }

  // 2. Process lt2_accounts.json
  const lt2AccountsPath = path.join(__dirname, 'lt2_accounts.json');
  let accounts = [];
  if (fs.existsSync(lt2AccountsPath)) {
    try {
      const raw = fs.readFileSync(lt2AccountsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) accounts = parsed;
    } catch (e) {
      console.warn(`[cleanup] Could not parse lt2_accounts.json: ${e.message}`);
    }
  }

  const failedComments = [];
  const failedAccounts = [];

  if (accounts.length > 0) {
    console.log(`[cleanup] Processing ${accounts.length} lt2_* accounts from lt2_accounts.json...`);

    if (!password) {
      console.warn(
        '[cleanup] WARNING: LOADTEST_USER_PASSWORD env var is missing. Cannot re-login to delete accounts.',
      );
      failedAccounts.push(...accounts);
      failedComments.push(...comments);
    } else {
      for (const acc of accounts) {
        let freshToken = null;
        let loginFailed = false;

        try {
          // Step 1: Re-login immediately before deletion to get a fresh access token
          console.log(`[cleanup] Logging in as ${acc.email} immediately before deletion...`);
          const loginRes = await customFetch(`${targetUrl}/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: acc.email,
              password,
            }),
          });

          if (!loginRes.ok) {
            console.warn(
              `[cleanup] Re-login failed for ${acc.email} (HTTP ${loginRes.status}). Account retained for retry.`,
            );
            loginFailed = true;
          } else {
            const loginData = await loginRes.json();
            freshToken = loginData.access_token;
          }
        } catch (err) {
          console.warn(
            `[cleanup] Login request error for ${acc.email}: ${err.message}. Account retained for retry.`,
          );
          loginFailed = true;
        }

        if (loginFailed || !freshToken) {
          failedAccounts.push(acc);
          continue;
        }

        // Step 2: Delete comments authored by this user
        const userComments = comments.filter(
          (c) => c.authorEmail === acc.email || c.authorHandle === acc.handle,
        );
        for (const c of userComments) {
          try {
            const cRes = await customFetch(`${targetUrl}/v1/comments/${c.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${freshToken}` },
            });
            if (cRes.status === 204 || cRes.status === 404) {
              console.log(`[cleanup] Deleted comment ${c.id} (status ${cRes.status}).`);
            } else {
              console.warn(
                `[cleanup] Comment ${c.id} deletion returned ${cRes.status}. Retaining for retry.`,
              );
              if (!failedComments.some((fc) => fc.id === c.id)) {
                failedComments.push(c);
              }
            }
          } catch (ce) {
            console.warn(`[cleanup] Error deleting comment ${c.id}: ${ce.message}. Retaining.`);
            if (!failedComments.some((fc) => fc.id === c.id)) {
              failedComments.push(c);
            }
          }
        }

        // Step 3: Call DELETE /v1/auth/me with confirm_handle and password
        try {
          console.log(`[cleanup] Calling DELETE /v1/auth/me for ${acc.handle}...`);
          const delRes = await customFetch(`${targetUrl}/v1/auth/me`, {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${freshToken}`,
            },
            body: JSON.stringify({
              confirm_handle: acc.handle,
              password,
            }),
          });

          if (delRes.status === 204) {
            console.log(`[cleanup] SUCCESS: Account ${acc.handle} deleted (HTTP 204).`);
          } else if (delRes.status === 404) {
            console.log(`[cleanup] Account ${acc.handle} already deleted (HTTP 404).`);
          } else {
            console.warn(
              `[cleanup] FAILED: Account ${acc.handle} deletion returned HTTP ${delRes.status} (expected 204). Retaining for retry.`,
            );
            failedAccounts.push(acc);
          }
        } catch (err) {
          console.warn(
            `[cleanup] Error deleting account ${acc.handle}: ${err.message}. Retaining.`,
          );
          failedAccounts.push(acc);
        }
        await sleep(500);
      }
    }
  }

  // Handle any orphaned comments not associated with known accounts
  const unhandledComments = comments.filter(
    (c) =>
      !accounts.some((a) => a.email === c.authorEmail || a.handle === c.authorHandle) &&
      !failedComments.some((fc) => fc.id === c.id),
  );
  if (unhandledComments.length > 0) {
    failedComments.push(...unhandledComments);
  }

  // 3. Persist remaining failed items for recovery retries, or unlink if clean
  if (failedComments.length > 0) {
    fs.writeFileSync(commentsPath, JSON.stringify(failedComments, null, 2), 'utf8');
    console.warn(
      `[cleanup] Retained ${failedComments.length} unremoved comments in ${commentsPath} for recovery retry.`,
    );
  } else if (fs.existsSync(commentsPath)) {
    fs.unlinkSync(commentsPath);
    console.log('[cleanup] Removed lt2_comments.json (all comments deleted).');
  }

  if (failedAccounts.length > 0) {
    fs.writeFileSync(lt2AccountsPath, JSON.stringify(failedAccounts, null, 2), 'utf8');
    console.warn(
      `[cleanup] Retained ${failedAccounts.length} unremoved accounts in ${lt2AccountsPath} for recovery retry.`,
    );
  } else if (fs.existsSync(lt2AccountsPath)) {
    fs.unlinkSync(lt2AccountsPath);
    console.log('[cleanup] Removed lt2_accounts.json (all accounts deleted).');
  }

  // Remove temporary seed / token files
  const filesToRemove = ['seed.json', 'videos.json', 'users.json', 'lt2_tokens.json'];
  for (const file of filesToRemove) {
    const fp = path.join(__dirname, file);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      console.log(`[cleanup] Removed local file ${file}`);
    }
  }

  console.log('[cleanup] Data cleanup execution completed.');
  return { failedAccounts, failedComments };
}

if (process.argv[1] && process.argv[1].endsWith('cleanup.mjs')) {
  runCleanup().catch((err) => {
    console.error('[cleanup] Fatal error during cleanup:', err);
    process.exit(1);
  });
}
