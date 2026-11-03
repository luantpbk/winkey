import { api } from '../api-client';
import { getE2eeClient, type E2eeClient } from './client';
import { BackupError, BACKUP_ALGORITHM } from './key-backup';
import type { BackupImportResult, BackupStatus } from './protocol';
import type { ChatComponents } from '@winkey/api-client';

type KeyBackup = ChatComponents['schemas']['KeyBackup'];

/** chat-svc accepts at most 100 sessions per `putKeyBackupSessions`. */
export const BACKUP_BATCH_SIZE = 100;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

export class BackupServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BackupServerError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SOC-3b key backup over the network. Every secret step (Argon2id, wrapping, sealing sessions) runs in the E2EE
 * worker; this class only moves opaque blobs between the worker and chat-svc.
 */
export class KeyBackupService {
  private uploadTimer: ReturnType<typeof setTimeout> | null = null;
  private uploading: Promise<number> | null = null;

  constructor(
    private readonly client: E2eeClient = getE2eeClient(),
    private readonly delay: (ms: number) => Promise<void> = sleep,
  ) {}

  /** The server's backup, or null when the user has none. */
  async getServerBackup(): Promise<KeyBackup | null> {
    const { data, response, error } = await api.chat.GET('/v1/chat/key-backup');
    if (data) return data;
    if (response.status === 404) return null;
    throw new BackupServerError(
      error?.detail || 'Không tải được bản sao lưu.',
      response.status,
      error?.code,
    );
  }

  status(): Promise<BackupStatus> {
    return this.client.backupStatus();
  }

  /** Turn on (no backup yet) or replace (new passphrase, or reset after forgetting it): then upload every session. */
  async enable(passphrase: string, options: { replace?: boolean } = {}): Promise<KeyBackup> {
    const { authData } = await this.client.backupCreate(passphrase);
    const { data, response, error } = await api.chat.PUT('/v1/chat/key-backup', {
      body: {
        algorithm: BACKUP_ALGORITHM,
        auth_data: { ...authData },
        replace: options.replace === true,
      },
    });
    if (!data) {
      await this.client.backupForget();
      throw new BackupServerError(
        error?.code === 'BACKUP_EXISTS'
          ? 'Tài khoản đã có bản sao lưu. Hãy mở khoá hoặc đặt lại.'
          : error?.detail || 'Không bật được sao lưu.',
        response.status,
        error?.code,
      );
    }
    await this.client.backupActivate(data.version);
    await this.uploadPending();
    return data;
  }

  /** On a device that does not hold the backup key yet: check the passphrase and keep the key. */
  async unlock(passphrase: string): Promise<KeyBackup> {
    const backup = await this.getServerBackup();
    if (!backup) throw new BackupServerError('Tài khoản chưa có bản sao lưu.', 404);
    await this.client.backupUnlock(backup.auth_data, passphrase);
    await this.client.backupActivate(backup.version);
    return backup;
  }

  /** Downloads every backed-up session (pages of 500) and imports them. Unlock first. */
  async restore(onProgress?: (done: number, total: number) => void): Promise<BackupImportResult> {
    const st = await this.client.backupStatus();
    if (!st.unlocked || st.version === null)
      throw new BackupError('Chưa mở khoá bản sao lưu.', 'LOCKED');
    const backup = await this.getServerBackup();
    const total = backup?.session_count ?? 0;
    const totals: BackupImportResult = { imported: 0, kept: 0, failed: 0 };
    let cursor: string | undefined;
    let seen = 0;
    do {
      const { data, response, error } = await api.chat.GET('/v1/chat/key-backup/sessions', {
        params: { query: { version: st.version, limit: 500, ...(cursor ? { cursor } : {}) } },
      });
      if (!data) {
        throw new BackupServerError(
          error?.detail || 'Không tải được khoá đã sao lưu.',
          response.status,
          error?.code,
        );
      }
      const r = await this.client.backupImport(data.items);
      totals.imported += r.imported;
      totals.kept += r.kept;
      totals.failed += r.failed;
      seen += data.items.length;
      onProgress?.(seen, total);
      cursor = data.next_cursor ?? undefined;
    } while (cursor);
    return totals;
  }

  /**
   * Uploads, in batches of 100, every local session the current backup version does not have yet. Each batch is
   * retried with backoff (1 s, 2 s, 4 s) on network errors, 429 and 5xx. Returns how many were uploaded.
   */
  async uploadPending(): Promise<number> {
    if (this.uploading) return this.uploading;
    this.uploading = (async () => {
      let uploaded = 0;
      const st = await this.client.backupStatus();
      if (!st.unlocked || st.version === null) return 0;
      for (;;) {
        const batch = await this.client.backupExportPending(BACKUP_BATCH_SIZE);
        if (batch.length === 0) return uploaded;
        const sessions = batch.map(({ key: _key, ...session }) => session);
        await this.putWithRetry(st.version, sessions);
        await this.client.backupMarkUploaded(
          batch.map((b) => b.key),
          st.version,
        );
        uploaded += batch.length;
        if (batch.length < BACKUP_BATCH_SIZE) return uploaded;
      }
    })().finally(() => {
      this.uploading = null;
    });
    return this.uploading;
  }

  /** Coalesces bursts of new sessions (to-device batches, rotations) into one upload a moment later. */
  scheduleUpload(delayMs = 2000): void {
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      this.uploadPending().catch(() => {
        // Retried on the next new session or the next app start; never surfaced as an error toast.
      });
    }, delayMs);
  }

  private async putWithRetry(
    version: number,
    sessions: Array<{
      conversation_id: string;
      session_id: string;
      first_message_index: number;
      ciphertext: string;
    }>,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let code: string | undefined;
      try {
        const { data, response, error } = await api.chat.PUT('/v1/chat/key-backup/sessions', {
          body: { version, sessions },
        });
        if (data) return;
        status = response.status;
        code = error?.code;
      } catch {
        status = 0; // network error
      }
      if (code === 'BACKUP_VERSION_MISMATCH' || status === 404) {
        // The backup was replaced or deleted from another device: this key is stale.
        await this.client.backupForget();
        throw new BackupServerError(
          'Bản sao lưu đã được thay đổi trên thiết bị khác.',
          status,
          code,
        );
      }
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
        throw new BackupServerError('Không tải được khoá lên bản sao lưu.', status, code);
      }
      await this.delay(RETRY_DELAYS_MS[attempt]!);
    }
  }

  /** Turn off: delete the server copy and forget the key on this device. */
  async disable(): Promise<void> {
    const { response } = await api.chat.DELETE('/v1/chat/key-backup');
    if (!response.ok && response.status !== 404) {
      throw new BackupServerError('Không tắt được sao lưu.', response.status);
    }
    await this.client.backupForget();
  }
}

let instance: KeyBackupService | null = null;

export function getKeyBackupService(): KeyBackupService {
  if (!instance) instance = new KeyBackupService();
  return instance;
}
