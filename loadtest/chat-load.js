/* global __ENV, __VU, open */
import http from 'k6/http';
import { sleep, check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const sendMessageDuration = new Trend('send_message_duration', true);
const listMessagesDuration = new Trend('list_messages_duration', true);
const chatErrors = new Rate('chat_errors');
const messagesSent = new Counter('messages_sent_count');
const messagesListed = new Counter('messages_listed_count');

export const options = {
  thresholds: {
    // Edge targets per SOC-3a brief:
    // p95 sendMessage < 120 ms
    send_message_duration: ['p(95)<120'],
    // p95 listMessages < 80 ms
    list_messages_duration: ['p(95)<80'],
    // error rate < 0.5%
    chat_errors: ['rate<0.005'],
    http_req_failed: ['rate<0.005'],
  },
  scenarios: {
    chat_group_load: {
      executor: 'constant-vus',
      vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 20,
      duration: __ENV.DURATION || '1m', // Configurable (e.g. 10m for full edge verification)
    },
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'http://127.0.0.1:8080';

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

// Map of userId -> user object for fast O(1) lookup
const userMap = (function () {
  const map = {};
  for (const u of seedData.users || []) {
    map[u.id] = u;
  }
  return map;
})();

function generateUuid() {
  // Deterministic fast UUID generator for load test k6 environment
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function () {
  if (groups.length === 0 || users.length === 0) {
    sleep(1);
    return;
  }

  // 1. Pick an active group (distribute VUs across the 10 groups)
  const groupIndex = (__VU - 1) % groups.length;
  const group = groups[groupIndex];

  // 2. Pick a random member from this group
  const memberIds = group.memberUserIds;
  const memberId = memberIds[Math.floor(Math.random() * memberIds.length)];
  const senderUser = userMap[memberId] || users[0];

  const authHeaders = {
    Authorization: `Bearer ${senderUser.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const clientMsgId = generateUuid();
  const sessionId = `load_megolm_sess_${group.id.substring(0, 8)}`;
  // 120-byte dummy base64 ciphertext
  const dummyCiphertext =
    'AwAAAAEAAAACAAAABAAAAE1lZ29sbS1sb2FkdGVzdC1jaXBoZXJ0ZXh0LXBhY2tldC1mb3Itd2lua2V5LWNoYXQtc3ZjLWxvYWQtdGVzdGluZw==';

  // 3. Send message to group (Target rate: 2 msg/s per active group)
  const t0 = Date.now();
  const sendRes = http.post(
    `${TARGET_URL}/v1/chat/conversations/${group.id}/messages`,
    JSON.stringify({
      sender_device_id: senderUser.deviceId,
      ciphertext: dummyCiphertext,
      megolm_session_id: sessionId,
      client_msg_id: clientMsgId,
    }),
    {
      headers: authHeaders,
      tags: { endpoint: 'POST /v1/chat/conversations/{id}/messages' },
    },
  );
  sendMessageDuration.add(Date.now() - t0);
  messagesSent.add(1);

  const sendOk = check(sendRes, {
    'send message status 201': (r) => r.status === 201,
  });
  chatErrors.add(!sendOk);

  // 4. Periodically list messages (e.g. 50% of the iterations)
  if (Math.random() < 0.5) {
    const t1 = Date.now();
    const listRes = http.get(`${TARGET_URL}/v1/chat/conversations/${group.id}/messages?limit=50`, {
      headers: {
        Authorization: `Bearer ${senderUser.token}`,
        Accept: 'application/json',
      },
      tags: { endpoint: 'GET /v1/chat/conversations/{id}/messages' },
    });
    listMessagesDuration.add(Date.now() - t1);
    messagesListed.add(1);

    const listOk = check(listRes, {
      'list messages status 200': (r) => r.status === 200,
    });
    chatErrors.add(!listOk);
  }

  // Pace to achieve 2 messages/s per active group:
  // With 20 VUs across 10 groups (~2 VUs per group), sleep ~0.9s - 1.1s
  sleep(0.9 + Math.random() * 0.2);
}
