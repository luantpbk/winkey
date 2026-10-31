/**
 * Typed Web Worker RPC Protocol for Winkey E2EE (ADR-049 §5 / SOC-3a)
 */

export interface MemberDeviceRef {
  userId: string;
  deviceId: string;
  curve25519: string;
  ed25519: string;
}

export interface ClaimedOtkRef {
  keyId: string;
  publicKey: string;
}

export interface WorkerInitResult {
  isNewDevice: boolean;
  deviceId: string;
  curve25519Key: string;
  ed25519Key: string;
  signature: string;
  oneTimeKeys: Array<{
    key_id: string;
    public_key: string;
    signature: string;
  }>;
  fallbackKey: {
    key_id: string;
    public_key: string;
    signature: string;
  } | null;
}

export interface WorkerPrepareMegolmResult {
  sessionId: string;
  toDeviceMessages: Array<{
    deviceId: string;
    ciphertext: string;
  }>;
}

export interface WorkerEncryptMessageResult {
  megolmSessionId: string;
  ciphertext: string;
  messageIndex: number;
}

export interface WorkerDecryptToDeviceResult {
  processedIds: string[];
  newMegolmSessionIds: string[];
  /** SOC-4a: decrypted to-device events that are not Megolm key shares (call signaling); validated by the caller. */
  events?: Array<{ senderId: string; senderDeviceId: string; event: unknown }>;
}

export interface WorkerEncryptToDeviceResult {
  messages: Array<{ deviceId: string; ciphertext: string }>;
  /** Devices without an Olm session and without a claimed key: claim one, then call again for them. */
  needKeys: string[];
}

export type DecryptGroupMessageResult =
  | { status: 'DECRYPTED'; plaintext: string; messageIndex: number }
  | { status: 'WAITING_FOR_KEY' }
  | { status: 'ERROR'; error: string };

export type TrustRecordStatus = 'TRUSTED' | 'NEW_DEVICE' | 'KEY_CHANGED';

export type WorkerRpcRequest =
  | { id: string; type: 'INIT_SESSION'; payload: { userId: string; wasmUrl?: string } }
  | { id: string; type: 'GENERATE_ONE_TIME_KEYS'; payload: { count: number } }
  | { id: string; type: 'MARK_KEYS_PUBLISHED'; payload: Record<string, never> }
  | {
      id: string;
      type: 'PREPARE_OUTBOUND_MEGOLM';
      payload: {
        conversationId: string;
        memberDevices: MemberDeviceRef[];
        claimedKeys: Record<string, ClaimedOtkRef>;
        forceRotate?: boolean;
      };
    }
  | { id: string; type: 'ENCRYPT_MESSAGE'; payload: { conversationId: string; plaintext: string } }
  | {
      id: string;
      type: 'DECRYPT_TO_DEVICE_BATCH';
      payload: {
        messages: Array<{
          id: string;
          senderId: string;
          senderDeviceId: string;
          ciphertext: string;
        }>;
      };
    }
  | {
      id: string;
      type: 'DECRYPT_GROUP_MESSAGE';
      payload: {
        conversationId: string;
        megolmSessionId: string;
        ciphertext: string;
      };
    }
  | {
      id: string;
      type: 'CHECK_OR_RECORD_DEVICE_TRUST';
      payload: {
        deviceId: string;
        userId: string;
        curve25519: string;
        ed25519: string;
      };
    }
  | { id: string; type: 'WIPE_DATABASE'; payload: Record<string, never> }
  | {
      id: string;
      type: 'ENCRYPT_TO_DEVICE';
      payload: {
        targets: MemberDeviceRef[];
        claimedKeys: Record<string, ClaimedOtkRef>;
        event: unknown;
      };
    }
  // SOC-3b key backup: the passphrase and the backup key never leave the worker.
  | { id: string; type: 'BACKUP_CREATE'; payload: { passphrase: string } }
  | { id: string; type: 'BACKUP_UNLOCK'; payload: { authData: unknown; passphrase: string } }
  | { id: string; type: 'BACKUP_ACTIVATE'; payload: { version: number } }
  | { id: string; type: 'BACKUP_STATUS'; payload: Record<string, never> }
  | { id: string; type: 'BACKUP_FORGET'; payload: Record<string, never> }
  | { id: string; type: 'BACKUP_EXPORT_PENDING'; payload: { limit: number } }
  | { id: string; type: 'BACKUP_MARK_UPLOADED'; payload: { keys: string[]; version: number } }
  | { id: string; type: 'BACKUP_IMPORT'; payload: { sessions: BackupSessionItem[] } };

/** One backed-up session as chat-svc stores it (`BackedUpSession`). */
export interface BackupSessionItem {
  conversation_id: string;
  session_id: string;
  first_message_index: number;
  ciphertext: string;
}

export interface BackupStatus {
  /** The backup key is unlocked on this device (wrapped by the non-extractable storage key). */
  unlocked: boolean;
  /** The backup version this device uploads to, once known. */
  version: number | null;
  /** Inbound sessions on this device, and how many are already in the backup version above. */
  sessionCount: number;
  backedUpCount: number;
}

export interface BackupImportResult {
  imported: number;
  kept: number;
  failed: number;
}

export interface WorkerRpcResponse {
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
}
