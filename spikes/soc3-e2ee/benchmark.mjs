/* global console, process, performance, TextEncoder */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { argon2id } from 'hash-wasm';
import Olm from '@matrix-org/olm';
import initVodozemac, {
  Account as VodozemacAccount,
  GroupSession as VodozemacGroupSession,
  InboundGroupSession as VodozemacInboundGroupSession,
} from './pkg/vodozemac_winkey.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const subtle = crypto.webcrypto.subtle;

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

async function runBenchmark() {
  console.log('========================================================================');
  console.log(' SOC-3 E2EE Browser Library Spike — Comprehensive Benchmark Suite');
  console.log(
    ' Environment: Node.js ' + process.version + ' / ' + process.platform + ' ' + process.arch,
  );
  console.log(' Primary: vodozemac-winkey (Rust vodozemac 0.11.1 compiled to WebAssembly)');
  console.log(' Baseline: @matrix-org/olm (v3.2.15, C libolm compiled via Emscripten)');
  console.log('========================================================================\n');

  // 1. Startup & Instantiation
  const wasmPath = path.resolve(__dirname, './pkg/vodozemac_winkey_bg.wasm');
  const wasmBytes = fs.readFileSync(wasmPath);

  const tVodoStart0 = performance.now();
  await initVodozemac(wasmBytes);
  const vodoStartupMs = performance.now() - tVodoStart0;

  const tOlmStart0 = performance.now();
  await Olm.init();
  const olmStartupMs = performance.now() - tOlmStart0;

  console.log('[1. Startup & Instantiation]');
  console.log(`  - vodozemac-winkey (Primary): ${vodoStartupMs.toFixed(2)} ms`);
  console.log(`  - @matrix-org/olm (Baseline): ${olmStartupMs.toFixed(2)} ms\n`);

  // 2. Olm 1-1: Account Creation & Session Establishment
  // 2A. Vodozemac
  const tVodoAcc0 = performance.now();
  const vodoAlice = new VodozemacAccount();
  vodoAlice.generateOneTimeKeys(50);
  const vodoAliceOtks = JSON.parse(vodoAlice.oneTimeKeys());
  const vodoAliceId = vodoAlice.curve25519Key();
  const vodoFirstOtk = Object.values(vodoAliceOtks.curve25519)[0];
  const tVodoAccountMs = performance.now() - tVodoAcc0;

  const vodoBob = new VodozemacAccount();
  const vodoBobId = vodoBob.curve25519Key();

  const tVodoSess0 = performance.now();
  const vodoBobSession = vodoBob.createOutboundSession(vodoAliceId, vodoFirstOtk);
  const vodoPrekeyMsg = JSON.parse(vodoBobSession.encrypt('init'));
  const vodoAliceSession = vodoAlice.createInboundSession(
    vodoBobId,
    vodoPrekeyMsg.type,
    vodoPrekeyMsg.body,
  );
  const tVodoSessionEstMs = performance.now() - tVodoSess0;

  // 2B. Libolm
  const tOlmAcc0 = performance.now();
  const olmAlice = new Olm.Account();
  olmAlice.create();
  olmAlice.generate_one_time_keys(50);
  const olmAliceOtks = JSON.parse(olmAlice.one_time_keys());
  const olmAliceId = JSON.parse(olmAlice.identity_keys()).curve25519;
  const olmFirstOtk = Object.values(olmAliceOtks.curve25519)[0];
  const tOlmAccountMs = performance.now() - tOlmAcc0;

  const olmBob = new Olm.Account();
  olmBob.create();

  const tOlmSess0 = performance.now();
  const olmBobSession = new Olm.Session();
  olmBobSession.create_outbound(olmBob, olmAliceId, olmFirstOtk);
  const olmPrekeyMsg = olmBobSession.encrypt('init');
  const olmAliceSession = new Olm.Session();
  olmAliceSession.create_inbound(olmAlice, olmPrekeyMsg.body);
  const tOlmSessionEstMs = performance.now() - tOlmSess0;

  // 3. 1 KiB Encrypt & Decrypt (1,000 runs)
  const payload1KiB = 'W'.repeat(1024);
  const vodoEncTimes = [];
  const vodoDecTimes = [];
  const olmEncTimes = [];
  const olmDecTimes = [];

  const RUNS = 1000;
  for (let i = 0; i < RUNS; i++) {
    // Vodozemac
    const tVE0 = performance.now();
    const vEnc = JSON.parse(vodoBobSession.encrypt(payload1KiB));
    vodoEncTimes.push(performance.now() - tVE0);

    const tVD0 = performance.now();
    vodoAliceSession.decrypt(vEnc.type, vEnc.body);
    vodoDecTimes.push(performance.now() - tVD0);

    // Libolm
    const tOE0 = performance.now();
    const oEnc = olmBobSession.encrypt(payload1KiB);
    olmEncTimes.push(performance.now() - tOE0);

    const tOD0 = performance.now();
    olmAliceSession.decrypt(oEnc.type, oEnc.body);
    olmDecTimes.push(performance.now() - tOD0);
  }

  const vodoEncMedian = percentile(vodoEncTimes, 0.5);
  const vodoEncP95 = percentile(vodoEncTimes, 0.95);
  const vodoDecMedian = percentile(vodoDecTimes, 0.5);
  const vodoDecP95 = percentile(vodoDecTimes, 0.95);

  const olmEncMedian = percentile(olmEncTimes, 0.5);
  const olmEncP95 = percentile(olmEncTimes, 0.95);
  const olmDecMedian = percentile(olmDecTimes, 0.5);
  const olmDecP95 = percentile(olmDecTimes, 0.95);

  console.log('[2. Olm 1-1 Direct Ratchet Performance]');
  console.log(
    `  - Account Creation (50 OTKs): vodozemac=${tVodoAccountMs.toFixed(2)} ms | libolm=${tOlmAccountMs.toFixed(2)} ms`,
  );
  console.log(
    `  - Session Establishment:      vodozemac=${tVodoSessionEstMs.toFixed(2)} ms | libolm=${tOlmSessionEstMs.toFixed(2)} ms`,
  );
  console.log(
    `  - 1 KiB Encrypt (Median):     vodozemac=${vodoEncMedian.toFixed(3)} ms | libolm=${olmEncMedian.toFixed(3)} ms`,
  );
  console.log(
    `  - 1 KiB Encrypt (p95):        vodozemac=${vodoEncP95.toFixed(3)} ms | libolm=${olmEncP95.toFixed(3)} ms`,
  );
  console.log(
    `  - 1 KiB Decrypt (Median):     vodozemac=${vodoDecMedian.toFixed(3)} ms | libolm=${olmDecMedian.toFixed(3)} ms`,
  );
  console.log(
    `  - 1 KiB Decrypt (p95):        vodozemac=${vodoDecP95.toFixed(3)} ms | libolm=${olmDecP95.toFixed(3)} ms\n`,
  );

  // 4. Megolm Group of 50 (100 devices)
  // 4A. Vodozemac
  const tVodoGrp0 = performance.now();
  const vodoGroup = new VodozemacGroupSession();
  const tVodoGroupCreate = performance.now() - tVodoGrp0;
  const vodoSessionKey = vodoGroup.sessionKey();

  const tVodoShare0 = performance.now();
  for (let i = 0; i < 100; i++) {
    vodoBobSession.encrypt(vodoSessionKey);
  }
  const tVodoShare100 = performance.now() - tVodoShare0;

  const vodoInbound = new VodozemacInboundGroupSession(vodoSessionKey);
  const tVodoMsgEnc0 = performance.now();
  const vodoGrpMsg = vodoGroup.encrypt('Group message 1 KiB: ' + payload1KiB);
  const tVodoMsgEnc = performance.now() - tVodoMsgEnc0;

  const tVodoMsgDec0 = performance.now();
  vodoInbound.decrypt(vodoGrpMsg);
  const tVodoMsgDec = performance.now() - tVodoMsgDec0;

  const tVodoRot0 = performance.now();
  const vodoNewGroup = new VodozemacGroupSession();
  const vodoNewKey = vodoNewGroup.sessionKey();
  for (let i = 0; i < 98; i++) {
    vodoBobSession.encrypt(vodoNewKey);
  }
  const tVodoRotation = performance.now() - tVodoRot0;

  // 4B. Libolm
  const tOlmGrp0 = performance.now();
  const olmGroup = new Olm.OutboundGroupSession();
  olmGroup.create();
  const tOlmGroupCreate = performance.now() - tOlmGrp0;
  const olmSessionKey = olmGroup.session_key();

  const tOlmShare0 = performance.now();
  for (let i = 0; i < 100; i++) {
    olmBobSession.encrypt(olmSessionKey);
  }
  const tOlmShare100 = performance.now() - tOlmShare0;

  const olmInbound = new Olm.InboundGroupSession();
  olmInbound.create(olmSessionKey);
  const tOlmMsgEnc0 = performance.now();
  const olmGrpMsg = olmGroup.encrypt('Group message 1 KiB: ' + payload1KiB);
  const tOlmMsgEnc = performance.now() - tOlmMsgEnc0;

  const tOlmMsgDec0 = performance.now();
  olmInbound.decrypt(olmGrpMsg);
  const tOlmMsgDec = performance.now() - tOlmMsgDec0;

  const tOlmRot0 = performance.now();
  const olmNewGroup = new Olm.OutboundGroupSession();
  olmNewGroup.create();
  const olmNewKey = olmNewGroup.session_key();
  for (let i = 0; i < 98; i++) {
    olmBobSession.encrypt(olmNewKey);
  }
  const tOlmRotation = performance.now() - tOlmRot0;

  console.log('[3. Megolm Group of 50 Performance (100 devices)]');
  console.log(
    `  - Create GroupSession:        vodozemac=${tVodoGroupCreate.toFixed(2)} ms | libolm=${tOlmGroupCreate.toFixed(2)} ms`,
  );
  console.log(
    `  - Share Key (100 devices):    vodozemac=${tVodoShare100.toFixed(2)} ms | libolm=${tOlmShare100.toFixed(2)} ms`,
  );
  console.log(
    `  - Group Msg Encrypt (1 KiB):  vodozemac=${tVodoMsgEnc.toFixed(3)} ms | libolm=${tOlmMsgEnc.toFixed(3)} ms`,
  );
  console.log(
    `  - Group Msg Decrypt (1 KiB):  vodozemac=${tVodoMsgDec.toFixed(3)} ms | libolm=${tOlmMsgDec.toFixed(3)} ms`,
  );
  console.log(
    `  - Key Rotation (98 devices):  vodozemac=${tVodoRotation.toFixed(2)} ms | libolm=${tOlmRotation.toFixed(2)} ms\n`,
  );

  // 5. Persistence & Pickle Sizes
  const key32 = new Uint8Array(32).fill(7);
  const key32Str = '01234567890123456789012345678901';

  const vodoAlicePickle = vodoAlice.pickle(key32);
  const vodoSessionPickle = vodoAliceSession.pickle(key32);
  const vodoInboundPickle = vodoInbound.pickle(key32);

  const olmAlicePickle = olmAlice.pickle(key32Str);
  const olmSessionPickle = olmAliceSession.pickle(key32Str);
  const olmInboundPickle = olmInbound.pickle(key32Str);

  const masterKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encEnvelope = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    masterKey,
    new TextEncoder().encode(vodoSessionPickle),
  );

  console.log('[4. Persistence & Pickle Sizes]');
  console.log(
    `  - Account (50 OTKs):          vodozemac=${vodoAlicePickle.length} bytes | libolm=${olmAlicePickle.length} bytes`,
  );
  console.log(
    `  - Olm Session:                vodozemac=${vodoSessionPickle.length} bytes | libolm=${olmSessionPickle.length} bytes`,
  );
  console.log(
    `  - InboundGroupSession:        vodozemac=${vodoInboundPickle.length} bytes | libolm=${olmInboundPickle.length} bytes`,
  );
  console.log(
    `  - WebCrypto AES-GCM Envelope: ${encEnvelope.byteLength} bytes (non-extractable=${!masterKey.extractable})\n`,
  );

  // 6. Argon2id Key Backup
  const tArg0 = performance.now();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const _derivedHex = await argon2id({
    password: 'winkey-user-e2ee-recovery-phrase',
    salt,
    iterations: 3,
    memorySize: 64 * 1024,
    parallelism: 1,
    hashLength: 32,
    outputType: 'hex',
  });
  const tArgonMs = performance.now() - tArg0;

  console.log('[5. Key Backup (Argon2id WASM: m=65536, t=3, p=1)]');
  console.log(`  - Key Derivation Time:        ${tArgonMs.toFixed(1)} ms\n`);

  const results = {
    metadata: {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
      timestamp: new Date().toISOString(),
    },
    startup_ms: {
      vodozemac_primary: vodoStartupMs,
      libolm_baseline: olmStartupMs,
    },
    olm_1to1: {
      account_creation_ms: {
        vodozemac_primary: tVodoAccountMs,
        libolm_baseline: tOlmAccountMs,
      },
      session_establishment_ms: {
        vodozemac_primary: tVodoSessionEstMs,
        libolm_baseline: tOlmSessionEstMs,
      },
      encrypt_1kib_median_ms: {
        vodozemac_primary: vodoEncMedian,
        libolm_baseline: olmEncMedian,
      },
      encrypt_1kib_p95_ms: {
        vodozemac_primary: vodoEncP95,
        libolm_baseline: olmEncP95,
      },
      decrypt_1kib_median_ms: {
        vodozemac_primary: vodoDecMedian,
        libolm_baseline: olmDecMedian,
      },
      decrypt_1kib_p95_ms: {
        vodozemac_primary: vodoDecP95,
        libolm_baseline: olmDecP95,
      },
    },
    megolm_group_50: {
      create_session_ms: {
        vodozemac_primary: tVodoGroupCreate,
        libolm_baseline: tOlmGroupCreate,
      },
      share_key_100_devices_ms: {
        vodozemac_primary: tVodoShare100,
        libolm_baseline: tOlmShare100,
      },
      encrypt_msg_ms: {
        vodozemac_primary: tVodoMsgEnc,
        libolm_baseline: tOlmMsgEnc,
      },
      decrypt_msg_ms: {
        vodozemac_primary: tVodoMsgDec,
        libolm_baseline: tOlmMsgDec,
      },
      key_rotation_ms: {
        vodozemac_primary: tVodoRotation,
        libolm_baseline: tOlmRotation,
      },
    },
    pickle_sizes_bytes: {
      account_50_otks: {
        vodozemac_primary: vodoAlicePickle.length,
        libolm_baseline: olmAlicePickle.length,
      },
      olm_session: {
        vodozemac_primary: vodoSessionPickle.length,
        libolm_baseline: olmSessionPickle.length,
      },
      inbound_megolm_session: {
        vodozemac_primary: vodoInboundPickle.length,
        libolm_baseline: olmInboundPickle.length,
      },
      envelope_aes_gcm: encEnvelope.byteLength,
    },
    argon2id_derivation_ms: tArgonMs,
  };

  return results;
}

runBenchmark()
  .then((res) => {
    console.log('### JSON RESULT SUMMARY ###');
    console.log(JSON.stringify(res, null, 2));
  })
  .catch(console.error);
