/* global self, performance */
// worker.js — Local ES Module Web Worker (Zero CDN Dependency, CSP1 Compliant)
import init, { GroupSession, InboundGroupSession } from './pkg/vodozemac_winkey.js';

let wasmReadyPromise = null;

function ensureWasmInitialized() {
  if (!wasmReadyPromise) {
    wasmReadyPromise = init('./pkg/vodozemac_winkey_bg.wasm');
  }
  return wasmReadyPromise;
}

self.onmessage = async (event) => {
  try {
    await ensureWasmInitialized();

    const count = event.data?.count ?? 50;
    const basePayload = event.data?.payload ?? 'W'.repeat(1024);

    const t0 = performance.now();

    // Khởi tạo phiên Megolm Outbound & Inbound độc lập trên luồng Worker
    const outboundGroup = new GroupSession();
    const sessionKey = outboundGroup.sessionKey();
    const inboundGroup = new InboundGroupSession(sessionKey);

    let lastCiphertext = '';
    for (let i = 0; i < count; i++) {
      lastCiphertext = outboundGroup.encrypt(`${basePayload}:${i}`);
      inboundGroup.decrypt(lastCiphertext);
    }

    const durationMs = Number((performance.now() - t0).toFixed(3));

    self.postMessage({
      status: 'ok',
      count,
      duration_ms: durationMs,
      sample_ciphertext: lastCiphertext.slice(0, 32),
    });
  } catch (err) {
    self.postMessage({
      status: 'error',
      error: err?.message || String(err),
    });
  }
};
