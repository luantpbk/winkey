'use client';

import { useEffect, useState, type ReactNode } from 'react';

export function MswProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(process.env.NEXT_PUBLIC_API_MOCKS !== '1');

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_API_MOCKS === '1') {
      import('./browser').then(async ({ worker }) => {
        await worker.start({
          onUnhandledRequest: 'bypass',
        });
        setReady(true);
      });
    }
  }, []);

  if (!ready) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#0f0f0f] text-white font-medium text-sm">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
          <span>Khởi tạo môi trường Winkey...</span>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
