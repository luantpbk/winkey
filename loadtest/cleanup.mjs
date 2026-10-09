/* global fetch, console, process, AbortSignal */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepMs } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_URL = process.env.GATEWAY_URL || process.env.TARGET_URL || 'https://winkey.vn';

const isLocalhost =
  GATEWAY_URL.includes('localhost') ||
  GATEWAY_URL.includes('127.0.0.1') ||
  GATEWAY_URL.includes('[::1]');

const defaultPassword = isLocalhost ? 'Password123!' : undefined;
const envPassword = process.env.LOADTEST_USER_PASSWORD || defaultPassword;

async function sleep(ms) {
  await sleepMs(ms);
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, filePath);
}

export async function runCleanup(opts = {}) {
  const targetUrl = opts.targetUrl || GATEWAY_URL;
  const password = opts.password || envPassword;
  const customFetch =
    opts.fetchFn ||
    (process.env.DRY_RUN === 'true'
      ? async (url, options = {}) => {
          const method = (options.method || 'GET').toUpperCase();
          if (method === 'GET') {
            return {
              ok: true,
              status: 200,
              json: async () => ({ items: [], next_cursor: null, access_token: 'mock_dry_token' }),
            };
          }
          return {
            ok: true,
            status: 204,
            json: async () => ({ access_token: 'mock_dry_token' }),
          };
        }
      : fetch);

  console.log(`[cleanup] Starting data cleanup for target ${targetUrl}...`);

  // 1. Process lt2_comments.json
  const commentsPath = path.join(__dirname, 'lt2_comments.json');
  let comments = [];
  if (fs.existsSync(commentsPath)) {
    try {
      const raw = fs.readFileSync(commentsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) comments = parsed;
      else throw new Error('lt2_comments.json content is not an array');
    } catch (e) {
      console.error(
        `[cleanup] ERROR: Failed to parse lt2_comments.json: ${e.message}. Fail-closed abort to prevent data loss.`,
      );
      throw new Error(`Corrupt lt2_comments.json: ${e.message}`);
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
      else throw new Error('lt2_accounts.json content is not an array');
    } catch (e) {
      console.error(
        `[cleanup] ERROR: Failed to parse lt2_accounts.json: ${e.message}. Fail-closed abort to prevent data loss.`,
      );
      throw new Error(`Corrupt lt2_accounts.json: ${e.message}`);
    }
  }

  // 2b. Comment Discovery: Scan target videos to recover un-journaled lt2_* comments if collector ACK was lost
  let discoveryIncomplete = false;
  const discoveryTimeoutMs = opts.discoveryTimeoutMs || 30000;
  const discoveryStartTime = Date.now();

  try {
    const allDiscoveredVideos = [];
    let videoCursor = null;
    const seenVideoCursors = new Set();
    let videoPages = 0;
    const MAX_VIDEO_PAGES = 50;

    do {
      const elapsed = Date.now() - discoveryStartTime;
      if (elapsed > discoveryTimeoutMs) {
        discoveryIncomplete = true;
        console.warn(
          '[cleanup] WARNING: Video discovery scan exceeded timeout limit. Marking discovery incomplete.',
        );
        break;
      }
      const remainingMs = Math.max(1, discoveryTimeoutMs - elapsed);
      const reqSignal = AbortSignal.timeout ? AbortSignal.timeout(remainingMs) : undefined;
      const fetchOpts = reqSignal ? { signal: reqSignal } : {};

      const vUrl = videoCursor
        ? `${targetUrl}/v1/videos?sort=newest&limit=50&cursor=${encodeURIComponent(videoCursor)}`
        : `${targetUrl}/v1/videos?sort=newest&limit=50`;
      const vRes = await customFetch(vUrl, fetchOpts);

      if (!vRes || vRes.status !== 200 || !vRes.ok) {
        discoveryIncomplete = true;
        console.warn(
          `[cleanup] WARNING: Video listing returned status ${vRes ? vRes.status : 'network error'}. Rejecting non-200 discovery response.`,
        );
        break;
      }

      let vData;
      try {
        vData = await vRes.json();
      } catch (err) {
        discoveryIncomplete = true;
        console.warn(`[cleanup] WARNING: Invalid JSON payload in video listing: ${err.message}`);
        break;
      }

      if (!vData || typeof vData !== 'object' || !Array.isArray(vData.items)) {
        discoveryIncomplete = true;
        console.warn(
          '[cleanup] WARNING: Invalid payload structure in video listing (items is not an array).',
        );
        break;
      }

      // Validate required next_cursor field and type per contract
      if (
        vData.next_cursor === undefined ||
        (vData.next_cursor !== null && typeof vData.next_cursor !== 'string')
      ) {
        discoveryIncomplete = true;
        console.warn(
          '[cleanup] WARNING: Missing or invalid next_cursor in video listing (expected string or null).',
        );
        break;
      }

      videoPages++;
      if (videoPages > MAX_VIDEO_PAGES) {
        discoveryIncomplete = true;
        console.warn('[cleanup] WARNING: Video listing exceeded max page limit.');
        break;
      }
      if (vData.next_cursor) {
        if (seenVideoCursors.has(vData.next_cursor)) {
          discoveryIncomplete = true;
          console.warn('[cleanup] WARNING: Detected cycle in video next_cursor.');
          break;
        }
        seenVideoCursors.add(vData.next_cursor);
      }

      // Validate record structures
      let validItems = true;
      for (const item of vData.items) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
          validItems = false;
          break;
        }
      }
      if (!validItems) {
        discoveryIncomplete = true;
        console.warn('[cleanup] WARNING: Malformed video item record in video listing.');
        break;
      }

      allDiscoveredVideos.push(...vData.items);
      videoCursor = vData.next_cursor || null;
    } while (videoCursor);

    if (!discoveryIncomplete) {
      for (const vid of allDiscoveredVideos) {
        if (Date.now() - discoveryStartTime > discoveryTimeoutMs) {
          discoveryIncomplete = true;
          console.warn(
            '[cleanup] WARNING: Comment discovery scan exceeded timeout limit. Marking discovery incomplete.',
          );
          break;
        }

        if (!vid || !vid.id) continue;
        let commentCursor = null;
        const seenCommentCursors = new Set();
        let commentPages = 0;
        const MAX_COMMENT_PAGES = 50;

        do {
          const cElapsed = Date.now() - discoveryStartTime;
          if (cElapsed > discoveryTimeoutMs) {
            discoveryIncomplete = true;
            console.warn(
              '[cleanup] WARNING: Comment discovery scan exceeded timeout limit during pagination. Marking discovery incomplete.',
            );
            break;
          }
          const cRemainingMs = Math.max(1, discoveryTimeoutMs - cElapsed);
          const cReqSignal = AbortSignal.timeout ? AbortSignal.timeout(cRemainingMs) : undefined;
          const cFetchOpts = cReqSignal ? { signal: cReqSignal } : {};

          const cUrl = commentCursor
            ? `${targetUrl}/v1/videos/${vid.id}/comments?cursor=${encodeURIComponent(commentCursor)}`
            : `${targetUrl}/v1/videos/${vid.id}/comments`;
          const cRes = await customFetch(cUrl, cFetchOpts);

          if (!cRes || cRes.status !== 200 || !cRes.ok) {
            discoveryIncomplete = true;
            console.warn(
              `[cleanup] WARNING: Comment discovery failed for video ${vid.id} (status ${cRes ? cRes.status : 'network error'}). Rejecting non-200 response.`,
            );
            break;
          }

          let cData;
          try {
            cData = await cRes.json();
          } catch (err) {
            discoveryIncomplete = true;
            console.warn(
              `[cleanup] WARNING: Invalid JSON in comment response for video ${vid.id}: ${err.message}`,
            );
            break;
          }

          if (!cData || typeof cData !== 'object' || !Array.isArray(cData.items)) {
            discoveryIncomplete = true;
            console.warn(
              `[cleanup] WARNING: Invalid comment payload structure for video ${vid.id} (items is not an array).`,
            );
            break;
          }

          // Validate required next_cursor field and type per contract
          if (
            cData.next_cursor === undefined ||
            (cData.next_cursor !== null && typeof cData.next_cursor !== 'string')
          ) {
            discoveryIncomplete = true;
            console.warn(
              `[cleanup] WARNING: Missing or invalid next_cursor in comment response for video ${vid.id}.`,
            );
            break;
          }

          commentPages++;
          if (commentPages > MAX_COMMENT_PAGES) {
            discoveryIncomplete = true;
            console.warn(
              `[cleanup] WARNING: Comment listing for video ${vid.id} exceeded max page limit.`,
            );
            break;
          }
          if (cData.next_cursor) {
            if (seenCommentCursors.has(cData.next_cursor)) {
              discoveryIncomplete = true;
              console.warn(
                `[cleanup] WARNING: Detected cycle in comment next_cursor for video ${vid.id}.`,
              );
              break;
            }
            seenCommentCursors.add(cData.next_cursor);
          }

          for (const item of cData.items) {
            if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
              discoveryIncomplete = true;
              console.warn(
                `[cleanup] WARNING: Malformed comment record in comment list for video ${vid.id}.`,
              );
              break;
            }

            const authorObj = item.author || item.user || {};
            const authorHandle =
              typeof authorObj.handle === 'string' ? authorObj.handle : item.authorHandle || '';
            const authorId = typeof authorObj.id === 'string' ? authorObj.id : item.authorId || '';

            // Detect conflicting author metadata (authorId points to account A, but handle points to account B)
            const matchingByHandle = accounts.find((a) => a.handle === authorHandle);
            const matchingById = accounts.find((a) => a.id && a.id === authorId);
            if (
              matchingByHandle &&
              matchingById &&
              matchingByHandle.handle !== matchingById.handle
            ) {
              discoveryIncomplete = true;
              console.warn(
                `[cleanup] WARNING: Conflicting author metadata for comment ${item.id}: handle '${authorHandle}' vs id '${authorId}'. Retaining fail-closed.`,
              );
              break;
            }

            if (
              authorHandle.startsWith('lt2_') ||
              accounts.some((a) => a.handle === authorHandle || (a.id && a.id === authorId))
            ) {
              if (!comments.some((existing) => existing.id === item.id)) {
                console.log(
                  `[cleanup] Discovered un-journaled comment ${item.id} by ${authorHandle}. Adding to cleanup list.`,
                );
                comments.push({
                  id: item.id,
                  authorId,
                  authorHandle,
                  createdAt: item.created_at || new Date().toISOString(),
                });
              }
            }
          }

          if (discoveryIncomplete) break;
          commentCursor = cData.next_cursor || null;
        } while (commentCursor);

        if (discoveryIncomplete) break;
      }
    }
  } catch (err) {
    discoveryIncomplete = true;
    console.warn(`[cleanup] Comment discovery scan warning: ${err.message}`);
  }

  const failedComments = [];
  const failedAccounts = [];

  const discoveryTotalElapsed = Date.now() - discoveryStartTime;
  if (discoveryIncomplete || discoveryTotalElapsed > discoveryTimeoutMs) {
    discoveryIncomplete = true;
    console.error(
      `[cleanup] ERROR: Comment discovery scan failed, rejected non-200/invalid payload, or exceeded deadline (${discoveryTotalElapsed}ms / ${discoveryTimeoutMs}ms). Retaining all accounts and comments for retry recovery without deleting accounts.`,
    );
    failedAccounts.push(...accounts);
    failedComments.push(...comments);
  } else if (accounts.length > 0) {
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
              `[cleanup] Re-login failed for ${acc.email} (HTTP ${loginRes.status}). Account and comments retained for retry.`,
            );
            loginFailed = true;
          } else {
            const loginData = await loginRes.json();
            freshToken = loginData.access_token;
          }
        } catch (err) {
          console.warn(
            `[cleanup] Login request error for ${acc.email}: ${err.message}. Account and comments retained for retry.`,
          );
          loginFailed = true;
        }

        if (loginFailed || !freshToken) {
          failedAccounts.push(acc);
          const userComments = comments.filter(
            (c) =>
              c.authorHandle === acc.handle ||
              (acc.id && c.authorId && c.authorId === acc.id) ||
              (c.authorEmail && c.authorEmail === acc.email),
          );
          for (const c of userComments) {
            if (!failedComments.some((fc) => fc.id === c.id)) {
              failedComments.push(c);
            }
          }
          continue;
        }

        // Step 2: Delete comments authored by this user
        const userComments = comments.filter(
          (c) =>
            c.authorHandle === acc.handle ||
            (acc.id && c.authorId && c.authorId === acc.id) ||
            (c.authorEmail && c.authorEmail === acc.email),
        );
        let userCommentFailed = false;

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
              userCommentFailed = true;
              if (!failedComments.some((fc) => fc.id === c.id)) {
                failedComments.push(c);
              }
            }
          } catch (ce) {
            console.warn(`[cleanup] Error deleting comment ${c.id}: ${ce.message}. Retaining.`);
            userCommentFailed = true;
            if (!failedComments.some((fc) => fc.id === c.id)) {
              failedComments.push(c);
            }
          }
        }

        if (userCommentFailed) {
          console.warn(
            `[cleanup] Account ${acc.handle} has unremoved comments. Retaining user account for retry recovery.`,
          );
          failedAccounts.push(acc);
          continue;
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
      !accounts.some(
        (a) =>
          a.handle === c.authorHandle ||
          (a.id && c.authorId && c.authorId === a.id) ||
          (c.authorEmail && a.email === c.authorEmail),
      ) && !failedComments.some((fc) => fc.id === c.id),
  );
  if (unhandledComments.length > 0) {
    failedComments.push(...unhandledComments);
  }

  // 3. Persist remaining failed items for recovery retries, or unlink if clean
  if (failedComments.length > 0) {
    atomicWriteJson(commentsPath, failedComments);
    console.warn(
      `[cleanup] Retained ${failedComments.length} unremoved comments in ${commentsPath} for recovery retry.`,
    );
  } else if (fs.existsSync(commentsPath)) {
    fs.unlinkSync(commentsPath);
    console.log('[cleanup] Removed lt2_comments.json (all comments deleted).');
  }

  if (failedAccounts.length > 0) {
    atomicWriteJson(lt2AccountsPath, failedAccounts);
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
  runCleanup()
    .then(({ failedAccounts, failedComments }) => {
      if (failedAccounts.length > 0 || failedComments.length > 0) {
        console.error(
          `[cleanup] FAILURE: Cleanup finished with ${failedAccounts.length} failed accounts and ${failedComments.length} failed comments. Retained for retry recovery.`,
        );
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('[cleanup] Fatal error during cleanup:', err);
      process.exit(1);
    });
}
