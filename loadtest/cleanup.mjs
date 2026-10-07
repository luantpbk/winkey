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

async function main() {
  console.log(`[cleanup] Starting data cleanup for target ${GATEWAY_URL}...`);

  // 1. Delete comments tracked in lt2_comments.json
  const commentsPath = path.join(__dirname, 'lt2_comments.json');
  const commentIdsToDelete = new Set();
  if (fs.existsSync(commentsPath)) {
    try {
      const comments = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
      if (Array.isArray(comments)) {
        for (const c of comments) {
          if (c && c.id) commentIdsToDelete.add(c.id);
        }
      }
    } catch (e) {
      console.warn(`[cleanup] Could not parse lt2_comments.json: ${e.message}`);
    }
  }

  // 2. Delete any lt2_* accounts found in lt2_accounts.json
  const lt2AccountsPath = path.join(__dirname, 'lt2_accounts.json');
  if (fs.existsSync(lt2AccountsPath)) {
    try {
      const accounts = JSON.parse(fs.readFileSync(lt2AccountsPath, 'utf8'));
      if (Array.isArray(accounts) && accounts.length > 0) {
        console.log(
          `[cleanup] Processing ${accounts.length} lt2_* accounts from lt2_accounts.json...`,
        );

        if (!envPassword) {
          console.warn(
            '[cleanup] WARNING: LOADTEST_USER_PASSWORD env var is missing. Cannot re-login to delete accounts.',
          );
        } else {
          for (const acc of accounts) {
            try {
              // Step 1: Re-login immediately before deletion to get a fresh access token
              console.log(`[cleanup] Logging in as ${acc.email} immediately before deletion...`);
              const loginRes = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  email: acc.email,
                  password: envPassword,
                }),
              });

              if (!loginRes.ok) {
                console.warn(
                  `[cleanup] Re-login failed for ${acc.email} (HTTP ${loginRes.status}). Skipping deletion.`,
                );
                continue;
              }

              const loginData = await loginRes.json();
              const freshToken = loginData.access_token;

              // Step 2: Delete any created comments using the fresh token
              if (commentIdsToDelete.size > 0) {
                for (const commentId of commentIdsToDelete) {
                  try {
                    const cRes = await fetch(`${GATEWAY_URL}/v1/comments/${commentId}`, {
                      method: 'DELETE',
                      headers: { Authorization: `Bearer ${freshToken}` },
                    });
                    if (cRes.status === 204 || cRes.status === 404) {
                      console.log(
                        `[cleanup] Deleted comment ${commentId} (status ${cRes.status}).`,
                      );
                    }
                  } catch (ce) {
                    console.warn(`[cleanup] Error deleting comment ${commentId}: ${ce.message}`);
                  }
                }
              }

              // Step 3: Call DELETE /v1/auth/me with confirm_handle and password
              console.log(`[cleanup] Calling DELETE /v1/auth/me for ${acc.handle}...`);
              const delRes = await fetch(`${GATEWAY_URL}/v1/auth/me`, {
                method: 'DELETE',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${freshToken}`,
                },
                body: JSON.stringify({
                  confirm_handle: acc.handle,
                  password: envPassword,
                }),
              });

              if (delRes.status === 204) {
                console.log(`[cleanup] SUCCESS: Account ${acc.handle} deleted (HTTP 204).`);
              } else {
                console.warn(
                  `[cleanup] FAILED: Account ${acc.handle} deletion returned HTTP ${delRes.status} (expected 204).`,
                );
              }
            } catch (err) {
              console.warn(`[cleanup] Error processing account ${acc.handle}: ${err.message}`);
            }
            await sleep(500);
          }
        }
      }
    } catch (err) {
      console.warn(`[cleanup] Error reading lt2_accounts.json: ${err.message}`);
    }
  }

  // 3. Clean up local temporary files
  const filesToRemove = [
    'seed.json',
    'videos.json',
    'users.json',
    'lt2_accounts.json',
    'lt2_tokens.json',
    'lt2_comments.json',
  ];
  for (const file of filesToRemove) {
    const fp = path.join(__dirname, file);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      console.log(`[cleanup] Removed local file ${file}`);
    }
  }

  console.log('[cleanup] Data cleanup completed successfully.');
}

main().catch((err) => {
  console.error('[cleanup] Fatal error during cleanup:', err);
  process.exit(1);
});
