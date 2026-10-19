'use client';

import { useEffect, type ReactNode } from 'react';

export function MswProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_API_MOCKS === '1') {
      import('./browser').then(async ({ worker }) => {
        await worker.start({
          onUnhandledRequest: 'bypass',
        });
      });
    }
  }, []);

  return <>{children}</>;
}
