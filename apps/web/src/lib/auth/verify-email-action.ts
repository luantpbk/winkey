import { api } from '../api-client';
import type { Problem } from '@winkey/api-client';

// Global execution map across StrictMode remounts and concurrent renders
const verifyExecutionMap = new Map<string, Promise<{ status: number; problem?: Problem }>>();

export function resetVerifyExecutionMap() {
  verifyExecutionMap.clear();
}

export function executeVerifyOnce(token: string): Promise<{ status: number; problem?: Problem }> {
  let existing = verifyExecutionMap.get(token);
  if (!existing) {
    existing = (async () => {
      try {
        const res = await api.auth.POST('/v1/auth/email/verify', {
          body: { token },
        });
        return {
          status: res.response.status,
          problem: res.error as Problem | undefined,
        };
      } catch {
        return { status: 500 };
      }
    })();
    verifyExecutionMap.set(token, existing);
  }
  return existing;
}
