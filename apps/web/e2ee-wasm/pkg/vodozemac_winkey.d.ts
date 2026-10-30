/* tslint:disable */
/* eslint-disable */

export class Account {
    free(): void;
    [Symbol.dispose](): void;
    createInboundSession(their_identity_key: string, message_type: number, ciphertext: string): Session;
    createOutboundSession(their_identity_key: string, their_one_time_key: string): Session;
    curve25519Key(): string;
    ed25519Key(): string;
    fallbackKey(): string;
    static fromPickle(pickle: string, pickle_key: Uint8Array): Account;
    generateFallbackKey(): void;
    generateOneTimeKeys(count: number): void;
    identityKeys(): string;
    markKeysAsPublished(): void;
    constructor();
    oneTimeKeys(): string;
    pickle(pickle_key: Uint8Array): string;
    sign(message: string): string;
}

export class GroupSession {
    free(): void;
    [Symbol.dispose](): void;
    encrypt(plaintext: string): string;
    static fromPickle(pickle: string, pickle_key: Uint8Array): GroupSession;
    messageIndex(): number;
    constructor();
    pickle(pickle_key: Uint8Array): string;
    sessionId(): string;
    sessionKey(): string;
}

export class InboundGroupSession {
    free(): void;
    [Symbol.dispose](): void;
    decrypt(ciphertext: string): string;
    firstKnownIndex(): number;
    static fromPickle(pickle: string, pickle_key: Uint8Array): InboundGroupSession;
    constructor(session_key: string);
    pickle(pickle_key: Uint8Array): string;
    sessionId(): string;
}

export class Session {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(message_type: number, ciphertext: string): Uint8Array;
    encrypt(plaintext: string): string;
    static fromPickle(pickle: string, pickle_key: Uint8Array): Session;
    pickle(pickle_key: Uint8Array): string;
    sessionId(): string;
}

/**
 * Initializer for WASM environment (panic hook and logging)
 */
export function init_panic_hook(): void;

export function verifyEd25519Signature(public_key: string, message: string, signature: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_account_free: (a: number, b: number) => void;
    readonly __wbg_groupsession_free: (a: number, b: number) => void;
    readonly __wbg_inboundgroupsession_free: (a: number, b: number) => void;
    readonly __wbg_session_free: (a: number, b: number) => void;
    readonly account_createInboundSession: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly account_createOutboundSession: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly account_curve25519Key: (a: number, b: number) => void;
    readonly account_ed25519Key: (a: number, b: number) => void;
    readonly account_fallbackKey: (a: number, b: number) => void;
    readonly account_fromPickle: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly account_generateFallbackKey: (a: number) => void;
    readonly account_generateOneTimeKeys: (a: number, b: number) => void;
    readonly account_identityKeys: (a: number, b: number) => void;
    readonly account_markKeysAsPublished: (a: number) => void;
    readonly account_new: () => number;
    readonly account_oneTimeKeys: (a: number, b: number) => void;
    readonly account_pickle: (a: number, b: number, c: number, d: number) => void;
    readonly account_sign: (a: number, b: number, c: number, d: number) => void;
    readonly groupsession_encrypt: (a: number, b: number, c: number, d: number) => void;
    readonly groupsession_fromPickle: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly groupsession_messageIndex: (a: number) => number;
    readonly groupsession_new: () => number;
    readonly groupsession_pickle: (a: number, b: number, c: number, d: number) => void;
    readonly groupsession_sessionId: (a: number, b: number) => void;
    readonly groupsession_sessionKey: (a: number, b: number) => void;
    readonly inboundgroupsession_decrypt: (a: number, b: number, c: number, d: number) => void;
    readonly inboundgroupsession_firstKnownIndex: (a: number) => number;
    readonly inboundgroupsession_fromPickle: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly inboundgroupsession_new: (a: number, b: number, c: number) => void;
    readonly inboundgroupsession_pickle: (a: number, b: number, c: number, d: number) => void;
    readonly inboundgroupsession_sessionId: (a: number, b: number) => void;
    readonly init_panic_hook: () => void;
    readonly session_decrypt: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly session_encrypt: (a: number, b: number, c: number, d: number) => void;
    readonly session_fromPickle: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly session_pickle: (a: number, b: number, c: number, d: number) => void;
    readonly session_sessionId: (a: number, b: number) => void;
    readonly verifyEd25519Signature: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
