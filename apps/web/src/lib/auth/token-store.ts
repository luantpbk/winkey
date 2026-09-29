/**
 * In-memory token storage.
 * Per Winkey security architecture: access tokens must NEVER be stored
 * in localStorage or sessionStorage (XSS protection).
 */
let inMemoryAccessToken: string | null = null;
const listeners = new Set<(token: string | null) => void>();

export const tokenStore = {
  get(): string | null {
    return inMemoryAccessToken;
  },
  set(token: string | null) {
    inMemoryAccessToken = token;
    for (const listener of listeners) {
      listener(token);
    }
  },
  clear() {
    this.set(null);
  },
  subscribe(listener: (token: string | null) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
