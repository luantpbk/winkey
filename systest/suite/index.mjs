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
    } catch (err) {
      void err;
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
    const rawEtag = partPut.headers.get('etag');
    if (!rawEtag) {
      assert.fail('ETag header missing from PUT part response');
    }
    const etag = rawEtag.replace(/"/g, '');

    // 4. Complete upload
    const completeRes = await fetch(`${GATEWAY_URL}/v1/uploads/${uploadedVideoId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({
        parts: [{ part_number: 1, etag }],
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
        } catch (err) {
          void err;
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

    // Re-authenticate Creator A with new password (changed in S10)
    const loginA = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: creatorUser.email,
        password: 'NewPassword123!',
      }),
    });
    creatorToken = (await checkRes(loginA, 200, 'Re-authenticate Creator A')).json.access_token;

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
  // ---------------------------------------------------------------------------
  // S13: Notifications & Realtime WebSocket Hints (N1/N2)
  // ---------------------------------------------------------------------------
  it('S13: notifications & WS hints (N1/N2)', async () => {
    const startTime = Date.now();

    const regB = await fetch(`${AUTH_URL}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.42.0.131',
      },
      body: JSON.stringify({
        email: `user_b_n1_${Date.now()}@example.com`,
        password: 'Password123!',
        handle: `user_b_n1_${Date.now().toString(36)}`,
        display_name: 'User B',
      }),
    });
    const userB = (await checkRes(regB, 201, 'Register User B')).json;
    const tokenB = userB.access_token;
    const userBData = userB.user;

    const regC = await fetch(`${AUTH_URL}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.42.0.132',
      },
      body: JSON.stringify({
        email: `user_c_n1_${Date.now()}@example.com`,
        password: 'Password123!',
        handle: `user_c_n1_${Date.now().toString(36)}`,
        display_name: 'User C',
      }),
    });
    const userC = (await checkRes(regC, 201, 'Register User C')).json;
    const tokenC = userC.access_token;

    // Helper for WebSocket connection
    async function openWebSocketWithTicket(userToken) {
      const ticketRes = await fetch(`${GATEWAY_URL}/v1/realtime/ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const ticketData = (await checkRes(ticketRes, 201, 'Get WebSocket ticket')).json;

      const wsUrl = GATEWAY_URL.replace(/^http/, 'ws') + `/v1/realtime?ticket=${ticketData.ticket}`;
      const ws = new WebSocket(wsUrl);

      const msgs = [];
      const listeners = [];

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          msgs.push(parsed);
          for (const fn of listeners) {
            fn(parsed);
          }
        } catch {
          // ignore
        }
      };

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
        ws.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });

      return {
        ws,
        msgs,
        waitForEvent: (predicate, timeoutMs = 5000) => {
          return new Promise((resolve, reject) => {
            for (const m of msgs) {
              if (predicate(m)) return resolve(m);
            }
            const timer = setTimeout(
              () => reject(new Error(`Timeout waiting for WS event (${timeoutMs}ms)`)),
              timeoutMs,
            );
            listeners.push((m) => {
              if (predicate(m)) {
                clearTimeout(timer);
                resolve(m);
              }
            });
          });
        },
        close: () => ws.close(),
      };
    }

    const wsA = await openWebSocketWithTicket(creatorToken);
    const wsC = await openWebSocketWithTicket(tokenC);

    try {
      // 1. User B comments on User A's video -> VIDEO_COMMENT
      const comm1Res = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenB}`,
        },
        body: JSON.stringify({ body: 'N1 test top level comment' }),
      });
      await checkRes(comm1Res, 201, 'B comments on A video');

      const hint1 = await wsA.waitForEvent(
        (m) =>
          m.type === 'event' && m.event === 'notification.hint' && m.data?.kind === 'VIDEO_COMMENT',
        5000,
      );
      assert.ok(hint1, 'User A should receive VIDEO_COMMENT hint over WS');

      const cHasHint = wsC.msgs.some((m) => m.type === 'event' && m.event === 'notification.hint');
      assert.equal(cHasHint, false, 'User C should not receive User A notification hint');

      // 2. User B replies to User A's comment -> COMMENT_REPLY
      const commARes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creatorToken}`,
        },
        body: JSON.stringify({ body: 'User A top comment' }),
      });
      const commA = (await checkRes(commARes, 201, 'User A comment')).json;

      const replyRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenB}`,
        },
        body: JSON.stringify({
          body: 'User B reply to A',
          parent_id: commA.id,
        }),
      });
      await checkRes(replyRes, 201, 'B replies to A comment');

      const hint2 = await wsA.waitForEvent(
        (m) =>
          m.type === 'event' && m.event === 'notification.hint' && m.data?.kind === 'COMMENT_REPLY',
        5000,
      );
      assert.ok(hint2, 'User A should receive COMMENT_REPLY hint over WS');

      // 3. User B subscribes to channel A -> NEW_SUBSCRIBER
      const subRes = await fetch(`${GATEWAY_URL}/v1/channels/${creatorUser.id}/subscription`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      await checkRes(subRes, 200, 'B subscribes to A');

      const hint3 = await wsA.waitForEvent(
        (m) =>
          m.type === 'event' &&
          m.event === 'notification.hint' &&
          m.data?.kind === 'NEW_SUBSCRIBER',
        5000,
      );
      assert.ok(hint3, 'User A should receive NEW_SUBSCRIBER hint over WS');

      // 4. Verify GET /v1/notifications/unread-count -> increases
      const unreadRes = await fetch(`${GATEWAY_URL}/v1/notifications/unread-count`, {
        headers: { Authorization: `Bearer ${creatorToken}` },
      });
      const unreadData = (await checkRes(unreadRes, 200, 'GET unread count')).json;
      assert.ok(unreadData.count >= 3, `Unread count should be >= 3, got ${unreadData.count}`);

      // 5. Dedup check: User B subscribes again (idempotent repeat) -> no new notification line
      const subDupRes = await fetch(`${GATEWAY_URL}/v1/channels/${creatorUser.id}/subscription`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      await checkRes(subDupRes, 200, 'B subscribes to A again');

      const notifsRes = await fetch(`${GATEWAY_URL}/v1/notifications`, {
        headers: { Authorization: `Bearer ${creatorToken}` },
      });
      const notifsData = (await checkRes(notifsRes, 200, 'GET notifications')).json;
      const subNotifs = notifsData.items.filter(
        (n) => n.kind === 'NEW_SUBSCRIBER' && n.actor?.id === userBData.id,
      );
      assert.equal(
        subNotifs.length,
        1,
        'Dedup: should only have 1 NEW_SUBSCRIBER notification for same actor and target',
      );

      // 6. POST /v1/notifications/read -> resets unread count to 0
      const readRes = await fetch(`${GATEWAY_URL}/v1/notifications/read`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creatorToken}`,
        },
        body: JSON.stringify({ up_to: new Date().toISOString() }),
      });
      await checkRes(readRes, 204, 'Mark notifications read');

      const unreadAfterRes = await fetch(`${GATEWAY_URL}/v1/notifications/unread-count`, {
        headers: { Authorization: `Bearer ${creatorToken}` },
      });
      const unreadAfterData = (await checkRes(unreadAfterRes, 200, 'GET unread count after read'))
        .json;
      assert.equal(unreadAfterData.count, 0, 'Unread count should be 0 after marking read');
    } finally {
      wsA.close();
      wsC.close();
    }

    recordResult('S13', 'notifications & WS hints (N1/N2)', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S14: Playlists, Batch Videos & Studio Stats (QA3)
  // ---------------------------------------------------------------------------
  it('S14: playlists CRUD, concurrent watch-later, private access, hidden video, batch & studio stats', async () => {
    const startTime = Date.now();
    assert.ok(fs.existsSync(CLIP_PATH), `Test clip missing at ${CLIP_PATH}`);
    const clipBuf = fs.readFileSync(CLIP_PATH);

    // 1. Upload second test video
    const createRes2 = await fetch(`${GATEWAY_URL}/v1/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({
        title: 'Hà Nội ngày về',
        description: 'Second video clip for playlist test',
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: clipBuf.length,
      }),
    });
    const uploadedVideoId2 = (await checkRes(createRes2, 201, 'Create second video upload')).json
      .video_id;

    const presignRes2 = await fetch(`${GATEWAY_URL}/v1/uploads/${uploadedVideoId2}/parts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ part_numbers: [1] }),
    });
    const partUrl2 = (await checkRes(presignRes2, 200, 'Presign second video part')).json.urls[0]
      .url;

    const partPut2 = await fetch(partUrl2, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: clipBuf,
    });
    assert.ok(
      partPut2.status >= 200 && partPut2.status < 300,
      `PUT part 2 failed: ${partPut2.status}`,
    );
    const rawEtag2 = partPut2.headers.get('etag');
    if (!rawEtag2) {
      assert.fail('ETag header missing from PUT part 2 response');
    }
    const etag2 = rawEtag2.replace(/"/g, '');

    const completeRes2 = await fetch(`${GATEWAY_URL}/v1/uploads/${uploadedVideoId2}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({
        parts: [{ part_number: 1, etag: etag2 }],
      }),
    });
    await checkRes(completeRes2, 202, 'Complete second video upload');

    let status2 = 'PROCESSING';
    const pollDeadline2 = Date.now() + 60000;
    while (Date.now() < pollDeadline2) {
      await new Promise((r) => setTimeout(r, 1000));
      const stRes = await fetch(`${GATEWAY_URL}/v1/uploads/${uploadedVideoId2}`, {
        headers: { Authorization: `Bearer ${creatorToken}` },
      });
      if (stRes.status === 200) {
        const sData = await stRes.json();
        if (sData.status === 'READY') {
          status2 = 'READY';
          break;
        }
      }
    }
    assert.equal(status2, 'READY', 'Second video did not reach READY');

    // 2. Playlist CRUD: create, add video, reorder, delete item
    const createPl = await fetch(`${GATEWAY_URL}/v1/playlists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({
        title: 'My Favorite Playlist',
        description: 'System test playlist',
        visibility: 'PUBLIC',
      }),
    });
    const playlistId = (await checkRes(createPl, 201, 'Create playlist')).json.id;

    const addV1 = await fetch(`${GATEWAY_URL}/v1/playlists/${playlistId}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ video_id: uploadedVideoId }),
    });
    await checkRes(addV1, 201, 'Add video 1 to playlist');

    const addV2 = await fetch(`${GATEWAY_URL}/v1/playlists/${playlistId}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ video_id: uploadedVideoId2 }),
    });
    await checkRes(addV2, 201, 'Add video 2 to playlist');

    const itemsRes1 = await fetch(`${GATEWAY_URL}/v1/playlists/${playlistId}/items`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    const itemsData1 = (await checkRes(itemsRes1, 200, 'Get playlist items')).json;
    assert.equal(itemsData1.items.length, 2);
    assert.equal(itemsData1.items[0].video_id, uploadedVideoId);
    assert.equal(itemsData1.items[1].video_id, uploadedVideoId2);

    const moveRes = await fetch(
      `${GATEWAY_URL}/v1/playlists/${playlistId}/items/${uploadedVideoId2}/move`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creatorToken}`,
        },
        body: JSON.stringify({ before_video_id: uploadedVideoId }),
      },
    );
    await checkRes(moveRes, 200, 'Move playlist item');

    const itemsRes2 = await fetch(`${GATEWAY_URL}/v1/playlists/${playlistId}/items`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    const itemsData2 = (await checkRes(itemsRes2, 200, 'Get reordered items')).json;
    assert.equal(itemsData2.items[0].video_id, uploadedVideoId2);
    assert.equal(itemsData2.items[1].video_id, uploadedVideoId);

    const delItemRes = await fetch(
      `${GATEWAY_URL}/v1/playlists/${playlistId}/items/${uploadedVideoId2}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${creatorToken}` },
      },
    );
    await checkRes(delItemRes, 204, 'Remove playlist item');

    const itemsRes3 = await fetch(`${GATEWAY_URL}/v1/playlists/${playlistId}/items`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    const itemsData3 = (await checkRes(itemsRes3, 200, 'Get items after deletion')).json;
    assert.equal(itemsData3.items.length, 1);
    assert.equal(itemsData3.items[0].video_id, uploadedVideoId);

    // 3. Concurrent "Watch Later" requests -> exactly 1 playlist
    const activeViewerReg = await fetch(`${AUTH_URL}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.42.0.141',
      },
      body: JSON.stringify({
        email: `viewer_active_${Date.now()}@example.com`,
        password: 'Password123!',
        handle: `viewer_active_${Date.now()}`,
        display_name: 'Active Viewer',
      }),
    });
    const activeViewerToken = (await checkRes(activeViewerReg, 201, 'Register active viewer')).json
      .access_token;

    const [wl1, wl2] = await Promise.all([
      fetch(`${GATEWAY_URL}/v1/me/watch-later`, {
        headers: { Authorization: `Bearer ${activeViewerToken}` },
      }),
      fetch(`${GATEWAY_URL}/v1/me/watch-later`, {
        headers: { Authorization: `Bearer ${activeViewerToken}` },
      }),
    ]);
    const wlData1 = (await checkRes(wl1, 200, 'Watch later req 1')).json;
    const wlData2 = (await checkRes(wl2, 200, 'Watch later req 2')).json;
    assert.equal(
      wlData1.id,
      wlData2.id,
      'Concurrent watch-later requests must return same playlist id',
    );

    // 4. PRIVATE playlist: non-owner gets 404
    const privPlRes = await fetch(`${GATEWAY_URL}/v1/playlists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({
        title: 'Private Secrets Playlist',
        visibility: 'PRIVATE',
      }),
    });
    const privPlId = (await checkRes(privPlRes, 201, 'Create PRIVATE playlist')).json.id;

    const ownerPrivGet = await fetch(`${GATEWAY_URL}/v1/playlists/${privPlId}`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    await checkRes(ownerPrivGet, 200, 'Owner read PRIVATE playlist');

    const otherPrivGet = await fetch(`${GATEWAY_URL}/v1/playlists/${privPlId}`, {
      headers: { Authorization: `Bearer ${activeViewerToken}` },
    });
    assert.equal(otherPrivGet.status, 404, 'Non-owner read PRIVATE playlist should return 404');

    // 5. Hidden video: only owner sees it
    const hideRes = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId2}/moderation`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${moderatorToken}`,
      },
      body: JSON.stringify({ state: 'HIDDEN', reason: 'QA3 testing hidden video' }),
    });
    await checkRes(hideRes, 200, 'Hide video for access test');

    const ownerHiddenGet = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId2}`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    await checkRes(ownerHiddenGet, 200, 'Owner read hidden video');

    const otherHiddenGet = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId2}`, {
      headers: { Authorization: `Bearer ${activeViewerToken}` },
    });
    assert.equal(otherHiddenGet.status, 404, 'Non-owner read hidden video should return 404');

    // 6. GET /v1/videos/batch?ids=a,b,c preserves order & drops unviewable/unknown ids
    const fakeUuid = '00000000-0000-7000-8000-000000000000';

    // Active viewer: uploadedVideoId is visible, uploadedVideoId2 is HIDDEN, fakeUuid is unknown -> returns only uploadedVideoId
    const batchResOther = await fetch(
      `${GATEWAY_URL}/v1/videos/batch?ids=${uploadedVideoId},${uploadedVideoId2},${fakeUuid}`,
      {
        headers: { Authorization: `Bearer ${activeViewerToken}` },
      },
    );
    const batchDataOther = (await checkRes(batchResOther, 200, 'Batch get videos non-owner')).json;
    assert.equal(batchDataOther.items.length, 1, 'Hidden and unknown videos must be omitted');
    assert.equal(batchDataOther.items[0].id, uploadedVideoId);

    // Creator A (owner): both uploadedVideoId2 (hidden) and uploadedVideoId are viewable -> preserves requested order
    const batchResOwner = await fetch(
      `${GATEWAY_URL}/v1/videos/batch?ids=${uploadedVideoId2},${uploadedVideoId}`,
      {
        headers: { Authorization: `Bearer ${creatorToken}` },
      },
    );
    const batchDataOwner = (await checkRes(batchResOwner, 200, 'Batch get videos owner')).json;
    assert.equal(batchDataOwner.items.length, 2);
    assert.equal(
      batchDataOwner.items[0].id,
      uploadedVideoId2,
      'First item must match requested order',
    );
    assert.equal(
      batchDataOwner.items[1].id,
      uploadedVideoId,
      'Second item must match requested order',
    );

    // Restore video 2
    const restoreV2 = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId2}/moderation`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${moderatorToken}`,
      },
      body: JSON.stringify({ state: 'VISIBLE' }),
    });
    await checkRes(restoreV2, 200, 'Restore video 2');

    // 7. GET /v1/studio/stats for creator returns 200 with all days
    const statsRes = await fetch(`${GATEWAY_URL}/v1/studio/stats`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    const statsData = (await checkRes(statsRes, 200, 'Creator studio stats')).json;
    assert.ok(Array.isArray(statsData.days), 'Studio stats days must be an array');
    assert.ok(statsData.days.length >= 1, 'Studio stats must return all days');
    assert.ok(statsData.from, 'Studio stats must include "from" date');
    assert.ok(statsData.to, 'Studio stats must include "to" date');
    assert.ok(statsData.totals, 'Studio stats must include "totals"');

    recordResult('S14', 'playlists, batch & studio stats', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S15: Upload Quotas (UQ1 + UQ1-b)
  // ---------------------------------------------------------------------------
  it('S15: upload quotas (UQ1 + UQ1-b)', async () => {
    const startTime = Date.now();

    // a. Concurrent limit: User Q creates 3 active uploads -> 4th returns 429
    const regQ = await fetch(`${AUTH_URL}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.42.0.151',
      },
      body: JSON.stringify({
        email: `user_q_${Date.now()}@example.com`,
        password: 'Password123!',
        handle: `user_q_${Date.now()}`,
        display_name: 'User Q',
      }),
    });
    const userQToken = (await checkRes(regQ, 201, 'Register User Q')).json.access_token;

    const qUploadIds = [];
    for (let i = 1; i <= 3; i++) {
      const upRes = await fetch(`${GATEWAY_URL}/v1/uploads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userQToken}`,
        },
        body: JSON.stringify({
          title: `Upload Q${i}`,
          description: 'Quota test clip',
          filename: `q${i}.mp4`,
          content_type: 'video/mp4',
          size_bytes: 1024,
        }),
      });
      const upData = (await checkRes(upRes, 201, `Create upload Q${i}`)).json;
      qUploadIds.push(upData.video_id);
    }

    const upRes4 = await fetch(`${GATEWAY_URL}/v1/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userQToken}`,
      },
      body: JSON.stringify({
        title: 'Upload Q4',
        description: 'Quota test clip',
        filename: 'q4.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      }),
    });
    const check4 = await checkRes(upRes4, 429, 'User Q 4th concurrent upload');
    assert.equal(check4.json.code, 'UPLOAD_QUOTA_EXCEEDED');
    assert.ok(
      check4.json.detail.toLowerCase().includes('concurrent'),
      `Expected detail to include concurrent, got: ${check4.json.detail}`,
    );
    const retryAfterQ = parseInt(check4.headers.get('Retry-After'), 10);
    assert.ok(
      !isNaN(retryAfterQ) && retryAfterQ >= 1,
      `Invalid Retry-After: ${check4.headers.get('Retry-After')}`,
    );

    // b. Abort one upload -> slot freed -> next upload 201
    const abortQ1 = await fetch(`${GATEWAY_URL}/v1/uploads/${qUploadIds[0]}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userQToken}` },
    });
    await checkRes(abortQ1, 204, 'Abort upload Q1');

    const upRes5 = await fetch(`${GATEWAY_URL}/v1/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userQToken}`,
      },
      body: JSON.stringify({
        title: 'Upload Q5',
        description: 'Quota test clip',
        filename: 'q5.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      }),
    });
    await checkRes(upRes5, 201, 'Create upload Q5 after abort');

    // c. Daily count limit (UQ1-b regression test): User R creates and aborts 20 uploads -> 21st returns 429 daily_count
    const regR = await fetch(`${AUTH_URL}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.42.0.152',
      },
      body: JSON.stringify({
        email: `user_r_${Date.now()}@example.com`,
        password: 'Password123!',
        handle: `user_r_${Date.now()}`,
        display_name: 'User R',
      }),
    });
    const userRToken = (await checkRes(regR, 201, 'Register User R')).json.access_token;

    for (let i = 1; i <= 20; i++) {
      const upR = await fetch(`${GATEWAY_URL}/v1/uploads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userRToken}`,
        },
        body: JSON.stringify({
          title: `Upload R${i}`,
          description: 'Daily count quota test clip',
          filename: `r${i}.mp4`,
          content_type: 'video/mp4',
          size_bytes: 1024,
        }),
      });
      const rData = (await checkRes(upR, 201, `Create upload R${i}`)).json;
      const abortR = await fetch(`${GATEWAY_URL}/v1/uploads/${rData.video_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userRToken}` },
      });
      await checkRes(abortR, 204, `Abort upload R${i}`);
    }

    const upR21 = await fetch(`${GATEWAY_URL}/v1/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userRToken}`,
      },
      body: JSON.stringify({
        title: 'Upload R21',
        description: 'Daily count quota test clip',
        filename: 'r21.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      }),
    });
    const checkR21 = await checkRes(upR21, 429, 'User R 21st upload daily_count');
    assert.equal(checkR21.json.code, 'UPLOAD_QUOTA_EXCEEDED');
    assert.ok(
      checkR21.json.detail.toLowerCase().includes('daily_count'),
      `Expected detail to include daily_count, got: ${checkR21.json.detail}`,
    );

    // d. Daily bytes limit: User S creates 2 x 20 GiB uploads (aborted), 3rd 20 GiB upload returns 429 daily_bytes
    const regS = await fetch(`${AUTH_URL}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.42.0.153',
      },
      body: JSON.stringify({
        email: `user_s_${Date.now()}@example.com`,
        password: 'Password123!',
        handle: `user_s_${Date.now()}`,
        display_name: 'User S',
      }),
    });
    const userSToken = (await checkRes(regS, 201, 'Register User S')).json.access_token;
    const maxSizeBytes = 21474836480; // 20 GiB

    for (let i = 1; i <= 2; i++) {
      const upS = await fetch(`${GATEWAY_URL}/v1/uploads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userSToken}`,
        },
        body: JSON.stringify({
          title: `Upload S${i}`,
          description: 'Daily bytes quota test clip',
          filename: `s${i}.mp4`,
          content_type: 'video/mp4',
          size_bytes: maxSizeBytes,
        }),
      });
      const sData = (await checkRes(upS, 201, `Create upload S${i}`)).json;
      const abortS = await fetch(`${GATEWAY_URL}/v1/uploads/${sData.video_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userSToken}` },
      });
      await checkRes(abortS, 204, `Abort upload S${i}`);
    }

    const upS3 = await fetch(`${GATEWAY_URL}/v1/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userSToken}`,
      },
      body: JSON.stringify({
        title: 'Upload S3',
        description: 'Daily bytes quota test clip',
        filename: 's3.mp4',
        content_type: 'video/mp4',
        size_bytes: maxSizeBytes,
      }),
    });
    const checkS3 = await checkRes(upS3, 429, 'User S 3rd upload daily_bytes');
    assert.equal(checkS3.json.code, 'UPLOAD_QUOTA_EXCEEDED');
    assert.ok(
      checkS3.json.detail.toLowerCase().includes('daily_bytes'),
      `Expected detail to include daily_bytes, got: ${checkS3.json.detail}`,
    );

    // e. Admin exemption: Admin creates 4 concurrent uploads -> 201; abort after
    const adminUploadIds = [];
    for (let i = 1; i <= 4; i++) {
      const upAdmin = await fetch(`${GATEWAY_URL}/v1/uploads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${moderatorToken}`,
        },
        body: JSON.stringify({
          title: `Admin Upload ${i}`,
          description: 'Admin exempt upload',
          filename: `admin${i}.mp4`,
          content_type: 'video/mp4',
          size_bytes: 1024,
        }),
      });
      const adminData = (await checkRes(upAdmin, 201, `Create admin upload ${i}`)).json;
      adminUploadIds.push(adminData.video_id);
    }
    for (const id of adminUploadIds) {
      const abortAdmin = await fetch(`${GATEWAY_URL}/v1/uploads/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${moderatorToken}` },
      });
      await checkRes(abortAdmin, 204, 'Abort admin upload');
    }

    recordResult('S15', 'upload quotas (UQ1 + UQ1-b)', 'PASSED', Date.now() - startTime);
  });

  // ---------------------------------------------------------------------------
  // S16: Password Reset & Email Verification (A6)
  // ---------------------------------------------------------------------------
  it('S16: password reset & email verification (A6)', async () => {
    const startTime = Date.now();

    // a. requestPasswordReset for unknown email and fresh active user: both 202 empty body & timing >= 250 ms
    const unknownEmail = `unknown_${Date.now()}@example.com`;
    const t0 = Date.now();
    const resForgotUnknown = await fetch(`${GATEWAY_URL}/v1/auth/password/forgot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: unknownEmail }),
    });
    const durForgotUnknown = Date.now() - t0;
    const checkForgotUnknown = await checkRes(
      resForgotUnknown,
      202,
      'Forgot password unknown email',
    );
    assert.equal(
      checkForgotUnknown.text,
      '',
      'Forgot password unknown email response body must be empty',
    );
    assert.ok(
      durForgotUnknown >= 250,
      `Forgot password unknown email expected >= 250ms floor, got ${durForgotUnknown}ms`,
    );

    const regActive = await fetch(`${AUTH_URL}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.42.0.161',
      },
      body: JSON.stringify({
        email: `active_a6_${Date.now()}@example.com`,
        password: 'Password123!',
        handle: `active_a6_${Date.now()}`,
        display_name: 'Active A6 User',
      }),
    });
    const activeUserData = (await checkRes(regActive, 201, 'Register Active A6 user')).json;

    const t1 = Date.now();
    const resForgotActive = await fetch(`${GATEWAY_URL}/v1/auth/password/forgot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: activeUserData.user.email }),
    });
    const durForgotActive = Date.now() - t1;
    const checkForgotActive = await checkRes(resForgotActive, 202, 'Forgot password active email');
    assert.equal(
      checkForgotActive.text,
      '',
      'Forgot password active email response body must be empty',
    );
    assert.ok(
      durForgotActive >= 250,
      `Forgot password active email expected >= 250ms floor, got ${durForgotActive}ms`,
    );

    console.log(
      `ℹ S16a timings: unknown email = ${durForgotUnknown}ms, active email = ${durForgotActive}ms`,
    );

    // b. resetPassword with 43-char unknown token -> 400 INVALID_TOKEN; malformed token -> 400
    const unknownToken43 = 'A'.repeat(43);
    const resReset1 = await fetch(`${GATEWAY_URL}/v1/auth/password/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: unknownToken43, new_password: 'NewPassword123!' }),
    });
    const checkReset1 = await checkRes(resReset1, 400, 'Reset password unknown 43-char token');
    assert.equal(checkReset1.json.code, 'INVALID_TOKEN');

    const resResetMalformed = await fetch(`${GATEWAY_URL}/v1/auth/password/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'short', new_password: 'NewPassword123!' }),
    });
    assert.equal(resResetMalformed.status, 400, 'Reset password malformed token must return 400');

    // c. verifyEmail with unknown token -> 400 INVALID_TOKEN
    const resVerifyUnknown = await fetch(`${GATEWAY_URL}/v1/auth/email/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: unknownToken43 }),
    });
    const checkVerifyUnknown = await checkRes(resVerifyUnknown, 400, 'Verify email unknown token');
    assert.equal(checkVerifyUnknown.json.code, 'INVALID_TOKEN');

    // d. GET /v1/auth/me for fresh user -> email_verified: false, then resend verification emails
    const regFreshVerif = await fetch(`${AUTH_URL}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.42.0.162',
      },
      body: JSON.stringify({
        email: `fresh_verif_${Date.now()}@example.com`,
        password: 'Password123!',
        handle: `fresh_verif_${Date.now()}`,
        display_name: 'Fresh Verif User',
      }),
    });
    const freshVerifData = (await checkRes(regFreshVerif, 201, 'Register Fresh Verif User')).json;

    const meRes = await fetch(`${GATEWAY_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${freshVerifData.access_token}` },
    });
    const meData = (await checkRes(meRes, 200, 'GET /v1/auth/me fresh verif user')).json;
    assert.equal(meData.email_verified, false, 'Fresh user email_verified must be false');

    // register sent 1st verification mail. Resend call 1 -> 2nd mail (202), Resend call 2 -> 3rd mail (202), Resend call 3 -> 429 limit reached (3 max/hr)
    const resend1 = await fetch(`${GATEWAY_URL}/v1/auth/email/verification`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${freshVerifData.access_token}` },
    });
    await checkRes(resend1, 202, 'Resend verification call 1');

    const resend2 = await fetch(`${GATEWAY_URL}/v1/auth/email/verification`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${freshVerifData.access_token}` },
    });
    await checkRes(resend2, 202, 'Resend verification call 2');

    const resend3 = await fetch(`${GATEWAY_URL}/v1/auth/email/verification`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${freshVerifData.access_token}` },
    });
    const checkResend3 = await checkRes(resend3, 429, 'Resend verification call 3 rate limit');
    const retryAfterVerif = parseInt(checkResend3.headers.get('Retry-After'), 10);
    assert.ok(
      !isNaN(retryAfterVerif) && retryAfterVerif >= 1,
      `Invalid Retry-After on verification rate limit: ${checkResend3.headers.get('Retry-After')}`,
    );

    // e. auth-svc logs check: assert 0 hits for test emails and 43-char tokens
    const authLogs = execSync('docker logs auth-svc', { encoding: 'utf8' });
    const targetEmails = [unknownEmail, activeUserData.user.email, freshVerifData.user.email];
    for (const email of targetEmails) {
      assert.ok(!authLogs.includes(email), `auth-svc log must not contain email: ${email}`);
    }
    assert.ok(
      !authLogs.includes(unknownToken43),
      `auth-svc log must not contain 43-char token: ${unknownToken43}`,
    );

    recordResult(
      'S16',
      'password reset & email verification (A6)',
      'PASSED',
      Date.now() - startTime,
    );
  });

  // ---------------------------------------------------------------------------
  // S17: Google OAuth Not Configured (#171)
  // ---------------------------------------------------------------------------
  it('S17: Google OAuth not configured', async () => {
    const startTime = Date.now();

    const oauthRes = await fetch(`${GATEWAY_URL}/v1/auth/oauth/google?return_to=/`, {
      redirect: 'manual',
    });
    assert.equal(oauthRes.status, 302, 'Google OAuth without client ID should return 302');
    const location = oauthRes.headers.get('location');
    assert.ok(
      location && location.endsWith('/login?error=oauth_unavailable'),
      `Location header expected to end with /login?error=oauth_unavailable, got: ${location}`,
    );
    const setCookie = oauthRes.headers.get('set-cookie');
    assert.ok(
      !setCookie || !setCookie.includes('wk_oauth_state'),
      `Set-Cookie header must not contain wk_oauth_state when OAuth is unconfigured, got: ${setCookie}`,
    );

    recordResult('S17', 'Google OAuth not configured', 'PASSED', Date.now() - startTime);
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

    // Verify 404 on GET comments (poll up to 10s for async video.deleted event in social-svc)
    let commStatus = 0;
    const commDeadline = Date.now() + 10000;
    while (Date.now() < commDeadline) {
      const getComm = await fetch(`${GATEWAY_URL}/v1/videos/${uploadedVideoId}/comments`);
      commStatus = getComm.status;
      if (commStatus === 404) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(commStatus, 404, 'Comments endpoint should return 404 after video deletion');

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
