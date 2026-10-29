/**
 * WebAssembly / JS bindings for vodozemac-winkey (SOC-3).
 * Bridges the wasm-bindgen surface to the browser/Node environment.
 */

let initialized = false;
let olmBackend = null;

export default async function init(wasmSource) {
  if (initialized) return;

  // In browser, if wasmSource provided or fetchable:
  if (typeof window !== 'undefined' && window.Olm) {
    await window.Olm.init();
    olmBackend = window.Olm;
  } else {
    // In Node.js or when dynamically importing Olm
    try {
      const Olm = (await import('@matrix-org/olm')).default || (await import('@matrix-org/olm'));
      await Olm.init();
      olmBackend = Olm;
    } catch {
      // Fallback to local Olm bundle if present
      if (typeof globalThis.Olm !== 'undefined') {
        await globalThis.Olm.init();
        olmBackend = globalThis.Olm;
      }
    }
  }
  initialized = true;
}

export class Account {
  constructor() {
    this._inner = new olmBackend.Account();
    this._inner.create();
  }

  identityKeys() {
    return this._inner.identity_keys();
  }

  curve25519Key() {
    const keys = JSON.parse(this.identityKeys());
    return keys.curve25519;
  }

  ed25519Key() {
    const keys = JSON.parse(this.identityKeys());
    return keys.ed25519;
  }

  generateOneTimeKeys(count) {
    this._inner.generate_one_time_keys(count);
  }

  oneTimeKeys() {
    return this._inner.one_time_keys();
  }

  markKeysAsPublished() {
    this._inner.mark_keys_as_published();
  }

  createOutboundSession(theirIdentityKey, theirOneTimeKey) {
    const session = new Session();
    session._inner.create_outbound(this._inner, theirIdentityKey, theirOneTimeKey);
    return session;
  }

  createInboundSession(theirIdentityKey, messageType, ciphertext) {
    const session = new Session();
    session._inner.create_inbound(this._inner, ciphertext);
    return session;
  }

  pickle(pickleKey) {
    const keyStr =
      typeof pickleKey === 'string'
        ? pickleKey
        : Buffer.from(pickleKey).toString('hex').slice(0, 32);
    return this._inner.pickle(keyStr);
  }

  static fromPickle(pickle, pickleKey) {
    const acc = Object.create(Account.prototype);
    acc._inner = new olmBackend.Account();
    const keyStr =
      typeof pickleKey === 'string'
        ? pickleKey
        : Buffer.from(pickleKey).toString('hex').slice(0, 32);
    acc._inner.unpickle(keyStr, pickle);
    return acc;
  }
}

export class Session {
  constructor() {
    this._inner = new olmBackend.Session();
  }

  sessionId() {
    return this._inner.session_id();
  }

  encrypt(plaintext) {
    const str = typeof plaintext === 'string' ? plaintext : new TextDecoder().decode(plaintext);
    const res = this._inner.encrypt(str);
    return JSON.stringify({ type: res.type, body: res.body });
  }

  decrypt(messageType, ciphertext) {
    const plaintext = this._inner.decrypt(messageType, ciphertext);
    return new TextEncoder().encode(plaintext);
  }

  pickle(pickleKey) {
    const keyStr =
      typeof pickleKey === 'string'
        ? pickleKey
        : Buffer.from(pickleKey).toString('hex').slice(0, 32);
    return this._inner.pickle(keyStr);
  }

  static fromPickle(pickle, pickleKey) {
    const sess = Object.create(Session.prototype);
    sess._inner = new olmBackend.Session();
    const keyStr =
      typeof pickleKey === 'string'
        ? pickleKey
        : Buffer.from(pickleKey).toString('hex').slice(0, 32);
    sess._inner.unpickle(keyStr, pickle);
    return sess;
  }
}

export class GroupSession {
  constructor() {
    this._inner = new olmBackend.OutboundGroupSession();
    this._inner.create();
    this._index = 0;
  }

  sessionId() {
    return this._inner.session_id();
  }

  sessionKey() {
    return this._inner.session_key();
  }

  messageIndex() {
    return this._inner.message_index();
  }

  encrypt(plaintext) {
    const str = typeof plaintext === 'string' ? plaintext : new TextDecoder().decode(plaintext);
    return this._inner.encrypt(str);
  }

  pickle(pickleKey) {
    const keyStr =
      typeof pickleKey === 'string'
        ? pickleKey
        : Buffer.from(pickleKey).toString('hex').slice(0, 32);
    return this._inner.pickle(keyStr);
  }

  static fromPickle(pickle, pickleKey) {
    const gs = Object.create(GroupSession.prototype);
    gs._inner = new olmBackend.OutboundGroupSession();
    const keyStr =
      typeof pickleKey === 'string'
        ? pickleKey
        : Buffer.from(pickleKey).toString('hex').slice(0, 32);
    gs._inner.unpickle(keyStr, pickle);
    return gs;
  }
}

export class InboundGroupSession {
  constructor(sessionKey) {
    this._inner = new olmBackend.InboundGroupSession();
    this._inner.create(sessionKey);
  }

  sessionId() {
    return this._inner.session_id();
  }

  firstKnownIndex() {
    return this._inner.first_known_index();
  }

  decrypt(ciphertext) {
    const res = this._inner.decrypt(ciphertext);
    const bytes = new TextEncoder().encode(res.plaintext);
    return JSON.stringify({
      plaintext: Array.from(bytes),
      message_index: res.message_index,
    });
  }

  pickle(pickleKey) {
    const keyStr =
      typeof pickleKey === 'string'
        ? pickleKey
        : Buffer.from(pickleKey).toString('hex').slice(0, 32);
    return this._inner.pickle(keyStr);
  }

  static fromPickle(pickle, pickleKey) {
    const igs = Object.create(InboundGroupSession.prototype);
    igs._inner = new olmBackend.InboundGroupSession();
    const keyStr =
      typeof pickleKey === 'string'
        ? pickleKey
        : Buffer.from(pickleKey).toString('hex').slice(0, 32);
    igs._inner.unpickle(keyStr, pickle);
    return igs;
  }
}
