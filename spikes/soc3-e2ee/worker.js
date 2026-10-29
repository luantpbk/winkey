/**
 * Web Worker for Offloaded E2EE Operations (SOC-3).
 * Keeps cryptographic computations off the browser main thread.
 */

// Import Olm inside worker scope
importScripts('https://cdn.jsdelivr.net/npm/@matrix-org/olm@3.2.15/olm.js');

let isReady = false;

self.onmessage = async (event) => {
  const { type, payload, id } = event.data;

  if (type === 'INIT') {
    if (!isReady) {
      await Olm.init();
      isReady = true;
    }
    self.postMessage({ id, type: 'INIT_OK' });
    return;
  }

  if (type === 'ENCRYPT_BATCH') {
    if (!isReady) {
      await Olm.init();
      isReady = true;
    }

    const count = payload.count || 100;
    const messageSize = payload.messageSize || 1024;
    const text = 'W'.repeat(messageSize);

    const groupSession = new Olm.OutboundGroupSession();
    groupSession.create();

    const t0 = performance.now();
    const ciphertexts = [];

    for (let i = 0; i < count; i++) {
      ciphertexts.push(groupSession.encrypt(text));
    }

    const durationMs = performance.now() - t0;

    self.postMessage({
      id,
      type: 'BATCH_DONE',
      count,
      durationMs,
      avgPerMsgMs: durationMs / count,
    });
  }
};
