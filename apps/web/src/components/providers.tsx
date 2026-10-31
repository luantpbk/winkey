'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../lib/auth/auth-context';
import { MswProvider } from '../mocks/msw-provider';
import { ThemeProvider } from './theme-provider';
import { ToastProvider } from './ui/toast';
import { RealtimeProvider } from '../lib/realtime/realtime-context';
import { CallProvider } from './calls/call-provider';

const NonceContext = createContext<string | undefined>(undefined);

export function useNonce(): string | undefined {
  return useContext(NonceContext);
}

export function Providers({ children, nonce }: { children: ReactNode; nonce?: string }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1000 * 30, // 30 seconds
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <NonceContext.Provider value={nonce}>
      <MswProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <AuthProvider>
              <ToastProvider>
                <RealtimeProvider>
                  <CallProvider>{children}</CallProvider>
                </RealtimeProvider>
              </ToastProvider>
            </AuthProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </MswProvider>
    </NonceContext.Provider>
  );
}
