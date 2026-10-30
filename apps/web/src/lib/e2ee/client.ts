/**
 * Main-thread typed RPC Client for E2EE Web Worker (ADR-049 §5 / SOC-3a)
 *
 * Provides clean async interface for UI components to call into the Web Worker.
 */

import type {
  WorkerRpcRequest,
  WorkerRpcResponse,
  WorkerInitResult,
  WorkerPrepareMegolmResult,
  WorkerEncryptMessageResult,
  WorkerDecryptToDeviceResult,
  DecryptGroupMessageResult,
  MemberDeviceRef,
  ClaimedOtkRef,
  TrustRecordStatus,
  BackupSessionItem,
  BackupStatus,
  BackupImportResult,
} from './protocol';
import type { BackupAuthData } from './key-backup';
import type { E2eeDeviceTrustRecord } from './storage';

export class E2eeClient {
  private worker: Worker | null = null;
  private pendingRequests = new Map<
    string,
    { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }
  >();
  private engineFallback: any = null;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
          type: 'module',
        });

        this.worker.onmessage = (event: MessageEvent<WorkerRpcResponse>) => {
          const res = event.data;
          if (!res || !res.id) return;

          const pending = this.pendingRequests.get(res.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(res.id);

            if (res.ok) {
              pending.resolve(res.result);
            } else {
              pending.reject(new Error(res.error || 'Unknown Worker RPC error'));
            }
          }
        };

        this.worker.onerror = (err) => {
          console.error('[E2eeClient] Web Worker fatal error:', err);
        };
      } catch (e) {
        console.warn(
          '[E2eeClient] Web Worker initialization failed, falling back to direct engine:',
          e,
        );
      }
    }
  }

  private async callRpc<T>(
    type: WorkerRpcRequest['type'],
    payload: any,
    timeoutMs = 15000,
  ): Promise<T> {
    const id = crypto.randomUUID();

    if (this.worker) {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Worker RPC timeout for ${type} after ${timeoutMs}ms`));
        }, timeoutMs);

        this.pendingRequests.set(id, { resolve, reject, timer });
        this.worker!.postMessage({ id, type, payload } as WorkerRpcRequest);
      });
    }

    // Direct fallback (Node environment / testing)
    if (!this.engineFallback) {
      const { E2eeWorkerEngine } = await import('./engine');
      this.engineFallback = new E2eeWorkerEngine();
    }

    switch (type) {
      case 'INIT_SESSION':
        return this.engineFallback.initSession(payload.userId, payload.wasmUrl);
      case 'GENERATE_ONE_TIME_KEYS':
        return this.engineFallback.generateOneTimeKeys(payload.count);
      case 'MARK_KEYS_PUBLISHED':
        return this.engineFallback.markKeysPublished();
      case 'PREPARE_OUTBOUND_MEGOLM':
        return this.engineFallback.prepareOutboundMegolm(payload);
      case 'ENCRYPT_MESSAGE':
        return this.engineFallback.encryptMessage(payload.conversationId, payload.plaintext);
      case 'DECRYPT_TO_DEVICE_BATCH':
        return this.engineFallback.decryptToDeviceBatch(payload.messages);
      case 'DECRYPT_GROUP_MESSAGE':
        return this.engineFallback.decryptGroupMessage(
          payload.conversationId,
          payload.megolmSessionId,
          payload.ciphertext,
        );
      case 'CHECK_OR_RECORD_DEVICE_TRUST':
        return this.engineFallback.checkOrRecordDeviceTrust(payload);
      case 'WIPE_DATABASE':
        return this.engineFallback.wipeDatabase();
      case 'BACKUP_CREATE':
        return this.engineFallback.backupCreate(payload.passphrase);
      case 'BACKUP_UNLOCK':
        return this.engineFallback.backupUnlock(payload.authData, payload.passphrase);
      case 'BACKUP_ACTIVATE':
        return this.engineFallback.backupActivate(payload.version);
      case 'BACKUP_STATUS':
        return this.engineFallback.backupStatus();
      case 'BACKUP_FORGET':
        return this.engineFallback.backupForget();
      case 'BACKUP_EXPORT_PENDING':
        return this.engineFallback.backupExportPending(payload.limit);
      case 'BACKUP_MARK_UPLOADED':
        return this.engineFallback.backupMarkUploaded(payload.keys, payload.version);
      case 'BACKUP_IMPORT':
        return this.engineFallback.backupImport(payload.sessions);
      default:
        throw new Error(`Unsupported RPC call: ${type}`);
    }
  }

  async initSession(userId: string): Promise<WorkerInitResult> {
    return this.callRpc<WorkerInitResult>('INIT_SESSION', { userId });
  }

  async generateOneTimeKeys(
    count: number,
  ): Promise<Array<{ key_id: string; public_key: string; signature: string }>> {
    return this.callRpc('GENERATE_ONE_TIME_KEYS', { count });
  }

  async markKeysPublished(): Promise<void> {
    return this.callRpc('MARK_KEYS_PUBLISHED', {});
  }

  async prepareOutboundMegolm(params: {
    conversationId: string;
    memberDevices: MemberDeviceRef[];
    claimedKeys: Record<string, ClaimedOtkRef>;
    forceRotate?: boolean;
    devicesChanged?: boolean;
    membershipChanged?: boolean;
  }): Promise<WorkerPrepareMegolmResult> {
    return this.callRpc('PREPARE_OUTBOUND_MEGOLM', params);
  }

  async encryptMessage(
    conversationId: string,
    plaintext: string,
  ): Promise<WorkerEncryptMessageResult> {
    return this.callRpc('ENCRYPT_MESSAGE', { conversationId, plaintext });
  }

  async decryptToDeviceBatch(
    messages: Array<{
      id: string;
      senderId: string;
      senderDeviceId: string;
      ciphertext: string;
      senderCurve25519?: string;
    }>,
  ): Promise<WorkerDecryptToDeviceResult> {
    return this.callRpc('DECRYPT_TO_DEVICE_BATCH', { messages });
  }

  async decryptGroupMessage(
    conversationId: string,
    megolmSessionId: string,
    ciphertext: string,
  ): Promise<DecryptGroupMessageResult> {
    return this.callRpc('DECRYPT_GROUP_MESSAGE', {
      conversationId,
      megolmSessionId,
      ciphertext,
    });
  }

  async checkOrRecordDeviceTrust(params: {
    deviceId: string;
    userId: string;
    curve25519: string;
    ed25519: string;
  }): Promise<{ status: TrustRecordStatus; record: E2eeDeviceTrustRecord }> {
    return this.callRpc('CHECK_OR_RECORD_DEVICE_TRUST', params);
  }

  // SOC-3b key backup. Argon2id (64 MiB) can take a few seconds on slow phones: generous timeouts.
  async backupCreate(passphrase: string): Promise<{ authData: BackupAuthData }> {
    return this.callRpc('BACKUP_CREATE', { passphrase }, 120_000);
  }

  async backupUnlock(authData: unknown, passphrase: string): Promise<void> {
    return this.callRpc('BACKUP_UNLOCK', { authData, passphrase }, 120_000);
  }

  async backupActivate(version: number): Promise<void> {
    return this.callRpc('BACKUP_ACTIVATE', { version });
  }

  async backupStatus(): Promise<BackupStatus> {
    return this.callRpc('BACKUP_STATUS', {});
  }

  async backupForget(): Promise<void> {
    return this.callRpc('BACKUP_FORGET', {});
  }

  async backupExportPending(limit: number): Promise<Array<BackupSessionItem & { key: string }>> {
    return this.callRpc('BACKUP_EXPORT_PENDING', { limit }, 60_000);
  }

  async backupMarkUploaded(keys: string[], version: number): Promise<void> {
    return this.callRpc('BACKUP_MARK_UPLOADED', { keys, version });
  }

  async backupImport(sessions: BackupSessionItem[]): Promise<BackupImportResult> {
    return this.callRpc('BACKUP_IMPORT', { sessions }, 60_000);
  }

  async wipeDatabase(): Promise<void> {
    await this.callRpc('WIPE_DATABASE', {});
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.initWorker();
    }
  }
}

// Global singleton instance for the app
let clientInstance: E2eeClient | null = null;

export function getE2eeClient(): E2eeClient {
  if (!clientInstance) {
    clientInstance = new E2eeClient();
  }
  return clientInstance;
}
