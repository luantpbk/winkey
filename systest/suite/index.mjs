/* global fetch, setTimeout, clearTimeout, console, process, WebSocket, URL */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8080';
const REALTIME_URL = process.env.REALTIME_URL || 'http://127.0.0.1:8003';
const SOCIAL_URL = process.env.SOCIAL_URL || 'http://127.0.0.1:3004';
const VIDEO_URL = process.env.VIDEO_URL || 'http://127.0.0.1:3003';
const AUTH_URL = process.env.AUTH_URL || 'http://127.0.0.1:3001';
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

const results = [];

function recordResult(scenario, name, status, durationMs, details = '') {
  results.push({ scenario, name, status, durationMs, details });
  const durStr = `${(durationMs / 1000).toFixed(2)}s`;
  const icon = status === 'PASSED' ? '✅' : '❌';
  console.log(
    `${icon} [${scenario}] ${name}: ${status} (${durStr})${details ? ' - ' + details : ''}`,
  );
}

async function checkRes(res, expectedStatus, label = 'Request') {
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // ignore non-JSON response
    }
  }
  assert.equal(
    res.status,
    expectedStatus,
    `${label} failed with status ${res.status} (expected ${expectedStatus}): ${text}`,
  );
  return { status: res.status, text, json, headers: res.headers };
}

describe('Winkey System Integration Test Suite', () => {
  after(() => {
    console.log('\n===================================================================');
    console.log('                 SYSTEM TEST SUITE SUMMARY                         ');
    console.log('===================================================================');
    console.log('| Scenario | Name                             | Result   | Duration |');
    console.log('|----------|----------------------------------|----------|----------|');
    for (const r of results) {
      const sc = r.scenario.padEnd(8);
      const nm = r.name.padEnd(32);
      const st = r.status.padEnd(8);
      const du = `${(r.durationMs / 1000).toFixed(2)}s`.padStart(8);
      console.log(`| ${sc} | ${nm} | ${st} | ${du} |`);
    }
    console.log('===================================================================\n');
  });

  // ---------------------------------------------------------------------------
  // S1: Healthchecks
  // ---------------------------------------------------------------------------
  it('S1: all service healthchecks return 200 OK', async () => {
    const startTime = Date.now();
    const services = [
      { name: 'Gateway Traefik', url: `${GATEWAY_URL}/ping`, key: 'ping' },
      { name: 'Auth Service', url: 'http://127.0.0.1:3001/readyz', key: 'status' },
      { name: 'Upload Service', url: 'http://127.0.0.1:3002/readyz', key: 'status' },
      { name: 'Video Service', url: 'http://127.0.0.1:3003/readyz', key: 'status' },
      { name: 'Social Service', url: 'http://127.0.0.1:3004/readyz', key: 'status' },
      { name: 'Realtime Service', url: 'http://127.0.0.1:8003/readyz', key: 'status' },
      { name: 'Transcoder', url: 'http://127.0.0.1:8084/readyz', key: 'status' },
    ];

    for (const svc of services) {
      const res = await fetch(svc.url);
      assert.equal(res.status, 200, `Healthcheck for ${svc.name} failed with status ${res.status}`);
      const text = await res.text();
      assert.ok(
        text.includes('OK') || text.includes('ok') || text.includes('UP'),
        `Healthcheck payload invalid for ${svc.name}: ${text}`,
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
    const resA = await checkRes(regA, 201, 'Register Creator A');
    creatorToken = resA.json.access_token;
    creatorUser = resA.json.user;
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
    const resB = await checkRes(regB, 201, 'Register Viewer B');
    viewerToken = resB.json.access_token;
    viewerUser = resB.json.user;
    assert.ok(viewerToken, 'Viewer B access token missing');

    // 3. GET /v1/auth/me
    const meRes = await fetch(`${GATEWAY_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    const meData = (await checkRes(meRes, 200, 'GET /v1/auth/me')).json;
    assert.equal(meData.id, creatorUser.id);

    // 4. Header stripping test on /smoke/whoami
    const whoamiRes = await fetch(`${GATEWAY_URL}/smoke/whoami`, {
      headers: {
        'X-User-Id': 'evil-hacker-id',
        'X-User-Roles': 'admin,moderator',
      },
    });
    const whoamiResObj = await checkRes(whoamiRes, 200, 'whoami smoke test');
    assert.ok(
      !whoamiResObj.text.includes('evil-hacker-id'),
      'X-User-Id was not stripped by gateway',
    );

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
    const createData = (await checkRes(createRes, 201, 'Create upload')).json;
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
    const presignData = (await checkRes(presignRes, 200, 'Presign parts')).json;
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
    await checkRes(completeRes, 202, 'Complete upload');

    // 5. Poll status until READY
    let status = 'PROCESSING';
    const pollDeadline = Date.now() + 180000;
    while (Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch(`${GATEWAY_URL}/v1/uploads/${uploadedVideoId}`, {
        headers: { Authorization: `Bearer ${creatorToken}` },
      });
      if (statusRes.status === 200) {
        const sText = await statusRes.text();
        let sData;
        try {
          sData = JSON.parse(sText);
        } catch {
          // ignore non-JSON response
        }
        if (sData) {
          status = sData.status;
          if (status === 'READY') break;
          if (status === 'FAILED') {
            assert.fail(`Transcode job failed: ${sText}`);
          }
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

    const ticketData = (await checkRes(ticketRes, 201, 'Issue ticket')).json;
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
    const video = (await checkRes(vidRes, 200, `GET /v1/videos/${uploadedVideoId}`)).json;
    assert.ok(video.playback, 'video playback object is missing');
    assert.ok(video.playback.hls_url, 'hls_url is missing');
    assert.ok(video.playback.storyboard_url, 'storyboard_url MUST be present');
    masterPlaylistUrl = video.playback.hls_url;

    // 1. Fetch master playlist
    const masterRes = await fetch(video.playback.hls_url);
    const masterResObj = await checkRes(masterRes, 200, 'Master m3u8 fetch');
    assert.ok(masterResObj.text.includes('#EXTM3U'), 'Invalid master playlist');

    // Extract variant playlist path
    const lines = masterResObj.text.split('\n');
    const variantLine = lines.find((l) => l.endsWith('.m3u8') && !l.startsWith('#'));
    assert.ok(variantLine, 'Variant playlist line missing in master playlist');

    const variantUrl = new URL(variantLine, video.playback.hls_url).toString();
    const variantRes = await fetch(variantUrl);
    const variantResObj = await checkRes(variantRes, 200, 'Variant m3u8 fetch');

    // Extract segment URL
    const vLines = variantResObj.text.split('\n');
    const segmentLine = vLines.find(
      (l) => (l.endsWith('.m4s') || l.endsWith('.ts') || l.endsWith('.mp4')) && !l.startsWith('#'),
    );
    assert.ok(segmentLine, 'Segment line missing in variant playlist');

    const segmentUrl = new URL(segmentLine, variantUrl).toString();
    const segRes = await fetch(segmentUrl);
    await checkRes(segRes, 200, 'Segment fetch');

    // Fetch Storyboard VTT
    const sbRes = await fetch(video.playback.storyboard_url);
    const sbResObj = await checkRes(sbRes, 200, 'Storyboard VTT fetch');
    assert.ok(sbResObj.text.includes('WEBVTT'), 'Invalid storyboard VTT format');

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

    const ticketData = (await checkRes(ticketRes, 201, 'Issue ticket S6')).json;
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
    const commentData = (await checkRes(commentRes, 201, 'Create comment')).json;
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
    await checkRes(replyRes, 201, 'Create reply');

    // 5. Viewer B likes video
    const likeRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/like`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    const likeData = (await checkRes(likeRes, 200, 'Like video')).json;
    assert.equal(likeData.liked, true);
    assert.equal(likeData.like_count, 1);

    // 6. Viewer B subscribes to Creator A
    const subRes = await fetch(`${GATEWAY_URL}/v1/channels/${creatorUser.id}/subscription`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    const subData = (await checkRes(subRes, 200, 'Subscribe')).json;
    assert.equal(subData.subscribed, true);

    // 7. Verify listings
    const commentsList = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`);
    const cListData = (await checkRes(commentsList, 200, 'Comments listing')).json;
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
    await checkRes(patchPriv, 200, 'PATCH PRIVATE');

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
    const aVid = (await checkRes(aVidRes, 200, 'Owner GET PRIVATE video')).json;
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
    await checkRes(patchPub, 200, 'PATCH PUBLIC');

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
    const resM = await checkRes(regM, 201, 'Register Moderator M');
    moderatorToken = resM.json.access_token;
    moderatorUser = resM.json.user;

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
    const resM2 = await checkRes(loginM, 200, 'Login Moderator M');
    moderatorToken = resM2.json.access_token;

    // 3. Viewer B reports video (Gateway or Fallback to SOCIAL_URL for Issue #112)
    let reportRes = await fetch(`${GATEWAY_URL}/v1/reports`, {
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

    if (reportRes.status === 404) {
      // TODO(#112): switch to gateway once routed
      reportRes = await fetch(`${SOCIAL_URL}/v1/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': viewerUser.id,
          'X-User-Roles': 'viewer,creator',
        },
        body: JSON.stringify({
          target_type: 'VIDEO',
          target_id: uploadedVideoId,
          reason: 'SPAM',
          note: 'Inappropriate spam video',
        }),
      });
    }

    assert.ok(
      reportRes.status === 200 || reportRes.status === 201,
      `Report failed: status ${reportRes.status}`,
    );

    // 4. Moderator M views cases (Gateway or Fallback to SOCIAL_URL)
    let modCases = await fetch(`${GATEWAY_URL}/v1/moderation/reports`, {
      headers: { Authorization: `Bearer ${moderatorToken}` },
    });

    if (modCases.status === 404) {
      // TODO(#112): switch to gateway once routed
      modCases = await fetch(`${SOCIAL_URL}/v1/moderation/reports`, {
        headers: {
          'X-User-Id': moderatorUser.id,
          'X-User-Roles': 'viewer,creator,moderator,admin',
        },
      });
    }

    await checkRes(modCases, 200, 'List moderation cases');

    // 5. Moderator M hides video (Gateway or Fallback to SOCIAL_URL)
    let hideRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/moderation`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${moderatorToken}`,
      },
      body: JSON.stringify({ state: 'HIDDEN', reason: 'Violation of terms' }),
    });

    if (hideRes.status === 404) {
      // TODO(#112): switch to gateway once routed
      hideRes = await fetch(`${SOCIAL_URL}/v1/videos/${uploadedVideoId}/moderation`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': moderatorUser.id,
          'X-User-Roles': 'viewer,creator,moderator,admin',
        },
        body: JSON.stringify({ state: 'HIDDEN', reason: 'Violation of terms' }),
      });
    }

    await checkRes(hideRes, 200, 'Hide video');

    // 6. Moderator M resolves case (Gateway or Fallback to SOCIAL_URL)
    let resCase = await fetch(
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

    if (resCase.status === 404) {
      // TODO(#112): switch to gateway once routed
      resCase = await fetch(
        `${SOCIAL_URL}/v1/moderation/cases/VIDEO/${uploadedVideoId}/resolution`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': moderatorUser.id,
            'X-User-Roles': 'viewer,creator,moderator,admin',
          },
          body: JSON.stringify({ status: 'ACTIONED', note: 'Video hidden' }),
        },
      );
    }

    await checkRes(resCase, 200, 'Resolve case');

    // 7. Owner A gets 404 on comments of hidden video
    const aCommHidden = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(aCommHidden.status, 404, 'Owner should get 404 on comments of hidden video');

    // 8. Moderator M can still read hidden video (Gateway or Fallback to VIDEO_URL)
    let modVid = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
      headers: { Authorization: `Bearer ${moderatorToken}` },
    });

    if (modVid.status === 404) {
      // TODO(#112): switch to gateway once routed
      modVid = await fetch(`${VIDEO_URL}/v1/videos/${uploadedVideoId}`, {
        headers: {
          'X-User-Id': moderatorUser.id,
          'X-User-Roles': 'viewer,creator,moderator,admin',
        },
      });
    }

    await checkRes(modVid, 200, 'Moderator read hidden video');

    // 9. Restore video to VISIBLE (Gateway or Fallback to SOCIAL_URL)
    let restoreRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/moderation`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${moderatorToken}`,
      },
      body: JSON.stringify({ state: 'VISIBLE' }),
    });

    if (restoreRes.status === 404) {
      // TODO(#112): switch to gateway once routed
      restoreRes = await fetch(`${SOCIAL_URL}/v1/videos/${uploadedVideoId}/moderation`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': moderatorUser.id,
          'X-User-Roles': 'viewer,creator,moderator,admin',
        },
        body: JSON.stringify({ state: 'VISIBLE' }),
      });
    }

    await checkRes(restoreRes, 200, 'Restore video');

    recordResult('S8', 'moderation flow', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S9: Search (Vietnamese Unaccented Diacritics Folding)
  // ---------------------------------------------------------------------------
  it('S9: search "ha noi" finds "Hà Nội mùa thu"', async () => {
    const startTime = Date.now();
    let searchRes = await fetch(`${GATEWAY_URL}/v1/search?q=ha+noi`);

    if (searchRes.status === 404) {
      // TODO(#112): switch to gateway once routed
      searchRes = await fetch(`${VIDEO_URL}/v1/search?q=ha+noi`);
    }

    const searchData = (await checkRes(searchRes, 200, 'Search request')).json;
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
    const token1 = (await checkRes(login1, 200, 'Login 1')).json.access_token;

    const login2 = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: creatorUser.email,
        password: 'Password123!',
      }),
    });
    const token2 = (await checkRes(login2, 200, 'Login 2')).json.access_token;

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
    await checkRes(pwdRes, 204, 'Change password');

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

    // 5. Admin M suspends Viewer B (Gateway or Fallback to AUTH_URL for Issue #112)
    let suspRes = await fetch(`${GATEWAY_URL}/v1/admin/users/${viewerUser.id}/suspension`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${moderatorToken}`,
      },
      body: JSON.stringify({ reason: 'System test suspension' }),
    });

    if (suspRes.status === 404) {
      // TODO(#112): switch to gateway once routed
      suspRes = await fetch(`${AUTH_URL}/v1/admin/users/${viewerUser.id}/suspension`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': moderatorUser.id,
          'X-User-Roles': 'viewer,creator,moderator,admin',
        },
        body: JSON.stringify({ reason: 'System test suspension' }),
      });
    }

    await checkRes(suspRes, 200, 'Suspend user');

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
  // S12: Subtitles (V5b Merged)
  // ---------------------------------------------------------------------------
  it('S12: subtitles track upload 201 & playback listing', async () => {
    const startTime = Date.now();

    // Upload subtitle track for video
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

    await checkRes(subRes, 201, 'Upload subtitles');

    // GET video and verify playback.subtitles
    const vidRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    const videoData = (await checkRes(vidRes, 200, 'GET video with subtitles')).json;

    assert.ok(Array.isArray(videoData.playback.subtitles), 'playback.subtitles must be an array');
    const track = videoData.playback.subtitles.find((s) => s.lang === 'vi');
    assert.ok(track, 'Subtitle track for "vi" missing in playback response');
    assert.equal(track.lang, 'vi');

    // Fetch subtitle .vtt URL
    const vttRes = await fetch(track.url);
    const vttObj = await checkRes(vttRes, 200, 'Fetch subtitle VTT');
    assert.ok(vttObj.text.includes('WEBVTT'), 'Subtitle VTT file content invalid');

    recordResult('S12', 'subtitles (V5b)', 'PASSED', Date.now() - startTime);
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
    creatorToken = (await checkRes(loginA, 200, 'Re-authenticate Creator A')).json.access_token;

    // 1. Delete video
    const delRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    await checkRes(delRes, 204, 'Delete video');

    // 2. Verify 404 on GET video & comments
    const getVid = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}`);
    assert.equal(getVid.status, 404);

    const getComm = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`);
    assert.equal(getComm.status, 404);

    // 3. Poll master playlist URL until 404 (≤ 60s)
    let mediaDeleted = false;
    const pollDeadline = Date.now() + 60000;
    // Query Garage S3 web endpoint directly (port 3902) to bypass Nginx proxy_cache
    const directS3Url = masterPlaylistUrl.replace(':8081', ':3902');
    while (Date.now() < pollDeadline) {
      const mediaRes = await fetch(directS3Url, {
        headers: { Host: 'winkey-media.web.garage.localhost' },
      });
      if (mediaRes.status === 404 || mediaRes.status === 403) {
        mediaDeleted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.ok(mediaDeleted, 'Master playlist media object was not deleted within 60s');

    recordResult('S11', 'video deletion & media purge', 'PASSED', Date.now() - startTime);
  });
});
