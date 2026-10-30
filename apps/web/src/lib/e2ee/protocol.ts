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
  | { id: string; type: 'WIPE_DATABASE'; payload: Record<string, never> };

export interface WorkerRpcResponse {
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
}
