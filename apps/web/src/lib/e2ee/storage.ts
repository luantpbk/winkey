/**
 * IndexedDB persistence for Winkey E2EE (`winkey-e2ee`)
 * (ADR-049 §5 / SOC-3a)
 *
 * Stores:
 * - meta: Non-extractable WebCrypto key, wrapped pickle key, device_id, user_id
 * - account: Vodozemac Account encrypted pickle
 * - olm_sessions: 1-to-1 Olm sessions per peer curve25519 public key
 * - outbound_group_sessions: Sender Megolm sessions per conversation
 * - inbound_group_sessions: Receiver Megolm sessions per (conversation_id, session_id)
 * - device_trust: TOFU device identity keys and verification state
 */

export const DB_NAME = 'winkey-e2ee';
export const DB_VERSION = 1;

export interface E2eeMetaRecord {
  key: string;
  value: any;
}

export interface E2eeAccountRecord {
  id: 'current';
  pickle: string;
  updated_at: string;
}

export interface E2eeOlmSessionRecord {
  peer_curve25519: string;
  peer_device_id: string;
  pickle: string;
  updated_at: string;
}

export interface E2eeOutboundGroupSessionRecord {
  conversation_id: string;
  session_id: string;
  message_index: number;
  created_at: number;
  pickle: string;
  device_ids?: string[];
}

export interface E2eeInboundGroupSessionRecord {
  key: string; // `${conversation_id}:${session_id}`
  conversation_id: string;
  session_id: string;
  sender_key: string;
  pickle: string;
  created_at: number;
  /** SOC-3b: the key-backup version this session was last uploaded to (absent: not backed up). */
  backed_up_version?: number;
}

export interface E2eeDeviceTrustRecord {
  device_id: string;
  user_id: string;
  curve25519_key: string;
  ed25519_key: string;
  first_seen_at: string;
  verified: boolean;
}

export class E2eeStorage {
  private db: IDBDatabase | null = null;

  async open(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is not supported in this environment');
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('account')) {
          db.createObjectStore('account', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('olm_sessions')) {
          db.createObjectStore('olm_sessions', { keyPath: 'peer_curve25519' });
        }
        if (!db.objectStoreNames.contains('outbound_group_sessions')) {
          db.createObjectStore('outbound_group_sessions', { keyPath: 'conversation_id' });
        }
        if (!db.objectStoreNames.contains('inbound_group_sessions')) {
          db.createObjectStore('inbound_group_sessions', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('device_trust')) {
          db.createObjectStore('device_trust', { keyPath: 'device_id' });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this.db);
      };

      request.onerror = () => {
        reject(request.error || new Error('Failed to open IndexedDB winkey-e2ee'));
      };
    });
  }

  async get<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);

      req.onsuccess = () => {
        resolve(req.result ?? null);
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  }

  async getAll<T>(storeName: string): Promise<T[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();

      req.onsuccess = () => {
        resolve(req.result || []);
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  }

  async put(storeName: string, value: any): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(value);

      req.onsuccess = () => {
        resolve();
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  }

  async delete(storeName: string, key: IDBValidKey): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);

      req.onsuccess = () => {
        resolve();
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  }

  async clearStore(storeName: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();

      req.onsuccess = () => {
        resolve();
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  static async wipeDatabase(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        console.warn('[E2eeStorage] deleteDatabase blocked, will resolve on completion');
      };
    });
  }
}
