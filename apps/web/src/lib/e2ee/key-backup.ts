/**
 * SOC-3b passphrase key backup: crypto only, no network (ADR-049 addendum 2026-10-31, chat.v1 `key-backup`).
 *
 * - A random 32-byte backup key encrypts every backed-up Megolm inbound session (AES-256-GCM).
 * - The backup key is wrapped with a key derived from the user's recovery passphrase with Argon2id
 *   (m = 64 MiB, t = 3, p = 1, 16-byte salt; libsodium `crypto_pwhash`, ALG_ARGON2ID13).
 * - chat-svc stores `auth_data` (salt, parameters, wrapped key, key_check) and the sealed sessions; it can read
 *   neither. A stolen server copy still needs an offline Argon2id search per passphrase guess.
 *
 * All binary values in `auth_data` are unpadded base64 (contract `KeyBackupAuthData`). Nothing here is logged.
 */

export const BACKUP_ALGORITHM = 'winkey.backup.v1';
export const ARGON2_M_KIB = 65536;
export const ARGON2_T = 3;
export const ARGON2_P = 1;
const SALT_BYTES = 16;
const KEY_CHECK_INFO = 'winkey.backup.v1 key check';

export interface BackupAuthData {
  kdf: 'argon2id';
  salt: string;
  m_kib: number;
  t: number;
  p: number;
  wrapped_key: string;
  iv: string;
  key_check: string;
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code: 'WRONG_PASSPHRASE' | 'CORRUPT' | 'UNSUPPORTED' | 'LOCKED',
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

// --- encoding -----------------------------------------------------------------------------------------------------

export function toB64u(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/=+$/, '');
}

export function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- Argon2id -----------------------------------------------------------------------------------------------------

export type Argon2id = (
  passphrase: string,
  salt: Uint8Array,
  params: { mKib: number; t: number; p: number },
) => Promise<Uint8Array>;

/** libsodium (audited), loaded on first use only: the backup screens are the only callers. */
export const libsodiumArgon2id: Argon2id = async (passphrase, salt, { mKib, t, p }) => {
  if (p !== 1) throw new BackupError('Tham số sao lưu không được hỗ trợ.', 'UNSUPPORTED');
  const sodium = (await import('libsodium-wrappers-sumo')).default;
  await sodium.ready;
  return sodium.crypto_pwhash(
    32,
    passphrase.normalize('NFKC'),
    salt,
    t,
    mKib * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
};

async function aesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, usages);
}

async function keyCheck(derived: Uint8Array): Promise<string> {
  const hmac = await crypto.subtle.importKey(
    'raw',
    derived as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toB64u(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(KEY_CHECK_INFO)),
    ),
  );
}

/** Wraps `backupKey` (a fresh one by default) under the passphrase. */
export async function createAuthData(
  passphrase: string,
  argon2id: Argon2id = libsodiumArgon2id,
  backupKey: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): Promise<{ authData: BackupAuthData; backupKey: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await argon2id(passphrase, salt, {
    mKib: ARGON2_M_KIB,
    t: ARGON2_T,
    p: ARGON2_P,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await aesKey(derived, ['encrypt']),
      backupKey as Uint8Array<ArrayBuffer>,
    ),
  );
  return {
    backupKey,
    authData: {
      kdf: 'argon2id',
      salt: toB64u(salt),
      m_kib: ARGON2_M_KIB,
      t: ARGON2_T,
      p: ARGON2_P,
      wrapped_key: toB64u(wrapped),
      iv: toB64u(iv),
      key_check: await keyCheck(derived),
    },
  };
}

/**
 * Unwraps the backup key. `key_check` tells a wrong passphrase (WRONG_PASSPHRASE) from damaged data (CORRUPT).
 * Parameters weaker than ours are refused, so a server cannot downgrade a backup to a cheap KDF.
 */
export async function unlockAuthData(
  authData: unknown,
  passphrase: string,
  argon2id: Argon2id = libsodiumArgon2id,
): Promise<Uint8Array> {
  const a = authData as Partial<BackupAuthData> | null;
  if (
    !a ||
    a.kdf !== 'argon2id' ||
    typeof a.salt !== 'string' ||
    typeof a.wrapped_key !== 'string' ||
    typeof a.iv !== 'string' ||
    typeof a.key_check !== 'string' ||
    typeof a.m_kib !== 'number' ||
    typeof a.t !== 'number' ||
    a.p !== ARGON2_P
  ) {
    throw new BackupError('Bản sao lưu bị hỏng hoặc không được hỗ trợ.', 'CORRUPT');
  }
  if (a.m_kib < ARGON2_M_KIB || a.t < ARGON2_T || a.m_kib > 1_048_576 || a.t > 20) {
    throw new BackupError('Tham số sao lưu không được hỗ trợ.', 'UNSUPPORTED');
  }
  const derived = await argon2id(passphrase, fromB64u(a.salt), { mKib: a.m_kib, t: a.t, p: a.p });
  if ((await keyCheck(derived)) !== a.key_check) {
    throw new BackupError('Cụm mật khẩu khôi phục không đúng.', 'WRONG_PASSPHRASE');
  }
  try {
    const key = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64u(a.iv) },
        await aesKey(derived, ['decrypt']),
        fromB64u(a.wrapped_key),
      ),
    );
    if (key.length !== 32) throw new Error('length');
    return key;
  } catch {
    throw new BackupError('Bản sao lưu bị hỏng.', 'CORRUPT');
  }
}

// --- sealed sessions ----------------------------------------------------------------------------------------------

/** What one backed-up session holds before sealing (see engine: a vodozemac pickle under a fixed export key). */
export interface BackedUpSessionPayload {
  v: 1;
  pickle: string;
  sender_key: string;
}

/** AES-256-GCM under the backup key; output base64 of iv ‖ ciphertext (contract: ≤ 8 KiB decoded). */
export async function sealSession(
  backupKey: Uint8Array,
  payload: BackedUpSessionPayload,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await aesKey(backupKey, ['encrypt']),
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64u(out);
}

export async function openSession(
  backupKey: Uint8Array,
  sealed: string,
): Promise<BackedUpSessionPayload> {
  const bytes = fromB64u(sealed);
  let parsed: unknown;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
      await aesKey(backupKey, ['decrypt']),
      bytes.subarray(12),
    );
    parsed = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new BackupError('Không giải mã được một khoá đã sao lưu.', 'CORRUPT');
  }
  const p = parsed as Partial<BackedUpSessionPayload>;
  if (p?.v !== 1 || typeof p.pickle !== 'string' || typeof p.sender_key !== 'string') {
    throw new BackupError('Khoá đã sao lưu không hợp lệ.', 'CORRUPT');
  }
  return { v: 1, pickle: p.pickle, sender_key: p.sender_key };
}

// --- passphrases --------------------------------------------------------------------------------------------------

/** Uniform index in [0, n) from crypto randomness (rejection sampling, no modulo bias). */
function randomIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

/** Five words from the EFF short wordlist (1 296 words): about 51.7 bits, against an Argon2id at 64 MiB. */
export function generatePassphrase(wordlist: readonly string[], words = 5): string {
  return Array.from({ length: words }, () => wordlist[randomIndex(wordlist.length)]).join(' ');
}

export const MIN_OWN_PASSPHRASE_LENGTH = 12;
export const MIN_ZXCVBN_SCORE = 3;

/** A user-chosen passphrase: at least 12 characters and a zxcvbn score of at least 3 (loaded on demand). */
export async function checkOwnPassphrase(
  passphrase: string,
): Promise<{ ok: boolean; score: number; message?: string }> {
  if ([...passphrase].length < MIN_OWN_PASSPHRASE_LENGTH) {
    return { ok: false, score: 0, message: `Cần ít nhất ${MIN_OWN_PASSPHRASE_LENGTH} ký tự.` };
  }
  const [{ ZxcvbnFactory }, common] = await Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
  ]);
  const { score } = new ZxcvbnFactory({
    dictionary: common.dictionary,
    graphs: common.adjacencyGraphs,
  }).check(passphrase);
  return score >= MIN_ZXCVBN_SCORE
    ? { ok: true, score }
    : {
        ok: false,
        score,
        message: 'Cụm mật khẩu còn dễ đoán. Hãy dài hơn hoặc dùng cụm từ được tạo sẵn.',
      };
}
