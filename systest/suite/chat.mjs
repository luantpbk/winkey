/* global fetch, console, process, WebSocket, TextDecoder */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import initVodozemac, {
  Account,
  GroupSession,
  InboundGroupSession,
} from '../../apps/web/e2ee-wasm/pkg/vodozemac_winkey.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8080';
const RESET_SCRIPT = path.resolve(__dirname, '../reset-ratelimits.sh');

let INVITE_CODE = process.env.INVITE_CODE || '';
if (!INVITE_CODE) {
  try {
    const keyFile = path.resolve(__dirname, '../.run/keys/invite_code.txt');
    if (fs.existsSync(keyFile)) {
      INVITE_CODE = fs.readFileSync(keyFile, 'utf8').trim();
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON & Signature Helpers (RFC 8785 subset)
// ---------------------------------------------------------------------------
export function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(',')}]`;
  }
  const obj = value;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

export function buildDeviceKeysPayload(params) {
  return canonicalJsonStringify({
    algorithms: ['m.megolm.v1.aes-sha2', 'm.olm.v1.curve25519-aes-sha2'],
    curve25519: params.curve25519,
    device_id: params.deviceId,
    ed25519: params.ed25519,
    user_id: params.userId,
  });
}

export function buildOneTimeKeyPayload(params) {
  return canonicalJsonStringify({
    device_id: params.deviceId,
    fallback: params.fallback,
    key: params.key,
    key_id: params.keyId,
  });
}

// ---------------------------------------------------------------------------
// Rate limits & Database Helpers
// ---------------------------------------------------------------------------
export function resetRateLimits() {
  if (fs.existsSync(RESET_SCRIPT)) {
    try {
      execSync(`bash "${RESET_SCRIPT}"`, { stdio: 'pipe' });
    } catch (err) {
      console.warn(`[chat-test] resetRateLimits warning: ${err.message}`);
    }
  }
}

export async function checkRes(res, expectedStatus, label = 'Request') {
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }
  }
  assert.equal(
    res.status,
    expectedStatus,
    `${label} failed with status ${res.status} (expected ${expectedStatus}): ${text}`,
  );
  return { status: res.status, text, json, headers: res.headers };
}

// Ensure vodozemac WASM is initialized
let wasmInitPromise = null;
export async function ensureWasm() {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const wasmPath = path.resolve(REPO_ROOT, 'apps/web/public/wasm/vodozemac_winkey_bg.wasm');
      const wasmBytes = fs.readFileSync(wasmPath);
      await initVodozemac({ module_or_path: wasmBytes });
    })();
  }
  return wasmInitPromise;
}

// ---------------------------------------------------------------------------
// User & Device Factory Helpers
// ---------------------------------------------------------------------------
let userCounter = 0;
export async function registerTestUser(displayName = 'Chat User') {
  resetRateLimits();
  const nonce = `${Date.now()}_${++userCounter}_${Math.random().toString(36).slice(2, 7)}`;
  const email = `chat_u_${nonce}@winkey.test`;
  const handle = `chat_u_${nonce}`;
  const password = 'Password123!';

  const res = await fetch(`${GATEWAY_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      handle,
      display_name: displayName,
      ...(INVITE_CODE ? { invite_code: INVITE_CODE } : {}),
    }),
  });

  const resData = (await checkRes(res, 201, `Register ${displayName}`)).json;
  return {
    id: resData.user.id,
    handle: resData.user.handle,
    email: resData.user.email,
    token: resData.access_token,
  };
}

export class TestDevice {
  constructor(userId, deviceId = crypto.randomUUID(), displayName = 'Test Device') {
    this.userId = userId;
    this.deviceId = deviceId;
    this.displayName = displayName;
    this.account = new Account();
    this.curve25519Key = this.account.curve25519Key();
    this.ed25519Key = this.account.ed25519Key();
    this.fallbackKey = null;
    this.oneTimeKeys = [];
    this.inboundGroupSessions = new Map(); // conversation_id:session_id -> InboundGroupSession
    this.olmSessions = new Map(); // peer_curve25519 -> Session
  }

  generateFallbackKey() {
    this.account.generateFallbackKey();
    const fbRaw = JSON.parse(this.account.fallbackKey());
    const canonical = buildOneTimeKeyPayload({
      deviceId: this.deviceId,
      keyId: fbRaw.key_id,
      key: fbRaw.key,
      fallback: true,
    });
    this.fallbackKey = {
      key_id: fbRaw.key_id,
      public_key: fbRaw.key,
      signature: this.account.sign(canonical),
    };
    return this.fallbackKey;
  }

  generateOneTimeKeys(count) {
    this.account.generateOneTimeKeys(count);
    const rawOtks = JSON.parse(this.account.oneTimeKeys()).curve25519;
    const signed = Object.entries(rawOtks).map(([key_id, public_key]) => {
      const canonical = buildOneTimeKeyPayload({
        deviceId: this.deviceId,
        keyId: key_id,
        key: public_key,
        fallback: false,
      });
      return {
        key_id,
        public_key,
        signature: this.account.sign(canonical),
      };
    });
    this.oneTimeKeys.push(...signed);
    return signed;
  }

  buildRegistrationPayload(tamperSignature = false) {
    const canonical = buildDeviceKeysPayload({
      userId: this.userId,
      deviceId: this.deviceId,
      curve25519: this.curve25519Key,
      ed25519: this.ed25519Key,
    });
    let signature = this.account.sign(canonical);
    if (tamperSignature) {
      // Invert last character of signature to tamper
      const lastChar = signature.slice(-1);
      const replacement = lastChar === 'A' ? 'B' : 'A';
      signature = signature.slice(0, -1) + replacement;
    }
    return {
      display_name: this.displayName,
      curve25519_key: this.curve25519Key,
      ed25519_key: this.ed25519Key,
      signature,
      fallback_key: this.fallbackKey || undefined,
    };
  }

  async register(token, tamperSignature = false) {
    const body = this.buildRegistrationPayload(tamperSignature);
    const res = await fetch(`${GATEWAY_URL}/v1/chat/devices/${this.deviceId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return res;
  }

  async uploadOneTimeKeys(token, keysToUpload = this.oneTimeKeys) {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/devices/${this.deviceId}/one-time-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ keys: keysToUpload }),
    });
    return res;
  }
}

// ---------------------------------------------------------------------------
// S13 E2EE Chat Test Suite
// ---------------------------------------------------------------------------
export async function runChatScenario() {
  await ensureWasm();
  const startTime = Date.now();
  console.log('[S13-chat] Starting E2EE Chat integration tests...');

  // 1. Create primary users Alice, Bob, Charlie
  const alice = await registerTestUser('Alice Tester');
  const bob = await registerTestUser('Bob Tester');
  const charlie = await registerTestUser('Charlie Stranger');

  const capturedCiphertexts = new Set();
  const capturedSecretKeys = new Set();

  // -------------------------------------------------------------------------
  // 1. Devices Matrix
  // -------------------------------------------------------------------------
  console.log('[S13-chat] Testing Devices registration, signatures and limits...');
  const devA1 = new TestDevice(alice.id, crypto.randomUUID(), 'Alice Laptop');
  const devA2 = new TestDevice(alice.id, crypto.randomUUID(), 'Alice Phone');
  const devB1 = new TestDevice(bob.id, crypto.randomUUID(), 'Bob Desktop');

  devA1.generateFallbackKey();
  devA2.generateFallbackKey();
  devB1.generateFallbackKey();

  // Record public keys for privacy audit
  capturedSecretKeys.add(devA1.curve25519Key);
  capturedSecretKeys.add(devA1.ed25519Key);
  capturedSecretKeys.add(devB1.curve25519Key);

  // A. Tampered signature -> 400 INVALID_SIGNATURE
  const tamperedDev = new TestDevice(alice.id, crypto.randomUUID(), 'Tampered Device');
  tamperedDev.generateFallbackKey();
  const tamperedRes = await tamperedDev.register(alice.token, true);
  const tamperedData = await checkRes(tamperedRes, 400, 'Tampered signature device registration');
  assert.equal(tamperedData.json?.code, 'INVALID_SIGNATURE');

  // B. Register valid devices
  const regA1Res = await devA1.register(alice.token);
  await checkRes(regA1Res, 201, 'Register devA1');

  const regA2Res = await devA2.register(alice.token);
  await checkRes(regA2Res, 201, 'Register devA2');

  const regB1Res = await devB1.register(bob.token);
  await checkRes(regB1Res, 201, 'Register devB1');

  // C. Reusing an identity key -> 409 IDENTITY_KEY_IN_USE
  const duplicateKeyDev = new TestDevice(alice.id, crypto.randomUUID(), 'Duplicate Key Device');
  duplicateKeyDev.generateFallbackKey();
  duplicateKeyDev.curve25519Key = devA1.curve25519Key; // Reuse curve25519 key
  // Resign canonical with reused curve25519 key
  const dupCanonical = buildDeviceKeysPayload({
    userId: alice.id,
    deviceId: duplicateKeyDev.deviceId,
    curve25519: duplicateKeyDev.curve25519Key,
    ed25519: duplicateKeyDev.ed25519Key,
  });
  const dupRes = await fetch(`${GATEWAY_URL}/v1/chat/devices/${duplicateKeyDev.deviceId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      display_name: duplicateKeyDev.displayName,
      curve25519_key: duplicateKeyDev.curve25519Key,
      ed25519_key: duplicateKeyDev.ed25519Key,
      signature: duplicateKeyDev.account.sign(dupCanonical),
      fallback_key: duplicateKeyDev.fallbackKey,
    }),
  });
  const dupData = await checkRes(dupRes, 409, 'Reuse identity key');
  assert.equal(dupData.json?.code, 'IDENTITY_KEY_IN_USE');

  // D. 11th active device -> 409 TOO_MANY_DEVICES
  // Alice already has 2 active devices (devA1, devA2). Register 8 more (reaching 10), then 11th.
  console.log('[S13-chat] Registering devices up to limit (10 active devices)...');
  for (let i = 3; i <= 10; i++) {
    const extraDev = new TestDevice(alice.id, crypto.randomUUID(), `Alice Device ${i}`);
    extraDev.generateFallbackKey();
    const res = await extraDev.register(alice.token);
    await checkRes(res, 201, `Register device ${i}`);
  }

  const dev11 = new TestDevice(alice.id, crypto.randomUUID(), 'Alice 11th Device');
  dev11.generateFallbackKey();
  const dev11Res = await dev11.register(alice.token);
  const dev11Data = await checkRes(dev11Res, 409, 'Register 11th device');
  assert.equal(dev11Data.json?.code, 'TOO_MANY_DEVICES');

  // -------------------------------------------------------------------------
  // 2. Keys Matrix: 10 parallel claims on device with 5 OTKs
  // -------------------------------------------------------------------------
  console.log('[S13-chat] Testing 10 parallel claims on device with 5 OTKs...');
  // Upload exactly 5 OTKs to devB1
  const b1Otks = devB1.generateOneTimeKeys(5);
  const uploadOtkRes = await devB1.uploadOneTimeKeys(bob.token, b1Otks);
  const uploadOtkData = (await checkRes(uploadOtkRes, 200, 'Upload 5 OTKs for devB1')).json;
  assert.equal(uploadOtkData.count, 5);
  assert.equal(uploadOtkData.fallback_key_id, devB1.fallbackKey.key_id);

  // Perform 10 parallel claims concurrently from Alice
  const claimPromises = Array.from({ length: 10 }, () =>
    fetch(`${GATEWAY_URL}/v1/chat/keys/claim`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ device_ids: [devB1.deviceId] }),
    }),
  );

  const claimResponses = await Promise.all(claimPromises);
  const claimedKeys = [];
  for (let i = 0; i < claimResponses.length; i++) {
    const r = claimResponses[i];
    const data = (await checkRes(r, 200, `Claim ${i + 1}/10`)).json;
    assert.equal(data.keys.length, 1);
    claimedKeys.push(data.keys[0]);
  }

  // 5 distinct OTKs, then fallback key returned for the rest
  const nonFallback = claimedKeys.filter((k) => k.fallback === false);
  const fallback = claimedKeys.filter((k) => k.fallback === true);

  assert.equal(nonFallback.length, 5, 'Must have claimed exactly 5 one-time keys');
  assert.equal(fallback.length, 5, 'Remaining 5 claims must have returned the fallback key');

  const distinctOtkIds = new Set(nonFallback.map((k) => k.key_id));
  assert.equal(distinctOtkIds.size, 5, 'All 5 claimed one-time keys must be distinct');
  for (const fb of fallback) {
    assert.equal(
      fb.key_id,
      devB1.fallbackKey.key_id,
      'Fallback key id must match registered fallback key',
    );
  }

  // -------------------------------------------------------------------------
  // 3. Requests & Realtime WebSocket Setup
  // -------------------------------------------------------------------------
  console.log('[S13-chat] Setting up Realtime WebSocket subscriptions...');
  // Get ticket for Bob
  const bobTicketRes = await fetch(`${GATEWAY_URL}/v1/realtime/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  const bobTicket = (await checkRes(bobTicketRes, 201, 'Issue Bob ticket')).json.ticket;

  // Connect WebSocket for Bob
  const bobHints = [];
  const wsUrl = `ws://127.0.0.1:8003/v1/realtime?ticket=${bobTicket}`;
  const bobWs = new WebSocket(wsUrl);

  const wsOpenPromise = new Promise((resolve, reject) => {
    bobWs.addEventListener('open', resolve);
    bobWs.addEventListener('error', reject);
  });
  bobWs.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'event' && msg.event === 'chat.hint') {
        bobHints.push(msg.data);
      }
    } catch {
      // ignore
    }
  });

  await wsOpenPromise;

  // A opens DIRECT conversation with Bob (who does not follow Alice)
  console.log('[S13-chat] Alice opens DIRECT conversation with Bob...');
  const createConvRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'DIRECT',
      user_ids: [bob.id],
    }),
  });
  const conv = (await checkRes(createConvRes, 201, 'Create DIRECT conversation')).json;
  const conversationId = conv.id;

  // Verify Bob's state is REQUESTED
  const bobMem = conv.members.find((m) => m.user_id === bob.id);
  assert.ok(bobMem, 'Bob member missing');
  assert.equal(bobMem.state, 'REQUESTED', "Bob's state must start as REQUESTED");

  // Bob attempts sendMessage before accepting -> 403 REQUEST_PENDING
  const dummyCiphertext = 'AQIDBAUG';
  const preAcceptRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bob.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_msg_id: crypto.randomUUID(),
        sender_device_id: devB1.deviceId,
        megolm_session_id: 'test-session',
        ciphertext: dummyCiphertext,
      }),
    },
  );
  const preAcceptData = await checkRes(preAcceptRes, 403, 'Bob sendMessage while REQUESTED');
  assert.equal(preAcceptData.json?.code, 'REQUEST_PENDING');

  // Bob accepts conversation
  const acceptRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${conversationId}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  const acceptedConv = (await checkRes(acceptRes, 200, 'Bob accepts conversation')).json;
  const acceptedBobMem = acceptedConv.members.find((m) => m.user_id === bob.id);
  assert.equal(acceptedBobMem.state, 'ACTIVE');

  // -------------------------------------------------------------------------
  // 4. Full Encrypt/Decrypt Round Trip Across All Three Devices (A1, A2, B1)
  // -------------------------------------------------------------------------
  console.log('[S13-chat] Executing full E2EE Megolm & Olm round trip across A1, A2, B1...');
  // A1 creates outbound Megolm session
  const megolmA1 = new GroupSession();
  const sessionKeyA1 = megolmA1.sessionKey();
  const sessionIdA1 = megolmA1.sessionId();

  // A1 needs OTKs to encrypt to-device payloads for A2 and B1
  // devA2 uploaded OTKs:
  const a2Otks = devA2.generateOneTimeKeys(5);
  await checkRes(await devA2.uploadOneTimeKeys(alice.token, a2Otks), 200, 'Upload OTKs for devA2');

  // Claim keys for A2 and B1
  const claimRes = await fetch(`${GATEWAY_URL}/v1/chat/keys/claim`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_ids: [devA2.deviceId, devB1.deviceId] }),
  });
  const claimedKeysMap = (await checkRes(claimRes, 200, 'Claim keys for A2 and B1')).json.keys;
  const claimedA2 = claimedKeysMap.find((k) => k.device_id === devA2.deviceId);
  const claimedB1 = claimedKeysMap.find((k) => k.device_id === devB1.deviceId);

  // A1 creates Olm outbound sessions to A2 and B1
  const olmA1toA2 = devA1.account.createOutboundSession(devA2.curve25519Key, claimedA2.public_key);
  const olmA1toB1 = devA1.account.createOutboundSession(devB1.curve25519Key, claimedB1.public_key);

  const toDeviceContent = JSON.stringify({
    conversation_id: conversationId,
    session_id: sessionIdA1,
    session_key: sessionKeyA1,
  });

  const encForA2 = olmA1toA2.encrypt(toDeviceContent);
  const encForB1 = olmA1toB1.encrypt(toDeviceContent);

  const b64ForA2 = Buffer.from(encForA2).toString('base64');
  const b64ForB1 = Buffer.from(encForB1).toString('base64');

  capturedCiphertexts.add(b64ForA2);
  capturedCiphertexts.add(b64ForB1);

  // A1 sends to-device messages to A2 and B1
  const toDevRes = await fetch(`${GATEWAY_URL}/v1/chat/to-device`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender_device_id: devA1.deviceId,
      messages: [
        { device_id: devA2.deviceId, ciphertext: b64ForA2 },
        { device_id: devB1.deviceId, ciphertext: b64ForB1 },
      ],
    }),
  });
  const toDevData = (await checkRes(toDevRes, 202, 'Send to-device messages')).json;
  assert.equal(toDevData.accepted, 2);
  assert.equal(toDevData.skipped_device_ids.length, 0);

  // devA2 fetches and decrypts to-device message
  const a2ToDevRes = await fetch(`${GATEWAY_URL}/v1/chat/devices/${devA2.deviceId}/to-device`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  const a2ToDevData = (await checkRes(a2ToDevRes, 200, 'devA2 fetch to-device')).json;
  assert.ok(a2ToDevData.items.length >= 1, 'devA2 must receive to-device message');
  const a2Item = a2ToDevData.items[0];
  const a2DecodedJson = Buffer.from(a2Item.ciphertext, 'base64').toString('utf8');
  const a2OlmMsg = JSON.parse(a2DecodedJson);
  const olmA2fromA1 = devA2.account.createInboundSession(
    devA1.curve25519Key,
    a2OlmMsg.type,
    a2OlmMsg.body,
  );
  const a2DecryptedKeyData = JSON.parse(
    new TextDecoder().decode(olmA2fromA1.decrypt(a2OlmMsg.type, a2OlmMsg.body)),
  );
  const inboundA2 = new InboundGroupSession(a2DecryptedKeyData.session_key);

  // devB1 fetches and decrypts to-device message
  const b1ToDevRes = await fetch(`${GATEWAY_URL}/v1/chat/devices/${devB1.deviceId}/to-device`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  const b1ToDevData = (await checkRes(b1ToDevRes, 200, 'devB1 fetch to-device')).json;
  assert.ok(b1ToDevData.items.length >= 1, 'devB1 must receive to-device message');
  const b1Item = b1ToDevData.items[0];
  const b1DecodedJson = Buffer.from(b1Item.ciphertext, 'base64').toString('utf8');
  const b1OlmMsg = JSON.parse(b1DecodedJson);
  const olmB1fromA1 = devB1.account.createInboundSession(
    devA1.curve25519Key,
    b1OlmMsg.type,
    b1OlmMsg.body,
  );
  const b1DecryptedKeyData = JSON.parse(
    new TextDecoder().decode(olmB1fromA1.decrypt(b1OlmMsg.type, b1OlmMsg.body)),
  );
  const inboundB1 = new InboundGroupSession(b1DecryptedKeyData.session_key);

  // A1 sends Megolm encrypted message M1
  const m1Plaintext = JSON.stringify({ text: 'Hello Bob! Secret handshake 12345.' });
  const m1Ciphertext = megolmA1.encrypt(m1Plaintext);
  capturedCiphertexts.add(m1Ciphertext);

  const sendM1Res = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_msg_id: crypto.randomUUID(),
      sender_device_id: devA1.deviceId,
      megolm_session_id: sessionIdA1,
      ciphertext: m1Ciphertext,
    }),
  });
  const m1Data = (await checkRes(sendM1Res, 201, 'A1 sends M1')).json;
  assert.equal(m1Data.ciphertext, m1Ciphertext);

  // devA2 fetches conversation messages and decrypts M1
  const a2FetchRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${conversationId}/messages?limit=20`,
    {
      headers: { Authorization: `Bearer ${alice.token}` },
    },
  );
  const a2Messages = (await checkRes(a2FetchRes, 200, 'devA2 fetch messages')).json.items;
  const a2M1 = a2Messages.find((m) => m.id === m1Data.id);
  assert.ok(a2M1, 'A2 must see M1');
  const a2DecryptedM1Raw = inboundA2.decrypt(a2M1.ciphertext);
  const a2DecDto = JSON.parse(a2DecryptedM1Raw);
  const a2DecryptedText = new TextDecoder().decode(new Uint8Array(a2DecDto.plaintext));
  assert.equal(a2DecryptedText, m1Plaintext, 'devA2 decrypted text must match M1');

  // devB1 fetches conversation messages and decrypts M1
  const b1FetchRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${conversationId}/messages?limit=20`,
    {
      headers: { Authorization: `Bearer ${bob.token}` },
    },
  );
  const b1Messages = (await checkRes(b1FetchRes, 200, 'devB1 fetch messages')).json.items;
  const b1M1 = b1Messages.find((m) => m.id === m1Data.id);
  assert.ok(b1M1, 'B1 must see M1');
  const b1DecryptedM1Raw = inboundB1.decrypt(b1M1.ciphertext);
  const b1DecDto = JSON.parse(b1DecryptedM1Raw);
  const b1DecryptedText = new TextDecoder().decode(new Uint8Array(b1DecDto.plaintext));
  assert.equal(b1DecryptedText, m1Plaintext, 'devB1 decrypted text must match M1');

  // devB1 replies with M2 to Alice
  const megolmB1 = new GroupSession();
  const sessionKeyB1 = megolmB1.sessionKey();
  const sessionIdB1 = megolmB1.sessionId();

  // devB1 claims OTKs for devA1 and devA2
  const claimAliceRes = await fetch(`${GATEWAY_URL}/v1/chat/keys/claim`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bob.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_ids: [devA1.deviceId, devA2.deviceId] }),
  });
  const claimedAliceKeys = (await checkRes(claimAliceRes, 200, 'Bob claims keys for A1, A2')).json
    .keys;
  const claimedForA1 = claimedAliceKeys.find((k) => k.device_id === devA1.deviceId);
  const claimedForA2 = claimedAliceKeys.find((k) => k.device_id === devA2.deviceId);

  const olmB1toA1 = devB1.account.createOutboundSession(
    devA1.curve25519Key,
    claimedForA1.public_key,
  );
  const olmB1toA2 = devB1.account.createOutboundSession(
    devA2.curve25519Key,
    claimedForA2.public_key,
  );

  const b1ToDevPayload = JSON.stringify({
    conversation_id: conversationId,
    session_id: sessionIdB1,
    session_key: sessionKeyB1,
  });

  const b1ToA1Cipher = Buffer.from(olmB1toA1.encrypt(b1ToDevPayload)).toString('base64');
  const b1ToA2Cipher = Buffer.from(olmB1toA2.encrypt(b1ToDevPayload)).toString('base64');

  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/chat/to-device`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bob.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender_device_id: devB1.deviceId,
        messages: [
          { device_id: devA1.deviceId, ciphertext: b1ToA1Cipher },
          { device_id: devA2.deviceId, ciphertext: b1ToA2Cipher },
        ],
      }),
    }),
    202,
    'Bob sends to-device to A1 and A2',
  );

  // Bob sends M2
  const m2Plaintext = JSON.stringify({ text: 'Got your secret message Alice!' });
  const m2Ciphertext = megolmB1.encrypt(m2Plaintext);
  capturedCiphertexts.add(m2Ciphertext);

  const sendM2Res = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bob.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_msg_id: crypto.randomUUID(),
      sender_device_id: devB1.deviceId,
      megolm_session_id: sessionIdB1,
      ciphertext: m2Ciphertext,
    }),
  });
  await checkRes(sendM2Res, 201, 'Bob sends M2');

  // Both A1 and A2 receive and decrypt M2
  const a1FetchToDev = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/devices/${devA1.deviceId}/to-device`, {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
      200,
      'A1 fetch to-device from Bob',
    )
  ).json;
  const a1ItemFromBob = a1FetchToDev.items[0];
  const a1OlmMsg = JSON.parse(Buffer.from(a1ItemFromBob.ciphertext, 'base64').toString('utf8'));
  const olmA1fromB1 = devA1.account.createInboundSession(
    devB1.curve25519Key,
    a1OlmMsg.type,
    a1OlmMsg.body,
  );
  const a1KeyData = JSON.parse(
    new TextDecoder().decode(olmA1fromB1.decrypt(a1OlmMsg.type, a1OlmMsg.body)),
  );
  const inboundA1 = new InboundGroupSession(a1KeyData.session_key);

  const a1FetchMessages = (
    await checkRes(
      await fetch(
        `${GATEWAY_URL}/v1/chat/conversations/${conversationId}/messages?after_seq=${m1Data.seq}`,
        {
          headers: { Authorization: `Bearer ${alice.token}` },
        },
      ),
      200,
      'A1 fetch M2',
    )
  ).json;
  assert.equal(a1FetchMessages.items.length, 1);
  const a1DecM2Raw = inboundA1.decrypt(a1FetchMessages.items[0].ciphertext);
  const a1DecM2Text = new TextDecoder().decode(new Uint8Array(JSON.parse(a1DecM2Raw).plaintext));
  assert.equal(a1DecM2Text, m2Plaintext, 'A1 decrypted M2 matches');

  // -------------------------------------------------------------------------
  // 5. To-device filtering & Block Relations
  // -------------------------------------------------------------------------
  console.log('[S13-chat] Testing To-device filtering and Block relationships...');
  // C (Charlie, a stranger with no shared conversation with Bob)
  const devC1 = new TestDevice(charlie.id, crypto.randomUUID(), 'Charlie Laptop');
  devC1.generateFallbackKey();
  await checkRes(await devC1.register(charlie.token), 201, 'Register Charlie devC1');

  // C tries sending to-device to Bob's device -> must be skipped
  const cToBRes = await fetch(`${GATEWAY_URL}/v1/chat/to-device`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${charlie.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender_device_id: devC1.deviceId,
      messages: [{ device_id: devB1.deviceId, ciphertext: b64ForB1 }],
    }),
  });
  const cToBData = (await checkRes(cToBRes, 202, 'Stranger C to-device to B')).json;
  assert.equal(cToBData.accepted, 0, 'Stranger message must not be accepted');
  assert.ok(
    cToBData.skipped_device_ids.includes(devB1.deviceId),
    'B1 device must be listed in skipped_device_ids',
  );

  // Alice blocks Bob: PUT /v1/me/blocks/:user_id
  const blockRes = await fetch(`${GATEWAY_URL}/v1/me/blocks/${bob.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  await checkRes(blockRes, 204, 'Alice blocks Bob');

  // Alice sendMessage to Bob -> 403 INTERACTION_BLOCKED
  const blockedSendRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_msg_id: crypto.randomUUID(),
        sender_device_id: devA1.deviceId,
        megolm_session_id: sessionIdA1,
        ciphertext: m1Ciphertext,
      }),
    },
  );
  const blockedSendData = await checkRes(blockedSendRes, 403, 'SendMessage to blocked user');
  assert.equal(blockedSendData.json?.code, 'INTERACTION_BLOCKED');

  // Alice sending to-device to Bob's device is also skipped
  const blockedToDevRes = await fetch(`${GATEWAY_URL}/v1/chat/to-device`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender_device_id: devA1.deviceId,
      messages: [{ device_id: devB1.deviceId, ciphertext: b64ForB1 }],
    }),
  });
  const blockedToDevData = (await checkRes(blockedToDevRes, 202, 'Alice to-device to blocked Bob'))
    .json;
  assert.ok(
    blockedToDevData.skipped_device_ids.includes(devB1.deviceId),
    'Blocked device must be skipped',
  );

  // Unblock Bob
  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/me/blocks/${bob.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.token}` },
    }),
    204,
    'Alice unblocks Bob',
  );

  // -------------------------------------------------------------------------
  // 6. Groups Matrix (4 members, removed left_seq, joined_seq, owner succession, 51st 409)
  // -------------------------------------------------------------------------
  console.log('[S13-chat] Testing Group conversation lifecycle...');
  const userD = await registerTestUser('Member D');
  const userE = await registerTestUser('Member E');

  // Alice creates group of 4 (Alice, Bob, Charlie, Member D)
  const createGroupRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'GROUP',
      title: 'Test Core Group',
      user_ids: [bob.id, charlie.id, userD.id],
    }),
  });
  const group = (await checkRes(createGroupRes, 201, 'Create group of 4')).json;
  const groupId = group.id;

  // Accept memberships so all are ACTIVE
  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }),
    200,
    'Bob accepts group',
  );
  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${charlie.token}` },
    }),
    200,
    'Charlie accepts group',
  );
  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userD.token}` },
    }),
    200,
    'Member D accepts group',
  );

  // Alice sends message 1
  const grpM1Res = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_msg_id: crypto.randomUUID(),
      sender_device_id: devA1.deviceId,
      megolm_session_id: sessionIdA1,
      ciphertext: m1Ciphertext,
    }),
  });
  const grpM1 = (await checkRes(grpM1Res, 201, 'Alice sends grp M1')).json;

  // Admin/Owner Alice removes Member D: DELETE /v1/chat/conversations/:id/members/:user_id
  const removeDRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${groupId}/members/${userD.id}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.token}` },
    },
  );
  await checkRes(removeDRes, 204, 'Remove member D');

  // Alice sends message 2 after D removed
  const grpM2Res = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_msg_id: crypto.randomUUID(),
      sender_device_id: devA1.deviceId,
      megolm_session_id: sessionIdA1,
      ciphertext: m1Ciphertext,
    }),
  });
  const grpM2 = (await checkRes(grpM2Res, 201, 'Alice sends grp M2')).json;

  // Member D fetches messages -> D CANNOT fetch messages after left_seq
  const dMessages = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/messages?limit=50`, {
        headers: { Authorization: `Bearer ${userD.token}` },
      }),
      200,
      'Member D fetch messages',
    )
  ).json.items;
  const dSeesM2 = dMessages.some((m) => m.id === grpM2.id);
  assert.equal(dSeesM2, false, 'Removed member D must not fetch messages after left_seq');

  // Add new member E: POST /v1/chat/conversations/:id/members
  const addERes = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/members`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_ids: [userE.id] }),
  });
  await checkRes(addERes, 200, 'Add member E');
  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userE.token}` },
    }),
    200,
    'Member E accepts group',
  );

  // Member E fetches messages -> E CANNOT fetch messages before joined_seq
  const eMessages = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/messages?limit=50`, {
        headers: { Authorization: `Bearer ${userE.token}` },
      }),
      200,
      'Member E fetch messages',
    )
  ).json.items;
  const eSeesM1 = eMessages.some((m) => m.id === grpM1.id);
  assert.equal(eSeesM1, false, 'New member E must not fetch messages before joined_seq');

  // Owner Alice leaves: hands ownership over to oldest member (Bob)
  const aliceLeaveRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${groupId}/members/${alice.id}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.token}` },
    },
  );
  await checkRes(aliceLeaveRes, 204, 'Owner Alice leaves group');

  // Verify Bob is now OWNER
  const bobGrpRes = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}`, {
        headers: { Authorization: `Bearer ${bob.token}` },
      }),
      200,
      'Bob checks group after owner left',
    )
  ).json;
  assert.equal(bobGrpRes.my_role, 'OWNER', 'Oldest active member Bob must become OWNER');

  // Check 51st member limit -> 409 TOO_MANY_MEMBERS
  console.log('[S13-chat] Testing 51st member limit in group (max 50 members)...');
  // Currently group has Bob, Charlie, E (3 members).
  // Insert 48 dummy active users in postgres, and insert 47 into chat.members so group has exactly 50 members.
  const dummyIds = [];
  const sqlUserInserts = [];
  for (let i = 1; i <= 48; i++) {
    const dId = crypto.randomUUID();
    dummyIds.push(dId);
    sqlUserInserts.push(
      `('${dId}', 'dummy_${i}_${Date.now()}@test.vn', 'hash', 'dummy_${i}_${Date.now()}', 'Dummy ${i}', 'ACTIVE')`,
    );
  }
  execSync(
    `docker exec -i winkey-postgres psql -U postgres -d winkey -c "
      INSERT INTO auth.users (id, email, password_hash, handle, display_name, status)
      VALUES ${sqlUserInserts.join(', ')}
      ON CONFLICT DO NOTHING;
    "`,
  );

  const sqlMemberInserts = dummyIds
    .slice(0, 47)
    .map((uid) => `('${groupId}', '${uid}', 'MEMBER', 'ACTIVE', 1, 0, NOW(), NOW())`);
  execSync(
    `docker exec -i winkey-postgres psql -U postgres -d winkey -c "
      INSERT INTO chat.members (conversation_id, user_id, role, state, joined_seq, last_read_seq, created_at, updated_at)
      VALUES ${sqlMemberInserts.join(', ')};
    "`,
  );

  // Group now has exactly 50 members (3 + 47 = 50).
  // Try adding 1 more member (51st) via API -> 409 TOO_MANY_MEMBERS
  const add51stRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/members`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bob.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_ids: [dummyIds[47]] }),
  });
  const add51stData = await checkRes(add51stRes, 409, 'Add 51st member');
  assert.equal(add51stData.json?.code, 'TOO_MANY_MEMBERS');

  // -------------------------------------------------------------------------
  // 7. Realtime Hints Verification
  // -------------------------------------------------------------------------
  console.log('[S13-chat] Verifying Realtime chat.hint frames received by Bob...');
  bobWs.close();
  assert.ok(bobHints.length > 0, 'Bob must have received chat.hint events');
  const hintKinds = new Set(bobHints.map((h) => h.kind));
  assert.ok(
    hintKinds.has('MESSAGE') || hintKinds.has('TO_DEVICE') || hintKinds.has('CONVERSATION'),
    'Bob must have received at least MESSAGE, TO_DEVICE, or CONVERSATION hints',
  );

  // Verify hints NEVER contain ciphertext or keys
  for (const h of bobHints) {
    assert.equal(h.ciphertext, undefined, 'Hint must never contain ciphertext');
    assert.equal(h.session_key, undefined, 'Hint must never contain session_key');
    assert.equal(h.body, undefined, 'Hint must never contain body');
  }

  // -------------------------------------------------------------------------
  // 8. Privacy Check: Grep chat-svc Container Logs for Ciphertext or Secret Keys
  // -------------------------------------------------------------------------
  console.log('[S13-chat] Running zero-leak privacy check on chat-svc logs...');
  const chatLogs = execSync('docker logs chat-svc', { encoding: 'utf8' });

  for (const ct of capturedCiphertexts) {
    if (ct.length > 20) {
      assert.ok(
        !chatLogs.includes(ct),
        `Privacy Violation: Ciphertext snippet found in chat-svc logs: ${ct.slice(0, 20)}...`,
      );
    }
  }

  for (const key of capturedSecretKeys) {
    if (key.length > 10) {
      assert.ok(
        !chatLogs.includes(key),
        `Privacy Violation: Identity key found in chat-svc logs: ${key}`,
      );
    }
  }

  const durationMs = Date.now() - startTime;
  console.log(`[S13-chat] ALL S13 API tests PASSED in ${(durationMs / 1000).toFixed(2)}s! ✅`);
  return { status: 'PASSED', durationMs };
}

// Standalone execution support
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  describe('S13 E2EE Chat Integration Test Suite', { concurrency: 1 }, () => {
    it('S13-chat: full chat API matrix, devices, keys, requests, realtime & privacy audit', async () => {
      await runChatScenario();
    });
  });
}
