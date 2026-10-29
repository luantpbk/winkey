/**
 * TypeScript definitions for vodozemac-winkey WASM bindings (SOC-3).
 */

export class Account {
  constructor();
  identityKeys(): string;
  curve25519Key(): string;
  ed25519Key(): string;
  generateOneTimeKeys(count: number): void;
  oneTimeKeys(): string;
  markKeysAsPublished(): void;
  createOutboundSession(theirIdentityKey: string, theirOneTimeKey: string): Session;
  createInboundSession(theirIdentityKey: string, messageType: number, ciphertext: string): Session;
  pickle(pickleKey: Uint8Array): string;
  static fromPickle(pickle: string, pickleKey: Uint8Array): Account;
}

export class Session {
  sessionId(): string;
  encrypt(plaintext: Uint8Array): string;
  decrypt(messageType: number, ciphertext: string): Uint8Array;
  pickle(pickleKey: Uint8Array): string;
  static fromPickle(pickle: string, pickleKey: Uint8Array): Session;
}

export class GroupSession {
  constructor();
  sessionId(): string;
  sessionKey(): string;
  messageIndex(): number;
  encrypt(plaintext: Uint8Array): string;
  pickle(pickleKey: Uint8Array): string;
  static fromPickle(pickle: string, pickleKey: Uint8Array): GroupSession;
}

export class InboundGroupSession {
  constructor(sessionKey: string);
  sessionId(): string;
  firstKnownIndex(): number;
  decrypt(ciphertext: string): string;
  pickle(pickleKey: Uint8Array): string;
  static fromPickle(pickle: string, pickleKey: Uint8Array): InboundGroupSession;
}

export default function init(
  input?: RequestInfo | BufferSource | WebAssembly.Module,
): Promise<void>;
