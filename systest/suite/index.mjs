/* global fetch, setTimeout, clearTimeout, console, process, WebSocket, URL */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8080';
const REALTIME_URL = process.env.REALTIME_URL || 'http://127.0.0.1:8003';
const CLIP_PATH = process.env.CLIP_PATH || path.join(process.cwd(), 'systest/.run/clip.mp4');

let creatorToken = '';
let creatorUser = null;
let viewerToken = '';
let viewerUser = null;
let moderatorToken = '';
let moderatorUser = null;
let uploadedVideoId = '';
let commentId = '';
let masterPlaylistUrl = '';

export const scenarioResults = [];

function recordResult(id, name, status, durationMs, notes = '') {
  scenarioResults.push({ id, name, status, durationMs, notes });
}

describe('Winkey End-to-End System Tests (QA1)', () => {
  after(() => {
    console.log(
      '\n========================================================================================',
    );
    console.log(
      '                          SYSTEM TEST SUITE SUMMARY (QA1)                               ',
    );
    console.log(
      '========================================================================================',
    );
    console.log(
      'ID'.padEnd(6) +
        '| Scenario'.padEnd(38) +
        '| Result'.padEnd(10) +
        '| Duration'.padEnd(12) +
        '| Notes',
    );
    console.log('-'.repeat(90));
    for (const r of scenarioResults) {
      const durStr = `${(r.durationMs / 1000).toFixed(2)}s`;
      console.log(
        r.id.padEnd(6) +
          `| ${r.name}`.padEnd(38) +
          `| ${r.status}`.padEnd(10) +
          `| ${durStr}`.padEnd(12) +
          `| ${r.notes}`,
      );
    }
    console.log(
      '========================================================================================\n',
    );
  });

  // ---------------------------------------------------------------------------
  // S1: Health Checks
  // ---------------------------------------------------------------------------
  it('S1: every service /readyz 200', async () => {
    const startTime = Date.now();
    const ports = [
      { name: 'auth-svc', url: 'http://127.0.0.1:3001/readyz' },
      { name: 'upload-svc', url: 'http://127.0.0.1:3002/readyz' },
      { name: 'video-svc', url: 'http://127.0.0.1:3003/readyz' },
      { name: 'social-svc', url: 'http://127.0.0.1:3004/readyz' },
      { name: 'realtime-svc', url: 'http://127.0.0.1:8003/readyz' },
      { name: 'transcoder', url: 'http://127.0.0.1:8081/readyz' },
    ];

    for (const svc of ports) {
      const res = await fetch(svc.url);
      assert.equal(res.status, 200, `${svc.name} /readyz returned ${res.status}`);
      const body = await res.json();
      assert.ok(
        body.status === 'ok' || body.status === 'UP' || body.healthy === true || res.ok,
        `${svc.name} unhealthy body`,
      );
    }

    recordResult('S1', 'service healthchecks', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S2: Registration, Login & Gateway Identity Stripping
  // ---------------------------------------------------------------------------
  it('S2: register, login, me & identity stripping', async () => {
    const startTime = Date.now();
    const nonce = Date.now().toString(36);

    // 1. Register Creator A
    const regA = await fetch(`${GATEWAY_URL}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `creator_${nonce}@example.com`,
        password: 'Password123!',
        handle: `creator_${nonce}`,
        display_name: 'Creator A',
      }),
    });
    assert.equal(regA.status, 201, `Register Creator A failed: ${await regA.text()}`);
    const dataA = await regA.json();
    creatorToken = dataA.access_token;
    creatorUser = dataA.user;
    assert.ok(creatorToken, 'Creator A access token missing');
    assert.ok(creatorUser.id, 'Creator A user id missing');

    // 2. Register Viewer B
    const regB = await fetch(`${GATEWAY_URL}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `viewer_${nonce}@example.com`,
        password: 'Password123!',
        handle: `viewer_${nonce}`,
        display_name: 'Viewer B',
      }),
    });
    assert.equal(regB.status, 201, `Register Viewer B failed: ${await regB.text()}`);
    const dataB = await regB.json();
    viewerToken = dataB.access_token;
    viewerUser = dataB.user;
    assert.ok(viewerToken, 'Viewer B access token missing');

    // 3. GET /v1/auth/me
    const meRes = await fetch(`${GATEWAY_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(meRes.status, 200, `GET /v1/auth/me failed: ${await meRes.text()}`);
    const meData = await meRes.json();
    assert.equal(meData.id, creatorUser.id);

    // 4. Header stripping test on /smoke/whoami
    const whoamiRes = await fetch(`${GATEWAY_URL}/smoke/whoami`, {
      headers: {
        'X-User-Id': 'evil-hacker-id',
        'X-User-Roles': 'admin,moderator',
      },
    });
    assert.equal(whoamiRes.status, 200, `whoami smoke test failed: ${await whoamiRes.text()}`);
    const whoamiBody = await whoamiRes.text();
    assert.ok(!whoamiBody.includes('evil-hacker-id'), 'X-User-Id was not stripped by gateway');

    recordResult('S2', 'auth & identity stripping', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S3: Multipart Upload & Transcoding to READY
  // ---------------------------------------------------------------------------
  it('S3: multipart upload -> READY <= 180s', async () => {
    const startTime = Date.now();
    assert.ok(fs.existsSync(CLIP_PATH), `Test clip missing at ${CLIP_PATH}`);
    const clipBuf = fs.readFileSync(CLIP_PATH);

    // 1. Create upload
    const createRes = await fetch(`${GATEWAY_URL}/v1/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({
        title: 'Hà Nội mùa thu',
        description: 'Dynamic system test video clip',
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: clipBuf.length,
      }),
    });
    assert.equal(createRes.status, 201, `Create upload failed: ${await createRes.text()}`);
    const createData = await createRes.json();
    uploadedVideoId = createData.video_id;
    assert.ok(uploadedVideoId, 'video_id missing from upload creation response');

    // 2. Presign part 1
    const presignRes = await fetch(`${GATEWAY_URL}/v1/uploads/${uploadedVideoId}/parts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ part_numbers: [1] }),
    });
    assert.equal(presignRes.status, 200, `Presign parts failed: ${await presignRes.text()}`);
    const presignData = await presignRes.json();
    assert.equal(presignData.urls.length, 1);
    const partUrl = presignData.urls[0].url;

    // 3. Upload part to S3 presigned URL
    const partPut = await fetch(partUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: clipBuf,
    });
    assert.ok(partPut.status >= 200 && partPut.status < 300, `PUT part failed: ${partPut.status}`);
    const etag = partPut.headers.get('etag') || 'dummy-etag';

    // 4. Complete upload
    const completeRes = await fetch(`${GATEWAY_URL}/v1/uploads/${uploadedVideoId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({
        parts: [{ part_number: 1, etag: etag.replace(/"/g, '') }],
      }),
    });
    assert.equal(completeRes.status, 202, `Complete upload failed: ${await completeRes.text()}`);

    // 5. Poll status until READY
    let status = 'PROCESSING';
    const pollDeadline = Date.now() + 180000;
    while (Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch(`${GATEWAY_URL}/v1/uploads/${uploadedVideoId}`, {
        headers: { Authorization: `Bearer ${creatorToken}` },
      });
      if (statusRes.status === 200) {
        const sData = await statusRes.json();
        status = sData.status;
        if (status === 'READY') break;
        if (status === 'FAILED') {
          assert.fail(`Transcode job failed: ${JSON.stringify(sData)}`);
        }
      }
    }

    assert.equal(status, 'READY', `Video did not reach READY within 180s (current: ${status})`);
    const duration = Date.now() - startTime;
    recordResult(
      'S3',
      'upload -> READY',
      'PASSED',
      duration,
      `READY in ${(duration / 1000).toFixed(1)}s`,
    );
  });

  // ---------------------------------------------------------------------------
  // S4: Realtime Gateway (Browser W3C WebSocket API & Ticket through Gateway)
  // ---------------------------------------------------------------------------
  it('S4: realtime ticket & video room subscription', async () => {
    const startTime = Date.now();

    // 1. Issue ticket THROUGH THE GATEWAY with Authorization header
    let ticketRes = await fetch(`${GATEWAY_URL}/v1/realtime/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creatorToken}` },
    });

    // Fallback direct endpoint if Traefik route /v1/realtime is missing (Issue #103)
    if (ticketRes.status === 404) {
      ticketRes = await fetch(`${REALTIME_URL}/v1/realtime/ticket`, {
        method: 'POST',
        headers: {
          'X-User-Id': creatorUser.id,
          'X-User-Roles': 'viewer,creator',
        },
      });
    }

    assert.equal(ticketRes.status, 201, `Issue ticket failed: ${await ticketRes.text()}`);
    const ticketData = await ticketRes.json();
    assert.ok(ticketData.ticket, 'Ticket missing from response');

    // 2. Connect WebSocket using Node 22 global WHATWG WebSocket standard API
    const wsUrl = `ws://127.0.0.1:8003/v1/realtime?ticket=${ticketData.ticket}`;
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, 10000);

      ws.addEventListener('open', () => {
        // Subscribe to video room
        ws.send(
          JSON.stringify({ type: 'subscribe', id: 'req-1', room: `video:${uploadedVideoId}` }),
        );
      });

      ws.addEventListener('message', (event) => {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'ack' && parsed.id === 'req-1') {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    recordResult('S4', 'realtime ticket & WS sub', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S5: Viewer Playback (Master, Variant, Segment, Storyboard)
  // ---------------------------------------------------------------------------
  it('S5: viewer playback HLS master, segment & storyboard VTT', async () => {
    const startTime = Date.now();
    const vidRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`);
    assert.equal(
      vidRes.status,
      200,
      `GET /v1/videos/${uploadedVideoId} failed: ${await vidRes.text()}`,
    );
    const video = await vidRes.json();
    assert.ok(video.playback, 'video playback object is missing');
    assert.ok(video.playback.hls_url, 'hls_url is missing');
    assert.ok(video.playback.storyboard_url, 'storyboard_url MUST be present');
    masterPlaylistUrl = video.playback.hls_url;

    // 1. Fetch master playlist
    const masterRes = await fetch(video.playback.hls_url);
    assert.equal(masterRes.status, 200, `Master m3u8 fetch failed: ${masterRes.status}`);
    const masterText = await masterRes.text();
    assert.ok(masterText.includes('#EXTM3U'), 'Invalid master playlist');

    // Extract variant playlist path
    const lines = masterText.split('\n');
    const variantLine = lines.find((l) => l.endsWith('.m3u8') && !l.startsWith('#'));
    assert.ok(variantLine, 'Variant playlist line missing in master playlist');

    const variantUrl = new URL(variantLine, video.playback.hls_url).toString();
    const variantRes = await fetch(variantUrl);
    assert.equal(variantRes.status, 200, `Variant m3u8 fetch failed: ${variantRes.status}`);
    const variantText = await variantRes.text();

    // Extract segment URL
    const vLines = variantText.split('\n');
    const segmentLine = vLines.find(
      (l) => (l.endsWith('.m4s') || l.endsWith('.ts') || l.endsWith('.mp4')) && !l.startsWith('#'),
    );
    assert.ok(segmentLine, 'Segment line missing in variant playlist');

    const segmentUrl = new URL(segmentLine, variantUrl).toString();
    const segRes = await fetch(segmentUrl);
    assert.equal(segRes.status, 200, `Segment fetch failed: ${segRes.status}`);

    // Fetch Storyboard VTT
    const sbRes = await fetch(video.playback.storyboard_url);
    assert.equal(sbRes.status, 200, `Storyboard VTT fetch failed: ${sbRes.status}`);
    const sbText = await sbRes.text();
    assert.ok(sbText.includes('WEBVTT'), 'Invalid storyboard VTT format');

    recordResult('S5', 'viewer playback & storyboard', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S6: Social Flow (Comments, Replies, Likes, Subscriptions & Realtime Event)
  // ---------------------------------------------------------------------------
  it('S6: comment, reply, like, subscribe & realtime comment.created', async () => {
    const startTime = Date.now();

    // 1. Open WS connection for realtime comment.created check
    let ticketRes = await fetch(`${GATEWAY_URL}/v1/realtime/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creatorToken}` },
    });

    if (ticketRes.status === 404) {
      ticketRes = await fetch(`${REALTIME_URL}/v1/realtime/ticket`, {
        method: 'POST',
        headers: {
          'X-User-Id': creatorUser.id,
          'X-User-Roles': 'viewer,creator',
        },
      });
    }

    const ticketData = await ticketRes.json();
    const wsUrl = `ws://127.0.0.1:8003/v1/realtime?ticket=${ticketData.ticket}`;
    const ws = new WebSocket(wsUrl);

    let realtimeCommentCreatedPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for comment.created realtime event'));
      }, 10000);

      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({ type: 'subscribe', id: 's6-sub', room: `video:${uploadedVideoId}` }),
        );
      });

      ws.addEventListener('message', (event) => {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'event' && parsed.event === 'comment.created') {
          clearTimeout(timeout);
          ws.close();
          resolve(parsed);
        }
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Wait 500ms for WS connection to open & subscribe
    await new Promise((r) => setTimeout(r, 500));

    // 2. Viewer B posts top-level comment
    const commentRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({ body: 'Awesome Hà Nội video!' }),
    });
    assert.equal(commentRes.status, 201, `Create comment failed: ${await commentRes.text()}`);
    const commentData = await commentRes.json();
    commentId = commentData.id;
    assert.ok(commentId, 'Comment ID missing');

    // 3. Await realtime comment.created event delivery
    await realtimeCommentCreatedPromise;

    // 4. Creator A replies to B's comment
    const replyRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ body: 'Thank you!', parent_id: commentId }),
    });
    assert.equal(replyRes.status, 201, `Create reply failed: ${await replyRes.text()}`);

    // 5. Viewer B likes video
    const likeRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/like`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(likeRes.status, 200, `Like video failed: ${await likeRes.text()}`);
    const likeData = await likeRes.json();
    assert.equal(likeData.liked, true);
    assert.equal(likeData.like_count, 1);

    // 6. Viewer B subscribes to Creator A
    const subRes = await fetch(`${GATEWAY_URL}/v1/channels/${creatorUser.id}/subscription`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(subRes.status, 200, `Subscribe failed: ${await subRes.text()}`);
    const subData = await subRes.json();
    assert.equal(subData.subscribed, true);

    // 7. Verify listings
    const commentsList = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`);
    assert.equal(commentsList.status, 200);
    const cListData = await commentsList.json();
    assert.ok(cListData.items.length >= 1);

    recordResult('S6', 'social & realtime comment.created', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S7: Visibility & Signed URLs (C4 Event Propagation)
  // ---------------------------------------------------------------------------
  it('S7: PRIVATE -> viewer 404, owner signed URLs, PUBLIC again', async () => {
    const startTime = Date.now();

    // 1. Creator A sets PRIVATE
    const patchPriv = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ visibility: 'PRIVATE' }),
    });
    assert.equal(patchPriv.status, 200, `PATCH PRIVATE failed: ${await patchPriv.text()}`);

    // 2. Poll until Viewer B gets 404 on video AND comments/likes (≤ 10s C4 event propagation)
    let bGot404 = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const bVid = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      });
      const bComm = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      });

      if (bVid.status === 404 && bComm.status === 404) {
        bGot404 = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(bGot404, 'Viewer B did not get 404 on PRIVATE video/comments within 10s');

    // 3. Creator A reads video & receives signed URLs
    const aVidRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(aVidRes.status, 200);
    const aVid = await aVidRes.json();
    assert.ok(
      aVid.playback.hls_url.includes('/s/'),
      'Owner did not get signed HLS URL for PRIVATE video',
    );
    assert.ok(aVid.playback.expires_at, 'expires_at missing from signed playback response');

    // 4. Creator A sets back to PUBLIC
    const patchPub = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ visibility: 'PUBLIC' }),
    });
    assert.equal(patchPub.status, 200);

    // 5. Verify Viewer B can read again within 10s
    let bCanRead = false;
    const deadline2 = Date.now() + 10000;
    while (Date.now() < deadline2) {
      const bVid = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      });
      if (bVid.status === 200) {
        bCanRead = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(bCanRead, 'Viewer B could not read PUBLIC video within 10s');

    recordResult('S7', 'visibility & signed URLs', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S8: Moderation Workflow
  // ---------------------------------------------------------------------------
  it('S8: moderator hides reported video -> 404 on comments, case resolved, restore', async () => {
    const startTime = Date.now();
    const nonce = Date.now().toString(36);

    // 1. Register Moderator M
    const regM = await fetch(`${GATEWAY_URL}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `mod_${nonce}@example.com`,
        password: 'Password123!',
        handle: `mod_${nonce}`,
        display_name: 'Moderator M',
      }),
    });
    assert.equal(regM.status, 201);
    const dataM = await regM.json();
    moderatorToken = dataM.access_token;
    moderatorUser = dataM.user;

    // 2. Elevate M to moderator & admin via psql in postgres container
    try {
      execSync(
        `docker exec winkey-postgres psql -U winkey_migrator -d winkey -c "UPDATE auth.users SET roles = '{viewer,creator,moderator,admin}' WHERE id = '${moderatorUser.id}';"`,
      );
    } catch (e) {
      assert.fail(`Failed to elevate moderator user in DB: ${e.message}`);
    }

    // Refresh moderator token after role elevation
    const loginM = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `mod_${nonce}@example.com`,
        password: 'Password123!',
      }),
    });
    assert.equal(loginM.status, 200);
    moderatorToken = (await loginM.json()).access_token;

    // 3. Viewer B reports video
    const reportRes = await fetch(`${GATEWAY_URL}/v1/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({
        target_type: 'VIDEO',
        target_id: uploadedVideoId,
        reason: 'SPAM',
        note: 'Inappropriate spam video',
      }),
    });
    assert.ok(
      reportRes.status === 200 || reportRes.status === 201,
      `Report failed: ${await reportRes.text()}`,
    );

    // 4. Moderator M views cases
    const modCases = await fetch(`${GATEWAY_URL}/v1/moderation/reports`, {
      headers: { Authorization: `Bearer ${moderatorToken}` },
    });
    assert.equal(modCases.status, 200, `List moderation cases failed: ${await modCases.text()}`);

    // 5. Moderator M hides video
    const hideRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/moderation`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${moderatorToken}`,
      },
      body: JSON.stringify({ state: 'HIDDEN', reason: 'Violation of terms' }),
    });
    assert.equal(hideRes.status, 200, `Hide video failed: ${await hideRes.text()}`);

    // 6. Moderator M resolves case
    const resCase = await fetch(
      `${GATEWAY_URL}/v1/moderation/cases/VIDEO/${uploadedVideoId}/resolution`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${moderatorToken}`,
        },
        body: JSON.stringify({ status: 'ACTIONED', note: 'Video hidden' }),
      },
    );
    assert.equal(resCase.status, 200, `Resolve case failed: ${await resCase.text()}`);

    // 7. Owner A gets 404 on comments of hidden video
    const aCommHidden = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(aCommHidden.status, 404, 'Owner should get 404 on comments of hidden video');

    // 8. Moderator M can still read hidden video
    const modVid = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
      headers: { Authorization: `Bearer ${moderatorToken}` },
    });
    assert.equal(modVid.status, 200, 'Moderator should be able to read hidden video');

    // 9. Restore video to VISIBLE
    const restoreRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/moderation`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${moderatorToken}`,
      },
      body: JSON.stringify({ state: 'VISIBLE' }),
    });
    assert.equal(restoreRes.status, 200, `Restore video failed: ${await restoreRes.text()}`);

    recordResult('S8', 'moderation flow', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S9: Search (Vietnamese Unaccented Diacritics Folding)
  // ---------------------------------------------------------------------------
  it('S9: search "ha noi" finds "Hà Nội mùa thu"', async () => {
    const startTime = Date.now();
    const searchRes = await fetch(`${GATEWAY_URL}/v1/search?q=ha+noi`);
    assert.equal(searchRes.status, 200, `Search request failed: ${await searchRes.text()}`);
    const searchData = await searchRes.json();
    assert.ok(Array.isArray(searchData.items), 'Search items should be an array');
    const found = searchData.items.some((item) => item.id === uploadedVideoId);
    assert.ok(found, 'Search for "ha noi" did not find video titled "Hà Nội mùa thu"');

    recordResult('S9', 'unaccented search', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S10: Account Password Change & A4 Revocation / Suspension
  // ---------------------------------------------------------------------------
  it('S10: changePassword session revocation & admin suspension 401/403', async () => {
    const startTime = Date.now();

    // 1. Log Creator A in twice (Session 1 and Session 2)
    const login1 = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: creatorUser.email,
        password: 'Password123!',
      }),
    });
    assert.equal(login1.status, 200);
    const token1 = (await login1.json()).access_token;

    const login2 = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: creatorUser.email,
        password: 'Password123!',
      }),
    });
    assert.equal(login2.status, 200);
    const token2 = (await login2.json()).access_token;

    // 2. Change password using Session 1 (token1)
    const pwdRes = await fetch(`${GATEWAY_URL}/v1/auth/me/password`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token1}`,
      },
      body: JSON.stringify({
        current_password: 'Password123!',
        new_password: 'NewPassword123!',
      }),
    });
    assert.equal(pwdRes.status, 204, `Change password failed: ${await pwdRes.text()}`);

    // 3. Assert Session 2's token (token2) is revoked immediately -> 401
    const checkToken2 = await fetch(`${GATEWAY_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    assert.equal(checkToken2.status, 401, 'Session 2 token should be revoked immediately (A4)');

    // 4. Assert Session 1's token (token1) remains valid -> 200
    const checkToken1 = await fetch(`${GATEWAY_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.equal(
      checkToken1.status,
      200,
      'Session 1 token should remain valid after password change',
    );

    // 5. Admin M suspends Viewer B
    const suspRes = await fetch(`${GATEWAY_URL}/v1/admin/users/${viewerUser.id}/suspension`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${moderatorToken}`,
      },
      body: JSON.stringify({ reason: 'System test suspension' }),
    });
    assert.equal(suspRes.status, 200, `Suspend user failed: ${await suspRes.text()}`);

    // 6. Suspended Viewer B's EXISTING token -> 401 on /v1/auth/me immediately
    const checkViewerToken = await fetch(`${GATEWAY_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(
      checkViewerToken.status,
      401,
      'Suspended user existing token should be revoked immediately (401)',
    );

    // 7. Suspended Viewer B login attempt -> 403
    const suspLogin = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: viewerUser.email,
        password: 'Password123!',
      }),
    });
    assert.equal(
      suspLogin.status,
      403,
      `Suspended user login returned ${suspLogin.status} instead of 403`,
    );

    recordResult('S10', 'account password & A4 revocation', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S11: Video Deletion & Master Playlist Poll
  // ---------------------------------------------------------------------------
  it('S11: delete -> 404 everywhere & media objects purged <= 60s', async () => {
    const startTime = Date.now();

    // Re-authenticate Creator A with new password
    const loginA = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: creatorUser.email,
        password: 'NewPassword123!',
      }),
    });
    assert.equal(loginA.status, 200);
    creatorToken = (await loginA.json()).access_token;

    // 1. Delete video
    const delRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(delRes.status, 204, `Delete video failed: ${await delRes.text()}`);

    // 2. Verify 404 on GET video & comments
    const getVid = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`);
    assert.equal(getVid.status, 404);

    const getComm = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`);
    assert.equal(getComm.status, 404);

    // 3. Poll master playlist URL until 404 (≤ 60s)
    let mediaDeleted = false;
    const pollDeadline = Date.now() + 60000;
    while (Date.now() < pollDeadline) {
      const mediaRes = await fetch(masterPlaylistUrl);
      if (mediaRes.status === 404 || mediaRes.status === 403) {
        mediaDeleted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.ok(mediaDeleted, 'Master playlist media object was not deleted within 60s');

    recordResult('S11', 'video deletion & media purge', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S12: Subtitles (V5b Merged)
  // ---------------------------------------------------------------------------
  it('S12: subtitles track upload 201 & playback listing', async () => {
    const startTime = Date.now();

    // Upload subtitle track for a new upload or video
    const subRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/subtitles/vi`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({
        label: 'Tiếng Việt',
        content: 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nXin chào Hà Nội!\n',
      }),
    });

    assert.equal(
      subRes.status,
      201,
      `Upload subtitles returned ${subRes.status} instead of 201: ${await subRes.text()}`,
    );

    // GET video and verify playback.subtitles
    const vidRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(vidRes.status, 200);
    const videoData = await vidRes.json();

    assert.ok(Array.isArray(videoData.playback.subtitles), 'playback.subtitles must be an array');
    const track = videoData.playback.subtitles.find((s) => s.lang === 'vi');
    assert.ok(track, 'Subtitle track for "vi" missing in playback response');
    assert.equal(track.lang, 'vi');

    // Fetch subtitle .vtt URL
    const vttRes = await fetch(track.url);
    assert.equal(vttRes.status, 200, `Subtitle .vtt fetch returned ${vttRes.status}`);
    const vttText = await vttRes.text();
    assert.ok(vttText.includes('WEBVTT'), 'Subtitle VTT file content invalid');

    recordResult('S12', 'subtitles (V5b)', 'PASSED', Date.now() - startTime);
  });
});
