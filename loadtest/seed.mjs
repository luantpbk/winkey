/* global fetch, setTimeout, console, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8080';
const CLIP_PATH = process.env.CLIP_PATH || path.join(__dirname, '../systest/.run/clip.mp4');

const NUM_VIDEOS = parseInt(process.env.NUM_VIDEOS || '5', 10);
const NUM_USERS = parseInt(process.env.NUM_USERS || '5', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(
  url,
  options = {},
  expectedStatus = 200,
  label = 'Request',
  retries = 8,
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // ignore non-JSON
      }
    }
    if (res.status === 429) {
      const waitMs = 2000 * attempt;
      console.log(
        `[seed] Rate limited on ${label} (attempt ${attempt}/${retries}). Waiting ${waitMs / 1000}s...`,
      );
      await sleep(waitMs);
      continue;
    }
    if (res.status !== expectedStatus) {
      throw new Error(
        `${label} failed with status ${res.status} (expected ${expectedStatus}): ${text}`,
      );
    }
    return { status: res.status, text, json, headers: res.headers };
  }
  throw new Error(`${label} failed after ${retries} retries due to rate limiting`);
}

async function main() {
  console.log(`[seed] Starting seed generation for target ${GATEWAY_URL}...`);
  console.log(`[seed] Target: ${NUM_VIDEOS} videos, ${NUM_USERS} users.`);

  if (!fs.existsSync(CLIP_PATH)) {
    throw new Error(
      `Clip file missing at ${CLIP_PATH}. Please run systest/run.sh or generate a test clip first.`,
    );
  }
  const clipBuf = fs.readFileSync(CLIP_PATH);

  const timestamp = Date.now().toString(36);
  const users = [];

  // 1. Register or login users
  console.log(`[seed] Preparing ${NUM_USERS} test users (login/register)...`);
  for (let i = 0; i < NUM_USERS; i++) {
    const handle = `user_lt_seed_${i}`;
    const email = `${handle}@example.com`;
    const password = 'Password123!';

    // Try login first if user already exists
    const loginRes = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (loginRes.status === 200) {
      const loginData = await loginRes.json();
      users.push({
        id: loginData.user.id,
        handle: loginData.user.handle,
        token: loginData.access_token,
      });
      console.log(`[seed] User ${handle} logged in successfully.`);
      await sleep(100);
      continue;
    }

    // Register user if login failed
    let regRes;
    try {
      regRes = await fetchWithRetry(
        `${GATEWAY_URL}/v1/auth/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            handle,
            display_name: `Load Test User ${i}`,
          }),
        },
        201,
        `Register user ${handle}`,
      );
      users.push({
        id: regRes.json.user.id,
        handle: regRes.json.user.handle,
        token: regRes.json.access_token,
      });
      console.log(`[seed] User ${handle} registered successfully.`);
    } catch (err) {
      if (err.message && err.message.includes('409')) {
        const retryLogin = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (retryLogin.status === 200) {
          const lData = await retryLogin.json();
          users.push({
            id: lData.user.id,
            handle: lData.user.handle,
            token: lData.access_token,
          });
          console.log(`[seed] User ${handle} recovered via login after 409.`);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    await sleep(200);
  }
  console.log(`[seed] Successfully prepared ${users.length} users.`);

  // 2. Upload videos using registered users (round-robin)
  console.log(`[seed] Uploading ${NUM_VIDEOS} video clips...`);
  const uploadedVideoIds = [];

  for (let i = 0; i < NUM_VIDEOS; i++) {
    const creatorUser = users[i % users.length];
    const title = `Load Test Video #${i + 1} (${timestamp})`;
    const createRes = await fetchWithRetry(
      `${GATEWAY_URL}/v1/uploads`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creatorUser.token}`,
        },
        body: JSON.stringify({
          title,
          description: `Video generated for load testing session ${timestamp}`,
          filename: `clip_${i}.mp4`,
          content_type: 'video/mp4',
          size_bytes: clipBuf.length,
        }),
      },
      201,
      `Create upload #${i + 1}`,
    );
    const videoId = createRes.json.video_id;

    // Presign part 1
    const presignRes = await fetchWithRetry(
      `${GATEWAY_URL}/v1/uploads/${videoId}/parts`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creatorUser.token}`,
        },
        body: JSON.stringify({ part_numbers: [1] }),
      },
      200,
      `Presign part #${i + 1}`,
    );
    const partUrl = presignRes.json.urls[0].url;

    // Upload part
    const partPut = await fetch(partUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: clipBuf,
    });
    if (partPut.status < 200 || partPut.status >= 300) {
      throw new Error(`PUT part failed with status ${partPut.status}`);
    }
    const etag = partPut.headers.get('etag') || 'dummy-etag';

    // Complete upload
    await fetchWithRetry(
      `${GATEWAY_URL}/v1/uploads/${videoId}/complete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creatorUser.token}`,
        },
        body: JSON.stringify({
          parts: [{ part_number: 1, etag: etag.replace(/"/g, '') }],
        }),
      },
      202,
      `Complete upload #${i + 1}`,
    );
    uploadedVideoIds.push({ videoId, creatorToken: creatorUser.token, title });
    console.log(`[seed] Upload #${i + 1} (${videoId}) submitted for transcoding.`);
    await sleep(200);
  }

  // 3. Poll uploaded videos until READY
  console.log(`[seed] Polling ${uploadedVideoIds.length} videos until READY state...`);
  const videos = [];
  const pollDeadline = Date.now() + 180000; // 3 min

  for (const { videoId, creatorToken, title } of uploadedVideoIds) {
    let ready = false;
    while (Date.now() < pollDeadline) {
      const statusRes = await fetch(`${GATEWAY_URL}/v1/uploads/${videoId}`, {
        headers: { Authorization: `Bearer ${creatorToken}` },
      });
      if (statusRes.status === 200) {
        const text = await statusRes.text();
        let sData;
        try {
          sData = JSON.parse(text);
        } catch {
          // ignore non-JSON
        }
        if (sData && sData.status === 'READY') {
          ready = true;
          break;
        }
        if (sData && sData.status === 'FAILED') {
          throw new Error(`Video ${videoId} transcoding FAILED: ${text}`);
        }
      }
      await sleep(2000);
    }

    if (!ready) {
      throw new Error(`Video ${videoId} failed to reach READY status in 180s`);
    }

    // Fetch video playback info
    const vidRes = await fetchWithRetry(
      `${GATEWAY_URL}/v1/videos/${videoId}`,
      {},
      200,
      `Fetch video ${videoId}`,
    );
    const videoObj = vidRes.json;

    videos.push({
      id: videoObj.id,
      title: title,
      hls_url: videoObj.playback.hls_url,
      storyboard_url: videoObj.playback.storyboard_url,
    });
    console.log(`[seed] Video ${videoId} is READY. HLS URL: ${videoObj.playback.hls_url}`);
  }

  const outData = {
    updated_at: new Date().toISOString(),
    videos,
    users,
  };

  const usersPath = path.join(__dirname, 'users.json');
  const videosPath = path.join(__dirname, 'videos.json');
  const seedPath = path.join(__dirname, 'seed.json');

  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
  fs.writeFileSync(videosPath, JSON.stringify(videos, null, 2));
  fs.writeFileSync(seedPath, JSON.stringify(outData, null, 2));

  console.log(`\n[seed] Seed completed successfully!`);
  console.log(`[seed] Saved ${users.length} users -> ${usersPath}`);
  console.log(`[seed] Saved ${videos.length} ready videos -> ${videosPath}`);
  console.log(`[seed] Combined seed file -> ${seedPath}`);
}

main().catch((err) => {
  console.error('[seed] Error seeding load test dataset:', err);
  process.exit(1);
});
