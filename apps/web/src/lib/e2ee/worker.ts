/**
 * Dedicated Web Worker for Winkey E2EE Cryptography (ADR-049 §5 / SOC-3a)
 *
 * All private keys, pickles, and cryptographic operations run exclusively inside
 * this worker thread. The main UI thread never holds pickles or private keys.
 */

import { E2eeWorkerEngine } from './engine';
import type { WorkerRpcRequest, WorkerRpcResponse } from './protocol';

const engine = new E2eeWorkerEngine();

self.onmessage = async (event: MessageEvent<WorkerRpcRequest>) => {
  const req = event.data;
  if (!req || !req.id || !req.type) {
    return;
  }

  try {
    let result: any;

    switch (req.type) {
      case 'INIT_SESSION':
        result = await engine.initSession(req.payload.userId, req.payload.wasmUrl);
        break;

      case 'GENERATE_ONE_TIME_KEYS':
        result = await engine.generateOneTimeKeys(req.payload.count);
        break;

      case 'MARK_KEYS_PUBLISHED':
        await engine.markKeysPublished();
        result = { success: true };
        break;

      case 'PREPARE_OUTBOUND_MEGOLM':
        result = await engine.prepareOutboundMegolm(req.payload);
        break;

      case 'ENCRYPT_MESSAGE':
        result = await engine.encryptMessage(req.payload.conversationId, req.payload.plaintext);
        break;

      case 'DECRYPT_TO_DEVICE_BATCH':
        result = await engine.decryptToDeviceBatch(req.payload.messages);
        break;

      case 'DECRYPT_GROUP_MESSAGE':
        result = await engine.decryptGroupMessage(
          req.payload.conversationId,
          req.payload.megolmSessionId,
          req.payload.ciphertext,
        );
        break;

      case 'CHECK_OR_RECORD_DEVICE_TRUST':
        result = await engine.checkOrRecordDeviceTrust(req.payload);
        break;

      case 'BACKUP_CREATE':
        result = await engine.backupCreate(req.payload.passphrase);
        break;
      case 'BACKUP_UNLOCK':
        result = await engine.backupUnlock(req.payload.authData, req.payload.passphrase);
        break;
      case 'BACKUP_ACTIVATE':
        result = await engine.backupActivate(req.payload.version);
        break;
      case 'BACKUP_STATUS':
        result = await engine.backupStatus();
        break;
      case 'BACKUP_FORGET':
        result = await engine.backupForget();
        break;
      case 'BACKUP_EXPORT_PENDING':
        result = await engine.backupExportPending(req.payload.limit);
        break;
      case 'BACKUP_MARK_UPLOADED':
        result = await engine.backupMarkUploaded(req.payload.keys, req.payload.version);
        break;
      case 'BACKUP_IMPORT':
        result = await engine.backupImport(req.payload.sessions);
        break;
      case 'WIPE_DATABASE':
        await engine.wipeDatabase();
        result = { success: true };
        break;

      default:
        throw new Error(`Unknown RPC type: ${(req as any).type}`);
    }

    const response: WorkerRpcResponse = {
      id: req.id,
      ok: true,
      result,
    };
    self.postMessage(response);
  } catch (err: any) {
    const response: WorkerRpcResponse = {
      id: req.id,
      ok: false,
      error: err?.message || String(err),
    };
    self.postMessage(response);
  }
};
