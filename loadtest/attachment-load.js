/* global __ENV, __VU, open */
import http from 'k6/http';
import { sleep, check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const createAttachmentDuration = new Trend('create_attachment_duration', true);
const completeAttachmentDuration = new Trend('complete_attachment_duration', true);
const r2PutDuration = new Trend('r2_put_duration', true);
const attachmentErrors = new Rate('attachment_errors');
const attachmentsUploaded = new Counter('attachments_uploaded_count');

export const options = {
  thresholds: {
    // Edge targets per SOC-3b brief:
    // p95 createAttachment < 100 ms server time
    create_attachment_duration: ['p(95)<100'],
    // p95 completeAttachment < 100 ms server time
    complete_attachment_duration: ['p(95)<100'],
    // error rate < 1%
    attachment_errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
  scenarios: {
    attachment_load: {
      executor: 'constant-vus',
      vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 20,
      duration: __ENV.DURATION || '5m',
    },
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const ATTACHMENT_SIZE = 1024 * 1024; // 1 MiB

// Generate 1 MiB dummy payload once in init context
const dummy1MiB = (function () {
  const chunk = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 bytes
  let s = '';
  const repeats = ATTACHMENT_SIZE / chunk.length;
  for (let i = 0; i < repeats; i++) {
    s += chunk;
  }
  return s;
})();

const seedData = (function () {
  try {
    return JSON.parse(open('./seed-chat.json'));
  } catch (err) {
    void err;
    return { users: [], groups: [] };
  }
})();

const users = new SharedArray('users', function () {
  return Array.isArray(seedData.users) ? seedData.users : [];
});

const groups = new SharedArray('groups', function () {
  return Array.isArray(seedData.groups) ? seedData.groups : [];
});

const userMap = (function () {
  const map = {};
  for (const u of seedData.users || []) {
    map[u.id] = u;
  }
  return map;
})();

export default function () {
  if (groups.length === 0 || users.length === 0) {
    sleep(1);
    return;
  }

  // 1. Pick a group and valid member who belongs to this group and has device
  const groupIndex = (__VU - 1) % groups.length;
  const group = groups[groupIndex];
  const validMemberIds = (group.memberUserIds || []).filter((id) => !!userMap[id]);
  if (validMemberIds.length === 0) {
    sleep(1);
    return;
  }
  const memberId = validMemberIds[Math.floor(Math.random() * validMemberIds.length)];
  const senderUser = userMap[memberId];

  const authHeaders = {
    Authorization: `Bearer ${senderUser.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // 2. Step 1: createAttachment (POST /v1/chat/conversations/{convId}/attachments)
  const t0Create = Date.now();
  const createRes = http.post(
    `${TARGET_URL}/v1/chat/conversations/${group.id}/attachments`,
    JSON.stringify({
      sender_device_id: senderUser.deviceId,
      size_bytes: ATTACHMENT_SIZE,
    }),
    {
      headers: authHeaders,
      tags: { name: 'create_attachment' },
    },
  );
  const createDuration = Date.now() - t0Create;
  createAttachmentDuration.add(createDuration);

  const createOk = check(createRes, {
    'createAttachment status is 201': (r) => r.status === 201,
  });

  if (!createOk) {
    attachmentErrors.add(1);
    sleep(1);
    return;
  }

  let createData;
  try {
    createData = createRes.json();
  } catch {
    attachmentErrors.add(1);
    sleep(1);
    return;
  }

  const attachmentId = createData.attachment && createData.attachment.id;
  const uploadUrl = createData.upload_url;
  const uploadHeaders = createData.upload_headers || {};

  if (!attachmentId || !uploadUrl) {
    attachmentErrors.add(1);
    sleep(1);
    return;
  }

  // 3. Step 2: R2 / S3 PUT
  const s3Headers = Object.assign({}, uploadHeaders, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(ATTACHMENT_SIZE),
  });

  const t0Put = Date.now();
  const putRes = http.put(uploadUrl, dummy1MiB, {
    headers: s3Headers,
    tags: { name: 's3_put_attachment' },
  });
  const putDuration = Date.now() - t0Put;
  r2PutDuration.add(putDuration);

  const putOk = check(putRes, {
    'S3 PUT returns 200 or 204': (r) => r.status === 200 || r.status === 204,
  });

  if (!putOk) {
    attachmentErrors.add(1);
    sleep(1);
    return;
  }

  // 4. Step 3: completeAttachment (POST /v1/chat/conversations/{convId}/attachments/{attachId}/complete)
  const t0Complete = Date.now();
  const completeRes = http.post(
    `${TARGET_URL}/v1/chat/conversations/${group.id}/attachments/${attachmentId}/complete`,
    null,
    {
      headers: {
        Authorization: `Bearer ${senderUser.token}`,
      },
      tags: { name: 'complete_attachment' },
    },
  );
  const completeDuration = Date.now() - t0Complete;
  completeAttachmentDuration.add(completeDuration);

  const completeOk = check(completeRes, {
    'completeAttachment status is 200': (r) => r.status === 200,
  });

  if (!completeOk) {
    attachmentErrors.add(1);
  } else {
    attachmentErrors.add(0);
    attachmentsUploaded.add(1);
  }

  // Pace iterations (1 second sleep per VU)
  sleep(1);
}
