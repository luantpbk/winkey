/* global console, process, performance, TextEncoder */
import crypto from 'node:crypto';
import { argon2id } from 'hash-wasm';
import Olm from '@matrix-org/olm';

const subtle = crypto.webcrypto.subtle;

async function runBenchmark() {
  console.log('========================================================================');
  console.log(' SOC-3 E2EE Browser Library Spike — Benchmark Suite');
  console.log(
    ' Measured on: Node.js ' + process.version + ' / ' + process.platform + ' ' + process.arch,
  );
  console.log('========================================================================\n');

  // 1. Startup & Instantiation
  const tStartup0 = performance.now();
  await Olm.init();
  const startupTimeMs = performance.now() - tStartup0;
  console.log(
    `[Startup] WASM fetch, compile & instantiate: ${startupTimeMs.toFixed(2)} ms (Desktop)`,
  );
  console.log(
    `[Startup] Estimated mid-range mobile / 4x CPU throttle: ${(startupTimeMs * 4).toFixed(2)} ms\n`,
  );

  // 2. Olm 1-1
  const tAcc0 = performance.now();
  const alice = new Olm.Account();
  alice.create();
  alice.generate_one_time_keys(50);
  const aliceOtks = JSON.parse(alice.one_time_keys());
  const tAccount = performance.now() - tAcc0;

  const bob = new Olm.Account();
  bob.create();
  const _bobId = JSON.parse(bob.identity_keys()).curve25519;
  const aliceId = JSON.parse(alice.identity_keys()).curve25519;
  const firstOtk = Object.values(aliceOtks.curve25519)[0];

  const tSess0 = performance.now();
  const bobSession = new Olm.Session();
  bobSession.create_outbound(bob, aliceId, firstOtk);
  const initMsg = bobSession.encrypt('init');
  const aliceSession = new Olm.Session();
  aliceSession.create_inbound(alice, initMsg.body);
  const tSessionEst = performance.now() - tSess0;

  // 1,000 runs of 1 KiB encrypt and decrypt
  const payload1KiB = 'W'.repeat(1024);
  const encTimes = [];
  const decTimes = [];

  for (let i = 0; i < 1000; i++) {
    const tE = performance.now();
    const enc = bobSession.encrypt(payload1KiB);
    encTimes.push(performance.now() - tE);

    const tD = performance.now();
    aliceSession.decrypt(enc.type, enc.body);
    decTimes.push(performance.now() - tD);
  }

  encTimes.sort((a, b) => a - b);
  decTimes.sort((a, b) => a - b);
  const encMedian = encTimes[Math.floor(encTimes.length * 0.5)];
  const encP95 = encTimes[Math.floor(encTimes.length * 0.95)];
  const decMedian = decTimes[Math.floor(decTimes.length * 0.5)];
  const decP95 = decTimes[Math.floor(decTimes.length * 0.95)];

  console.log('[Olm 1-1]');
  console.log(`  - Account creation (50 OTKs): ${tAccount.toFixed(2)} ms`);
  console.log(`  - Session establishment:      ${tSessionEst.toFixed(2)} ms`);
  console.log(
    `  - 1 KiB Encrypt: median = ${encMedian.toFixed(3)} ms, p95 = ${encP95.toFixed(3)} ms`,
  );
  console.log(
    `  - 1 KiB Decrypt: median = ${decMedian.toFixed(3)} ms, p95 = ${decP95.toFixed(3)} ms\n`,
  );

  // 3. Megolm Group of 50 (50 users x 2 devices = 100 devices)
  const tGrp0 = performance.now();
  const groupSession = new Olm.OutboundGroupSession();
  groupSession.create();
  const tGroupCreate = performance.now() - tGrp0;

  const sessionKey = groupSession.session_key();
  const tShare0 = performance.now();
  for (let i = 0; i < 100; i++) {
    bobSession.encrypt(sessionKey);
  }
  const tShare100 = performance.now() - tShare0;

  const inboundGroup = new Olm.InboundGroupSession();
  inboundGroup.create(sessionKey);

  const tMsgEnc0 = performance.now();
  const grpMsg = groupSession.encrypt('Group message 1 KiB payload: ' + payload1KiB);
  const tMsgEnc = performance.now() - tMsgEnc0;

  const tMsgDec0 = performance.now();
  inboundGroup.decrypt(grpMsg);
  const tMsgDec = performance.now() - tMsgDec0;

  // Key rotation after 1 member leaves (reshare to remaining 49 users x 2 devices = 98 devices)
  const tRot0 = performance.now();
  const newGroup = new Olm.OutboundGroupSession();
  newGroup.create();
  const newKey = newGroup.session_key();
  for (let i = 0; i < 98; i++) {
    bobSession.encrypt(newKey);
  }
  const tRotation = performance.now() - tRot0;

  console.log('[Megolm Group of 50]');
  console.log(`  - Create OutboundGroupSession:      ${tGroupCreate.toFixed(2)} ms`);
  console.log(
    `  - Share key to 100 devices (Olm):   ${tShare100.toFixed(2)} ms (avg ${(tShare100 / 100).toFixed(2)} ms/dev)`,
  );
  console.log(`  - Message Encrypt (1 KiB):          ${tMsgEnc.toFixed(3)} ms`);
  console.log(`  - Message Decrypt (1 KiB):          ${tMsgDec.toFixed(3)} ms`);
  console.log(`  - Key Rotation (new session + 98 enc): ${tRotation.toFixed(2)} ms\n`);

  // 4. Persistence & Pickle Sizes
  const key32 = '01234567890123456789012345678901';
  const alicePickle = alice.pickle(key32);
  const sessionPickle = aliceSession.pickle(key32);
  const inboundPickle = inboundGroup.pickle(key32);

  // WebCrypto AES-GCM envelope overhead
  const masterKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encSessionPickle = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    masterKey,
    new TextEncoder().encode(sessionPickle),
  );

  console.log('[Persistence & Pickle Sizes]');
  console.log(`  - Account (with 50 OTKs):        ${alicePickle.length} bytes`);
  console.log(
    `  - Olm Session:                   ${sessionPickle.length} bytes (encrypted envelope: ${encSessionPickle.byteLength} bytes)`,
  );
  console.log(`  - InboundGroupSession:           ${inboundPickle.length} bytes`);
  console.log(`  - Non-extractable WebCrypto key: extractable = ${masterKey.extractable}\n`);

  // 5. Key Backup with Argon2id WASM
  const tArgon0 = performance.now();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derivedKeyHex = await argon2id({
    password: 'user-sample-backup-passphrase',
    salt,
    iterations: 3,
    memorySize: 64 * 1024, // 64 MiB
    parallelism: 1,
    hashLength: 32,
    outputType: 'hex',
  });
  const tArgon = performance.now() - tArgon0;

  const derivedKeyBytes = new Uint8Array(
    derivedKeyHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)),
  );
  const backupKey = await subtle.importKey('raw', derivedKeyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const backupBlob = new TextEncoder().encode(
    JSON.stringify({ sessions: [inboundPickle], account: alicePickle }),
  );
  const backupIv = crypto.getRandomValues(new Uint8Array(12));
  const encBackup = await subtle.encrypt({ name: 'AES-GCM', iv: backupIv }, backupKey, backupBlob);

  console.log('[Key Backup (Argon2id WASM + AES-256-GCM)]');
  console.log(`  - Memory: 64 MiB, Iterations: 3, Parallelism: 1`);
  console.log(`  - Derivation time (Desktop):     ${tArgon.toFixed(1)} ms`);
  console.log(`  - Estimated time (Mobile 4x):    ${(tArgon * 4).toFixed(1)} ms`);
  console.log(`  - Encrypted backup blob size:    ${encBackup.byteLength} bytes\n`);

  // 6. Output JSON result for programmatic reporting
  const report = {
    startup: { desktop_ms: startupTimeMs, mobile_estimated_ms: startupTimeMs * 4 },
    olm_1to1: {
      account_creation_ms: tAccount,
      session_establishment_ms: tSessionEst,
      encrypt_1kib_median_ms: encMedian,
      encrypt_1kib_p95_ms: encP95,
      decrypt_1kib_median_ms: decMedian,
      decrypt_1kib_p95_ms: decP95,
    },
    megolm_group_50: {
      create_session_ms: tGroupCreate,
      share_key_100_devices_ms: tShare100,
      encrypt_msg_ms: tMsgEnc,
      decrypt_msg_ms: tMsgDec,
      key_rotation_ms: tRotation,
    },
    persistence: {
      account_pickle_bytes: alicePickle.length,
      olm_session_pickle_bytes: sessionPickle.length,
      inbound_megolm_pickle_bytes: inboundPickle.length,
      non_extractable_crypto_key: true,
    },
    backup: {
      kdf: 'Argon2id WASM (hash-wasm v4.12.0)',
      params: 'm=65536, t=3, p=1',
      derivation_desktop_ms: tArgon,
      derivation_mobile_estimated_ms: tArgon * 4,
    },
  };

  console.log('### JSON RESULT SUMMARY ###');
  console.log(JSON.stringify(report, null, 2));
}

runBenchmark().catch(console.error);
