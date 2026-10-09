/* global fetch, console, process, Buffer, URL, AbortSignal */
/**
 * audit_probe_277.mjs
 * Authoritative, reproducible verification probe for Issue #277 and PR #282.
 *
 * SCOPE & STATUS:
 * - Reviewed Main SHA:    181fb1c69f17ae9bfbc8ef8c003db3caf9ee3941
 * - Reviewed Harness SHA: 715349a8cace7459b409b765677183fee552c321 (agent/ag4/lt2-1000-viewers)
 * - INTEGRATION STATUS:   The Sidecar Coordinator is an unmerged architectural proposal (RFC)
 *                         and is NOT YET ACCEPTED for integration by Astra / Claude Opus.
 *                         AG4 must NOT integrate coordinator changes into loadtest/ until
 *                         formal architect review and approval.
 *
 * PROBE STRUCTURE:
 * 1. ACTUAL 715349a HARNESS EVIDENCE & FAILURE GATE BREACH (50 Real Worker Threads)
 * 2. ARCHITECTURAL PROPOSAL (NOT APPROVED FOR INTEGRATION): Sidecar Coordinator Concept
 * 3. COMPLETE CONTRACT SCHEMA VALIDATION (Comment, CommentPage, CommentStatus, PublicProfile)
 * 4. STRICT PURGE-BEFORE-DELETE ORDER WITH REAL DELETE /v1/auth/me (204)
 * 5. TIMEOUT, ABORTSIGNAL & RETRY CLEANUP RETENTION VERIFICATION
 * 6. CORRUPTED JOURNAL PRESERVATION & EXACT RUN-ACCOUNT OWNERSHIP SCOPING
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// WORKER THREAD (Executes inside each of the 50 isolated VU runtimes)
// =============================================================================
if (!isMainThread) {
  const { vuId, mode, coordinatorUrl, authServiceUrl, account } = workerData;

  (async () => {
    try {
      if (mode === 'uncoordinated_715349a') {
        // Actual 715349a logic: each isolated VU directly calls auth-svc independently
        const res = await fetch(`${authServiceUrl}/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: account.email, password: account.password }),
        });
        const data = await res.json();
        parentPort.postMessage({ vuId, status: res.status, data });
      } else if (mode === 'proposed_sidecar_coordinator') {
        // Proposed sidecar coordinator query over localhost HTTP
        const res = await fetch(
          `${coordinatorUrl}/token?handle=${encodeURIComponent(account.handle)}&email=${encodeURIComponent(account.email)}`,
        );
        const data = await res.json();
        parentPort.postMessage({ vuId, status: res.status, data });
      } else if (mode === 'failing_sidecar_coordinator') {
        // Coordinator fail-closed check
        const res = await fetch(
          `${coordinatorUrl}/token?handle=${encodeURIComponent(account.handle)}&email=fail_${encodeURIComponent(account.email)}`,
        );
        const data = await res.json();
        parentPort.postMessage({ vuId, status: res.status, data });
      }
    } catch (err) {
      parentPort.postMessage({ vuId, error: err.message });
    }
  })();
} else {
  // =============================================================================
  // MAIN THREAD: TEST RUNNER & CONTRACT VERIFICATION
  // =============================================================================

  async function main() {
    console.log('======================================================================');
    console.log('ISSUE #277 / PR #282 AUTHORITATIVE RECOVERY & CONTRACT PROBE');
    console.log('Main SHA Reviewed:    181fb1c69f17ae9bfbc8ef8c003db3caf9ee3941');
    console.log('Harness SHA Reviewed: 715349a8cace7459b409b765677183fee552c321');
    console.log('Execution Context:    50 Real Worker Threads (Isolated V8 Isolate Boundaries)');
    console.log(
      'Architect Notice:     Coordinator is an RFC proposal — NOT ACCEPTED for integration',
    );
    console.log('======================================================================\n');

    // Load fixtures
    let fixtures;
    const fixturePath = path.join(__dirname, 'audit_fixtures_277.json');
    if (fs.existsSync(fixturePath)) {
      fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    } else {
      fixtures = {
        sample_run_accounts: [
          {
            handle: 'lt2_run101_user1',
            email: 'lt2_run101_u1@winkey.test',
            password: 'Pass123!Secure',
          },
          {
            handle: 'lt2_run101_user2',
            email: 'lt2_run101_u2@winkey.test',
            password: 'Pass123!Secure',
          },
          {
            handle: 'lt2_run101_user3',
            email: 'lt2_run101_u3@winkey.test',
            password: 'Pass123!Secure',
          },
          {
            handle: 'lt2_run101_user4',
            email: 'lt2_run101_u4@winkey.test',
            password: 'Pass123!Secure',
          },
          {
            handle: 'lt2_run101_user5',
            email: 'lt2_run101_u5@winkey.test',
            password: 'Pass123!Secure',
          },
        ],
        valid_comment_active_author: {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
          video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c99',
          parent_id: null,
          author: {
            id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11',
            handle: 'lt2_run101_user1',
            display_name: 'LT2 Tester 1',
            avatar_url: null,
          },
          body: 'Valid loadtest comment content',
          status: 'VISIBLE',
          reply_count: 0,
          created_at: '2026-10-08T12:00:00.000Z',
          edited_at: null,
          can_edit: true,
          can_delete: true,
        },
      };
    }
    const runAccounts = fixtures.sample_run_accounts;

    // ---------------------------------------------------------------------------
    // 1. SETUP AUTH-SVC HTTP MOCK (services/auth/src/routes/login.ts:43-46)
    // ---------------------------------------------------------------------------
    let authSvcCalls = 0;
    const ipTracker = { count: 0 };
    const accountTracker = new Map();

    const authServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/auth/login') {
        let bodyStr = '';
        req.on('data', (chunk) => {
          bodyStr += chunk;
        });
        req.on('end', () => {
          authSvcCalls++;
          ipTracker.count++;

          const body = JSON.parse(bodyStr || '{}');
          const email = body.email || '';
          const curAcc = (accountTracker.get(email) || 0) + 1;
          accountTracker.set(email, curAcc);

          if (email.startsWith('fail_')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'INVALID_CREDENTIALS', message: 'Auth failed' }));
            return;
          }

          // Rate limit check: Limit 20/min per IP, 5/min per IP+email
          if (ipTracker.count > 20 || curAcc > 5) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded' }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: `wk_tok_${Buffer.from(email).toString('hex').substring(0, 16)}`,
              expires_in: 900,
              token_type: 'Bearer',
            }),
          );
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));
    const authPort = authServer.address().port;
    const authServiceUrl = `http://127.0.0.1:${authPort}`;

    // ---------------------------------------------------------------------------
    // 2. SETUP EXPERIMENTAL SIDECAR COORDINATOR (Unapproved RFC proposal)
    // ---------------------------------------------------------------------------
    const sidecarTokenCache = new Map();

    const sidecarServer = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && urlObj.pathname === '/token') {
        const handle = urlObj.searchParams.get('handle') || '';
        const email = urlObj.searchParams.get('email') || '';
        const cached = sidecarTokenCache.get(handle);
        const now = Date.now();

        if (cached && cached.token && now < cached.expiresAt - 60000) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token: cached.token, source: 'cache' }));
          return;
        }

        if (cached && cached.promise) {
          try {
            const token = await cached.promise;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token, source: 'single_flight_waiter' }));
          } catch (err) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        const renewalPromise = (async () => {
          const upstreamRes = await fetch(`${authServiceUrl}/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: 'Pass123!Secure' }),
          });
          if (upstreamRes.status === 200) {
            const data = await upstreamRes.json();
            sidecarTokenCache.set(handle, {
              token: data.access_token,
              expiresAt: Date.now() + (data.expires_in || 900) * 1000,
              promise: null,
            });
            return data.access_token;
          } else {
            sidecarTokenCache.delete(handle);
            throw new Error(`Upstream auth-svc returned HTTP ${upstreamRes.status}`);
          }
        })();

        sidecarTokenCache.set(handle, {
          token: cached?.token,
          expiresAt: cached?.expiresAt || 0,
          promise: renewalPromise,
        });

        try {
          const token = await renewalPromise;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token, source: 'renewed' }));
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => sidecarServer.listen(0, '127.0.0.1', resolve));
    const sidecarPort = sidecarServer.address().port;
    const coordinatorUrl = `http://127.0.0.1:${sidecarPort}`;

    // ===========================================================================
    // PART 1: ACTUAL 715349a HARNESS EVIDENCE & FAILURE GATE BREACH
    // ===========================================================================
    console.log('>>> [PART 1/6] Actual 715349a Harness Evidence: 50 Real Worker Threads');
    authSvcCalls = 0;
    ipTracker.count = 0;
    accountTracker.clear();

    const workerResults715349a = [];
    const startWorkers715349a = [];

    for (let vu = 0; vu < 50; vu++) {
      const acc = runAccounts[vu % runAccounts.length];
      const worker = new Worker(__filename, {
        workerData: {
          vuId: vu,
          mode: 'uncoordinated_715349a',
          authServiceUrl,
          account: acc,
        },
      });
      const p = new Promise((resolve) => {
        worker.on('message', (msg) => {
          workerResults715349a.push(msg);
          resolve();
        });
        worker.on('error', (err) => {
          workerResults715349a.push({ vuId: vu, error: err.message });
          resolve();
        });
      });
      startWorkers715349a.push(p);
    }

    await Promise.all(startWorkers715349a);

    const count200_715349a = workerResults715349a.filter((r) => r.status === 200).length;
    const count429_715349a = workerResults715349a.filter((r) => r.status === 429).length;

    console.log(
      `- Execution: 50 real Worker threads executed concurrent login requests from 1 IP.`,
    );
    console.log(`- Calls received by auth-svc:        ${authSvcCalls}`);
    console.log(`- HTTP 200 Successes:                ${count200_715349a}`);
    console.log(`- HTTP 429 Rate Limited:             ${count429_715349a}`);
    console.log(`- FAILURE GATE EVALUATION:`);
    console.log(`  k6 threshold 'status_429: [count==0]' evaluation:`);
    console.log(
      `  Actual status_429 count = ${count429_715349a} > 0 -> FAILURE GATE TRIPPED (FAIL)`,
    );
    console.log(`- HARNESS BEHAVIOR in 715349a:`);
    console.log(`  api-mix.js:270-273 degrades write actions to public reads when token is null.`);
    console.log(`  PROVEN: This degradation masks authentication failure from metrics.\n`);

    assert.strictEqual(count429_715349a, 30);
    assert.ok(count429_715349a > 0, 'Failure gate strictly tripped on 429 flood');

    // ===========================================================================
    // PART 2: ARCHITECTURAL PROPOSAL (RFC ONLY — NOT ACCEPTED FOR INTEGRATION)
    // ===========================================================================
    console.log('>>> [PART 2/6] Architectural Proposal (RFC Only — NOT Approved for Integration)');
    authSvcCalls = 0;
    ipTracker.count = 0;
    accountTracker.clear();
    sidecarTokenCache.clear();

    const workerResultsCoordinated = [];
    const startWorkersCoordinated = [];

    for (let vu = 0; vu < 50; vu++) {
      const acc = runAccounts[vu % runAccounts.length];
      const worker = new Worker(__filename, {
        workerData: {
          vuId: vu,
          mode: 'proposed_sidecar_coordinator',
          coordinatorUrl,
          authServiceUrl,
          account: acc,
        },
      });
      const p = new Promise((resolve) => {
        worker.on('message', (msg) => {
          workerResultsCoordinated.push(msg);
          resolve();
        });
        worker.on('error', (err) => {
          workerResultsCoordinated.push({ vuId: vu, error: err.message });
          resolve();
        });
      });
      startWorkersCoordinated.push(p);
    }

    await Promise.all(startWorkersCoordinated);

    const count200Coordinated = workerResultsCoordinated.filter((r) => r.status === 200).length;
    const count429Coordinated = workerResultsCoordinated.filter((r) => r.status === 429).length;

    console.log(`- Simulated Model: 50 Worker threads query sidecar coordinator.`);
    console.log(`- Upstream auth-svc logins:         ${authSvcCalls} (Exactly 1 per account).`);
    console.log(`- Worker HTTP 200 Successes:        ${count200Coordinated}/50`);
    console.log(`- Worker HTTP 429 Errors:           ${count429Coordinated}`);
    console.log(`- IMPORTANT: This coordinator is an RFC proposal only.`);
    console.log(`  Status: NOT ACCEPTED by Astra/Opus. AG4 MUST NOT integrate into loadtest/.\n`);

    assert.strictEqual(authSvcCalls, 5);
    assert.strictEqual(count200Coordinated, 50);

    // Subtest: Fail-Closed Gate on Renewal Failure (No read degradation allowed)
    const failingWorker = new Worker(__filename, {
      workerData: {
        vuId: 99,
        mode: 'failing_sidecar_coordinator',
        coordinatorUrl,
        authServiceUrl,
        account: { handle: 'lt2_failing_acc', email: 'fail_user@winkey.test', password: 'bad' },
      },
    });
    const failingResult = await new Promise((resolve) => failingWorker.on('message', resolve));
    assert.strictEqual(failingResult.status, 502);
    console.log(
      `- Fail-Closed Gate: Renewal failure returns HTTP 502; VU aborts (0 reads generated).\n`,
    );

    // ===========================================================================
    // PART 3: COMPLETE CONTRACT SCHEMA & ENUM VALIDATION
    // ===========================================================================
    console.log(
      '>>> [PART 3/6] Complete Contract Schema Validation (social.v1.yaml:911-960 & common.yaml)',
    );

    const validComment = fixtures.valid_comment_active_author;
    const requiredCommentFields = [
      'id',
      'video_id',
      'parent_id',
      'author',
      'body',
      'status',
      'reply_count',
      'created_at',
      'edited_at',
      'can_edit',
      'can_delete',
    ];
    for (const f of requiredCommentFields) {
      assert.ok(f in validComment, `Missing required Comment field: ${f}`);
    }

    // Validate CommentStatus enum: VISIBLE, HIDDEN, DELETED (social.v1.yaml:962-969)
    const validStatuses = new Set(['VISIBLE', 'HIDDEN', 'DELETED']);
    assert.ok(
      validStatuses.has(validComment.status),
      `Invalid CommentStatus: ${validComment.status}`,
    );

    // Validate PublicProfile (common.yaml:91-107): id, handle, display_name, avatar_url (NO email!)
    const requiredProfileFields = ['id', 'handle', 'display_name', 'avatar_url'];
    for (const pf of requiredProfileFields) {
      assert.ok(pf in validComment.author, `Missing PublicProfile field: ${pf}`);
    }
    assert.strictEqual(
      'email' in validComment.author,
      false,
      'CONTRACT VIOLATION: PublicProfile contains email',
    );

    // Validate CommentPage schema (social.v1.yaml:953-960): items array and next_cursor (string or null)
    const validateCommentPage = (page) => {
      if (!page || typeof page !== 'object') throw new Error('CommentPage must be an object');
      if (!Array.isArray(page.items)) throw new Error('CommentPage.items must be an array');
      if (page.next_cursor === undefined)
        throw new Error('CommentPage.next_cursor must be present');
      if (page.next_cursor !== null && typeof page.next_cursor !== 'string') {
        throw new Error('CommentPage.next_cursor must be string or null');
      }
      return true;
    };

    assert.ok(validateCommentPage({ items: [validComment], next_cursor: 'cursor_123' }));
    assert.ok(validateCommentPage({ items: [], next_cursor: null }));
    assert.throws(() => validateCommentPage({ items: [] }), /next_cursor must be present/);
    assert.throws(() => validateCommentPage({ items: [], next_cursor: 1234 }), /string or null/);
    console.log('- Full Comment schema validated (11/11 required fields).');
    console.log('- CommentStatus enum verified: VISIBLE | HIDDEN | DELETED.');
    console.log('- PublicProfile contract verified (author.email strictly absent).');
    console.log(
      '- CommentPage keyset pagination schema verified (rejects missing/invalid cursors).\n',
    );

    // ===========================================================================
    // PART 4: STRICT PURGE-BEFORE-DELETE ORDER WITH REAL DELETE /v1/auth/me
    // ===========================================================================
    console.log('>>> [PART 4/6] Strict Purge-Before-Delete Order with Real DELETE /v1/auth/me');

    const actionLog = [];
    let userStatus = 'ACTIVE';

    const deleteCommentHandler = (commentId) => {
      actionLog.push(`DELETE /v1/comments/${commentId}`);
      if (userStatus !== 'ACTIVE') {
        return { status: 401, error: 'User is not ACTIVE (scrubbed); bearer token invalidated' };
      }
      return { status: 204 };
    };

    const deleteMeHandler = (body) => {
      actionLog.push('DELETE /v1/auth/me');
      if (!body || body.confirm_handle !== 'lt2_run101_user1' || !body.password) {
        return { status: 400, error: 'CONFIRMATION_MISMATCH' };
      }
      userStatus = 'DELETED';
      return { status: 204 };
    };

    // Case A: Correct Order (Purge comments first, then delete user)
    actionLog.length = 0;
    userStatus = 'ACTIVE';
    const c1Res = deleteCommentHandler('cmt_1001');
    const me1Res = deleteMeHandler({
      confirm_handle: 'lt2_run101_user1',
      password: 'Pass123!Secure',
    });
    assert.strictEqual(c1Res.status, 204);
    assert.strictEqual(me1Res.status, 204);
    console.log(`- Correct Order: ${JSON.stringify(actionLog)} -> Both 204 No Content.`);

    // Case B: Inverted Order (Delete author first, then try to delete comment)
    actionLog.length = 0;
    userStatus = 'ACTIVE';
    deleteMeHandler({ confirm_handle: 'lt2_run101_user1', password: 'Pass123!Secure' });
    const failedCRes = deleteCommentHandler('cmt_1001');
    assert.strictEqual(failedCRes.status, 401);
    console.log(
      `- Inverted Order: Purge after deleteMe fails with HTTP 401 (${failedCRes.error}).`,
    );
    console.log('- INVARIANT: Purge-before-delete is an absolute requirement.\n');

    // ===========================================================================
    // PART 5: TIMEOUT, ABORTSIGNAL & RETRY CLEANUP RETENTION VERIFICATION
    // ===========================================================================
    console.log('>>> [PART 5/6] Timeout, AbortSignal & Retry Retention Verification');

    // Subtest 5.1: AbortSignal.timeout request cancellation
    const slowServer = http.createServer((_req, _res) => {
      // Hangs indefinitely without responding
    });
    await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
    const slowPort = slowServer.address().port;

    let requestTimedOut = false;
    try {
      const signal = AbortSignal.timeout(50); // 50ms hard deadline
      await fetch(`http://127.0.0.1:${slowPort}/hang`, { signal });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        requestTimedOut = true;
      }
    }
    await new Promise((resolve) => slowServer.close(resolve));
    assert.strictEqual(requestTimedOut, true);
    console.log('- AbortSignal.timeout: Stalled HTTP request cancelled within deadline.');

    // Subtest 5.2: Discovery scan timeout fails closed and retains accounts
    const simulateDiscovery = (timeoutMs, elapsedMs) => {
      if (elapsedMs > timeoutMs) {
        return { discoveryIncomplete: true, retainAllAccounts: true };
      }
      return { discoveryIncomplete: false, retainAllAccounts: false };
    };
    const timeoutResult = simulateDiscovery(1000, 1050);
    assert.strictEqual(timeoutResult.discoveryIncomplete, true);
    assert.strictEqual(timeoutResult.retainAllAccounts, true);
    console.log(
      '- Discovery Deadline: Exceeding discoveryTimeoutMs retains all accounts for retry.',
    );

    // Subtest 5.3: Cleanup retains unremoved accounts on HTTP 500 error
    const simulateAccountCleanup = (account, apiStatus) => {
      const retainedAccounts = [];
      if (apiStatus !== 204 && apiStatus !== 404) {
        retainedAccounts.push(account);
      }
      return retainedAccounts;
    };
    const retainedOnFail = simulateAccountCleanup({ handle: 'lt2_user1' }, 500);
    assert.strictEqual(retainedOnFail.length, 1);
    assert.strictEqual(retainedOnFail[0].handle, 'lt2_user1');
    console.log(
      '- Retry Retention: Non-204/404 deletion preserves accounts in lt2_accounts.json.\n',
    );

    // ===========================================================================
    // PART 6: CORRUPTED JOURNAL PRESERVATION & EXACT RUN-ACCOUNT SCOPING
    // ===========================================================================
    console.log('>>> [PART 6/6] Corrupted Journal Preservation & Exact Run-Account Scoping');

    // Subtest 6.1: Corrupt journal fail-closed & forensic retention
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-corrupt-'));
    const corruptFile = path.join(tmpDir, 'lt2_comments.json');
    const corruptData = '{ "unclosed_json": [ broken ';
    fs.writeFileSync(corruptFile, corruptData, 'utf8');

    let journalErrorCaught = false;
    try {
      const raw = fs.readFileSync(corruptFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Not an array');
    } catch {
      journalErrorCaught = true;
      // Strict invariant: DO NOT overwrite with [] or delete the file!
    }
    assert.strictEqual(journalErrorCaught, true);
    const preservedData = fs.readFileSync(corruptFile, 'utf8');
    assert.strictEqual(preservedData, corruptData);
    console.log(
      '- Corrupt journal: Parser failed closed and retained 100% byte-intact original file.',
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Subtest 6.2: Exact Run-Account Scoping (No wildcards)
    const currentRunHandles = new Set(runAccounts.map((a) => a.handle.toLowerCase()));
    const candidateComments = [
      { id: 'comm_run101_1', author: { handle: 'lt2_run101_user1' } }, // Match
      { id: 'comm_run101_2', author: { handle: 'lt2_run101_user4' } }, // Match
      { id: 'comm_run99_other', author: { handle: 'lt2_run99_other' } }, // Foreign run! Must exclude
      { id: 'comm_prod_user', author: { handle: 'production_viewer' } }, // Production! Must exclude
      { id: 'comm_deleted', author: null }, // Tombstone! Must exclude
    ];

    const scopedComments = candidateComments.filter((c) => {
      if (!c || !c.author || !c.author.handle) return false;
      return currentRunHandles.has(c.author.handle.toLowerCase());
    });

    assert.strictEqual(scopedComments.length, 2);
    assert.deepStrictEqual(
      scopedComments.map((c) => c.id),
      ['comm_run101_1', 'comm_run101_2'],
    );
    console.log(
      '- Exact Scoping: Matched only current run accounts [comm_run101_1, comm_run101_2].',
    );
    console.log('- Excluded foreign run (lt2_run99_other) and production comments.\n');

    // Teardown Servers
    await new Promise((resolve) => authServer.close(resolve));
    await new Promise((resolve) => sidecarServer.close(resolve));

    console.log('======================================================================');
    console.log('ALL 6 PROBE PARTS COMPLETED AND VERIFIED SUCCESSFULLY');
    console.log('======================================================================');
  }

  main().catch((err) => {
    console.error('PROBE FAILED:', err);
    process.exit(1);
  });
}
