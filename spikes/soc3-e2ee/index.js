/* global window, document, performance, TextEncoder, Worker, console, navigator */
import initVodozemac, {
  Account,
  GroupSession,
  InboundGroupSession,
} from '/pkg/vodozemac_winkey.js';

window.__CSP_VIOLATIONS__ = [];
window.addEventListener('securitypolicyviolation', (e) => {
  const violation = {
    violatedDirective: e.violatedDirective,
    effectiveDirective: e.effectiveDirective,
    blockedURI: e.blockedURI,
    sourceFile: e.sourceFile,
    lineNumber: e.lineNumber,
    originalPolicy: e.originalPolicy,
  };
  window.__CSP_VIOLATIONS__.push(violation);
  console.warn('[CSP Violation Detected]', violation);
});

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

async function runWorkerBatchTest() {
  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker('/worker.js', { type: 'module' });
      const t0 = performance.now();
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.error) {
          reject(new Error(e.data.error));
        } else {
          resolve({
            durationMs: performance.now() - t0,
            innerTimeMs: e.data.time,
            count: e.data.count,
          });
        }
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({ count: 50, messageSize: 1024 });
    } catch (e) {
      reject(e);
    }
  });
}

async function runSuite() {
  const statusEl = document.getElementById('status');
  const outputEl = document.getElementById('output');

  statusEl.innerText = 'Đang khởi tạo WASM...';

  // 1. Startup & Instantiation
  const tVStart = performance.now();
  await initVodozemac();
  const vodoStartupMs = performance.now() - tVStart;

  const tOStart = performance.now();
  await window.Olm.init({
    locateFile: () => '/node_modules/@matrix-org/olm/olm.wasm',
  });
  const olmStartupMs = performance.now() - tOStart;

  statusEl.innerText = 'Đang đo Olm 1-1...';

  // 2. Olm 1-1
  // Vodozemac
  const tVAcc0 = performance.now();
  const vAlice = new Account();
  vAlice.generateOneTimeKeys(50);
  const vAliceOtks = JSON.parse(vAlice.oneTimeKeys());
  const vAliceId = vAlice.curve25519Key();
  const vFirstOtk = Object.values(vAliceOtks.curve25519)[0];
  const tVAccount = performance.now() - tVAcc0;

  const vBob = new Account();
  const vBobId = vBob.curve25519Key();

  const tVSess0 = performance.now();
  const vBobSession = vBob.createOutboundSession(vAliceId, vFirstOtk);
  const vPrekey = JSON.parse(vBobSession.encrypt('init'));
  const vAliceSession = vAlice.createInboundSession(vBobId, vPrekey.type, vPrekey.body);
  const tVSessionEst = performance.now() - tVSess0;

  // Libolm
  const tOAcc0 = performance.now();
  const oAlice = new window.Olm.Account();
  oAlice.create();
  oAlice.generate_one_time_keys(50);
  const oAliceOtks = JSON.parse(oAlice.one_time_keys());
  const oAliceId = JSON.parse(oAlice.identity_keys()).curve25519;
  const oFirstOtk = Object.values(oAliceOtks.curve25519)[0];
  const tOAccount = performance.now() - tOAcc0;

  const oBob = new window.Olm.Account();
  oBob.create();

  const tOSess0 = performance.now();
  const oBobSession = new window.Olm.Session();
  oBobSession.create_outbound(oBob, oAliceId, oFirstOtk);
  const oPrekey = oBobSession.encrypt('init');
  const oAliceSession = new window.Olm.Session();
  oAliceSession.create_inbound(oAlice, oPrekey.body);
  const tOSessionEst = performance.now() - tOSess0;

  // 1 KiB Encrypt & Decrypt (100 runs in browser)
  const payload1k = 'W'.repeat(1024);
  const vEncTimes = [];
  const vDecTimes = [];
  const oEncTimes = [];
  const oDecTimes = [];

  for (let i = 0; i < 100; i++) {
    const tE0 = performance.now();
    const vEnc = JSON.parse(vBobSession.encrypt(payload1k));
    vEncTimes.push(performance.now() - tE0);

    const tD0 = performance.now();
    vAliceSession.decrypt(vEnc.type, vEnc.body);
    vDecTimes.push(performance.now() - tD0);

    const tOE0 = performance.now();
    const oEnc = oBobSession.encrypt(payload1k);
    oEncTimes.push(performance.now() - tOE0);

    const tOD0 = performance.now();
    oAliceSession.decrypt(oEnc.type, oEnc.body);
    oDecTimes.push(performance.now() - tOD0);
  }

  statusEl.innerText = 'Đang đo Megolm Nhóm 50...';

  // 3. Megolm Group of 50
  // Vodozemac
  const tVGrp0 = performance.now();
  const vGroup = new GroupSession();
  const tVGroupCreate = performance.now() - tVGrp0;
  const vKey = vGroup.sessionKey();

  const tVShare0 = performance.now();
  for (let i = 0; i < 100; i++) {
    vBobSession.encrypt(vKey);
  }
  const tVShare100 = performance.now() - tVShare0;

  const vInbound = new InboundGroupSession(vKey);
  const tVMsgEnc0 = performance.now();
  const vGrpMsg = vGroup.encrypt('Group message 1 KiB: ' + payload1k);
  const tVMsgEnc = performance.now() - tVMsgEnc0;

  const tVMsgDec0 = performance.now();
  vInbound.decrypt(vGrpMsg);
  const tVMsgDec = performance.now() - tVMsgDec0;

  const tVRot0 = performance.now();
  const vNewGroup = new GroupSession();
  const vNewKey = vNewGroup.sessionKey();
  for (let i = 0; i < 98; i++) {
    vBobSession.encrypt(vNewKey);
  }
  const tVRotation = performance.now() - tVRot0;

  // Libolm
  const tOGrp0 = performance.now();
  const oGroup = new window.Olm.OutboundGroupSession();
  oGroup.create();
  const tOGroupCreate = performance.now() - tOGrp0;
  const oKey = oGroup.session_key();

  const tOShare0 = performance.now();
  for (let i = 0; i < 100; i++) {
    oBobSession.encrypt(oKey);
  }
  const tOShare100 = performance.now() - tOShare0;

  const oInbound = new window.Olm.InboundGroupSession();
  oInbound.create(oKey);
  const tOMsgEnc0 = performance.now();
  const oGrpMsg = oGroup.encrypt('Group message 1 KiB: ' + payload1k);
  const tOMsgEnc = performance.now() - tOMsgEnc0;

  const tOMsgDec0 = performance.now();
  oInbound.decrypt(oGrpMsg);
  const tOMsgDec = performance.now() - tOMsgDec0;

  const tORot0 = performance.now();
  const oNewGroup = new window.Olm.OutboundGroupSession();
  oNewGroup.create();
  const oNewKey = oNewGroup.session_key();
  for (let i = 0; i < 98; i++) {
    oBobSession.encrypt(oNewKey);
  }
  const tORotation = performance.now() - tORot0;

  statusEl.innerText = 'Đang đo Persistence & WebCrypto...';

  // 4. Persistence & WebCrypto
  const key32 = new Uint8Array(32).fill(7);
  const key32Str = '01234567890123456789012345678901';
  const vAlicePickle = vAlice.pickle(key32);
  const vSessionPickle = vAliceSession.pickle(key32);
  const vInboundPickle = vInbound.pickle(key32);

  const oAlicePickle = oAlice.pickle(key32Str);
  const oSessionPickle = oAliceSession.pickle(key32Str);
  const oInboundPickle = oInbound.pickle(key32Str);

  const masterKey = await window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encEnvelope = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    masterKey,
    new TextEncoder().encode(vSessionPickle),
  );

  statusEl.innerText = 'Đang đo Argon2id...';

  // 5. Argon2id (64 MiB, t=3, p=1)
  const tArg0 = performance.now();
  if (window.hashwasm && window.hashwasm.argon2id) {
    await window.hashwasm.argon2id({
      password: 'winkey-recovery-passphrase',
      salt: window.crypto.getRandomValues(new Uint8Array(16)),
      iterations: 3,
      memorySize: 64 * 1024,
      parallelism: 1,
      hashLength: 32,
      outputType: 'hex',
    });
  }
  const argonMs = performance.now() - tArg0;

  statusEl.innerText = 'Đang đo Web Worker offloading...';

  // 6. Web Worker Offload
  let workerResult = null;
  try {
    workerResult = await runWorkerBatchTest();
  } catch (e) {
    workerResult = { error: e.message };
  }

  const benchmarkPayload = {
    status: 'completed',
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    csp_violations_count: window.__CSP_VIOLATIONS__.length,
    csp_violations: window.__CSP_VIOLATIONS__,
    startup_ms: {
      vodozemac_primary: Number(vodoStartupMs.toFixed(2)),
      libolm_baseline: Number(olmStartupMs.toFixed(2)),
    },
    olm_1to1: {
      account_creation_ms: {
        vodozemac_primary: Number(tVAccount.toFixed(2)),
        libolm_baseline: Number(tOAccount.toFixed(2)),
      },
      session_establishment_ms: {
        vodozemac_primary: Number(tVSessionEst.toFixed(2)),
        libolm_baseline: Number(tOSessionEst.toFixed(2)),
      },
      encrypt_1kib_median_ms: {
        vodozemac_primary: Number(percentile(vEncTimes, 0.5).toFixed(3)),
        libolm_baseline: Number(percentile(oEncTimes, 0.5).toFixed(3)),
      },
      encrypt_1kib_p95_ms: {
        vodozemac_primary: Number(percentile(vEncTimes, 0.95).toFixed(3)),
        libolm_baseline: Number(percentile(oEncTimes, 0.95).toFixed(3)),
      },
      decrypt_1kib_median_ms: {
        vodozemac_primary: Number(percentile(vDecTimes, 0.5).toFixed(3)),
        libolm_baseline: Number(percentile(oDecTimes, 0.5).toFixed(3)),
      },
      decrypt_1kib_p95_ms: {
        vodozemac_primary: Number(percentile(vDecTimes, 0.95).toFixed(3)),
        libolm_baseline: Number(percentile(oDecTimes, 0.95).toFixed(3)),
      },
    },
    megolm_group_50: {
      create_session_ms: {
        vodozemac_primary: Number(tVGroupCreate.toFixed(2)),
        libolm_baseline: Number(tOGroupCreate.toFixed(2)),
      },
      share_key_100_devices_ms: {
        vodozemac_primary: Number(tVShare100.toFixed(2)),
        libolm_baseline: Number(tOShare100.toFixed(2)),
      },
      encrypt_msg_ms: {
        vodozemac_primary: Number(tVMsgEnc.toFixed(3)),
        libolm_baseline: Number(tOMsgEnc.toFixed(3)),
      },
      decrypt_msg_ms: {
        vodozemac_primary: Number(tVMsgDec.toFixed(3)),
        libolm_baseline: Number(tOMsgDec.toFixed(3)),
      },
      key_rotation_ms: {
        vodozemac_primary: Number(tVRotation.toFixed(2)),
        libolm_baseline: Number(tORotation.toFixed(2)),
      },
    },
    persistence_pickle_bytes: {
      account_50_otks: {
        vodozemac_primary: vAlicePickle.length,
        libolm_baseline: oAlicePickle.length,
      },
      olm_session: {
        vodozemac_primary: vSessionPickle.length,
        libolm_baseline: oSessionPickle.length,
      },
      inbound_megolm_session: {
        vodozemac_primary: vInboundPickle.length,
        libolm_baseline: oInboundPickle.length,
      },
      envelope_aes_gcm: encEnvelope.byteLength,
      master_key_non_extractable: !masterKey.extractable,
    },
    argon2id_derivation_ms: Number(argonMs.toFixed(1)),
    worker_offload: workerResult,
  };

  window.__BENCHMARK_RESULTS__ = benchmarkPayload;
  statusEl.innerText = `Hoàn tất kiểm định. CSP Violations: ${window.__CSP_VIOLATIONS__.length}`;
  outputEl.innerText = JSON.stringify(benchmarkPayload, null, 2);
  console.log('[Winkey Benchmark Complete]', benchmarkPayload);
}

runSuite().catch((err) => {
  console.error('[Benchmark Error]', err);
  document.getElementById('status').innerText = 'Lỗi: ' + err.message;
  window.__BENCHMARK_RESULTS__ = {
    status: 'error',
    error: err.message,
    stack: err.stack,
    csp_violations: window.__CSP_VIOLATIONS__,
  };
});
