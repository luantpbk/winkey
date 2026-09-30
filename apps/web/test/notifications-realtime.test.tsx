import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Server } from 'mock-socket';
import { RealtimeClient } from '../src/lib/realtime/realtime-client';
import { RealtimeProvider } from '../src/lib/realtime/realtime-context';
import { ToastProvider } from '../src/components/ui/toast';
import { NotificationBell } from '../src/components/notifications/notification-bell';
import { api } from '../src/lib/api-client';

const WS_URL = 'ws://localhost:8080/v1/realtime';
const TEST_USER_ID = '0192f5e4-1000-7000-8000-000000000001';

// Mock routing
let currentPathname = '/vi';
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => currentPathname,
  Link: ({
    children,
    href,
    className,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}));

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const table: Record<string, string> = {
      bellAriaLabel: 'Thông báo',
      title: 'Thông báo',
      markAllRead: 'Đánh dấu đã đọc tất cả',
      viewAll: 'Xem tất cả',
      empty: 'Chưa có thông báo nào',
      loading: 'Đang tải...',
      error: 'Không thể tải thông báo',
      retry: 'Thử lại',
      unreadDot: 'chưa đọc',
    };
    return table[key] ?? key;
  },
}));

// Mock auth context
let mockIsAuthenticated = true;
let mockUser: { id: string; handle: string; display_name: string; roles: string[] } | null = {
  id: TEST_USER_ID,
  handle: 'testcreator',
  display_name: 'Test Creator',
  roles: ['user'],
};

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    user: mockUser,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

describe('N2-web: Realtime notification hints (ADR-023 addendum N2)', () => {
  let mockServer: Server;
  let serverSocket: any = null;
  let queryClient: QueryClient;
  let unreadCountCalls = 0;
  let listCalls = 0;
  let currentUnreadCount = 3;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    unreadCountCalls = 0;
    listCalls = 0;
    currentUnreadCount = 3;
    currentPathname = '/vi';
    mockIsAuthenticated = true;
    mockUser = {
      id: TEST_USER_ID,
      handle: 'testcreator',
      display_name: 'Test Creator',
      roles: ['user'],
    };

    serverSocket = null;
    mockServer = new Server(WS_URL);
    mockServer.on('connection', (socket) => {
      serverSocket = socket;
      // Send authenticated welcome frame matching contract
      socket.send(
        JSON.stringify({
          type: 'welcome',
          connection_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          user_id: mockUser ? mockUser.id : null,
          heartbeat_interval_ms: 25000,
        }),
      );
    });

    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });

    // Mock API client
    vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
      if (path === '/v1/notifications/unread-count') {
        unreadCountCalls += 1;
        return {
          data: { count: currentUnreadCount, capped: false },
          response: new Response(null, { status: 200 }),
        } as any;
      }
      if (path === '/v1/notifications') {
        listCalls += 1;
        return {
          data: {
            items: [
              {
                id: '0192f5e4-9000-7000-8000-000000000001',
                kind: 'VIDEO_COMMENT',
                user_id: TEST_USER_ID,
                actor: {
                  id: '018f3a22-7f91-7d9a-9e12-111111111111',
                  handle: 'fan123',
                  display_name: 'Fan 123',
                  avatar_url: null,
                },
                video_id: '018f3a22-7f91-7d9a-9e12-000000000001',
                comment_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
                created_at: new Date().toISOString(),
                read_at: null,
              },
            ],
            next_cursor: null,
          },
          response: new Response(null, { status: 200 }),
        } as any;
      }
      return { data: null, response: new Response(null, { status: 404 }) } as any;
    });
  });

  afterEach(() => {
    mockServer.stop();
    serverSocket = null;
    vi.useRealTimers();
  });

  function renderBell(client: RealtimeClient) {
    return render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RealtimeProvider client={client}>
            <NotificationBell />
          </RealtimeProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('1. a hint invalidates the count once', async () => {
    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
      requestTicket: async () => 'test-ticket',
    });

    renderBell(client);

    // Allow initial query & socket connect to settle
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(unreadCountCalls).toBe(1);
    expect(client.getIsConnected()).toBe(true);

    // Realtime server pushes a notification.hint for this user
    currentUnreadCount = 4;
    await act(async () => {
      serverSocket.send(
        JSON.stringify({
          type: 'event',
          room: `user:${TEST_USER_ID}`,
          event: 'notification.hint',
          data: { kind: 'VIDEO_COMMENT' },
          ts: new Date().toISOString(),
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    // Before trailing 2s timer, no refetch yet
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(unreadCountCalls).toBe(1);

    // After 2s trailing timer expires, unread count is refetched once
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(unreadCountCalls).toBe(2);

    // UI shows updated badge '4'
    expect(screen.getByTestId('notification-badge').textContent).toBe('4');

    client.disconnect();
  });

  it('2. 5 hints within 2 s → 1 refetch (burst coalescing)', async () => {
    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
      requestTicket: async () => 'test-ticket',
    });

    renderBell(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(unreadCountCalls).toBe(1);

    // Push 5 hints rapidly within 2 s
    currentUnreadCount = 8;
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        serverSocket.send(
          JSON.stringify({
            type: 'event',
            room: `user:${TEST_USER_ID}`,
            event: 'notification.hint',
            data: { kind: i % 2 === 0 ? 'VIDEO_COMMENT' : 'NEW_SUBSCRIBER' },
            ts: new Date().toISOString(),
          }),
        );
        await vi.advanceTimersByTimeAsync(200); // 200ms between each
      });
    }

    // Now advance through the remaining 2000ms window
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Exactly 1 refetch occurred for all 5 bursts! (1 initial + 1 refetch = 2)
    expect(unreadCountCalls).toBe(2);
    expect(screen.getByTestId('notification-badge').textContent).toBe('8');

    client.disconnect();
  });

  it('3. interval is 5 min when connected and 60 s after a disconnect', async () => {
    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
      requestTicket: async () => 'test-ticket',
    });

    renderBell(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(unreadCountCalls).toBe(1);
    expect(client.getIsConnected()).toBe(true);
    expect(client.getUserId()).toBe(TEST_USER_ID);

    // 1. While connected & authenticated: interval is 5 min (300,000 ms).
    // After 60 s, NO polling should have occurred.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(unreadCountCalls).toBe(1);

    // After another 240 s (total 300 s / 5 min), exactly 1 poll occurs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240000);
    });
    expect(unreadCountCalls).toBe(2);

    // 2. Disconnect socket -> drops to 60 s fallback polling.
    act(() => {
      client.disconnect();
    });
    expect(client.getIsConnected()).toBe(false);

    // After 60 s in disconnected state, exactly 1 poll occurs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(unreadCountCalls).toBe(3);

    client.disconnect();
  });

  it('4. reconnect → one refetch', async () => {
    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
      requestTicket: async () => 'test-ticket',
      baseDelayMs: 20, // fast reconnect backoff for test
    });

    renderBell(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(unreadCountCalls).toBe(1);
    expect(client.getIsConnected()).toBe(true);

    // Simulate server deploy/restart close (1001)
    await act(async () => {
      serverSocket.close({ code: 1001, reason: 'Deploy restart' });
      await vi.advanceTimersByTimeAsync(100);
    });

    // Client reconnected and onReconnect refetched count once
    expect(client.getIsConnected()).toBe(true);
    expect(unreadCountCalls).toBe(2);

    client.disconnect();
  });

  it('5. a hint while the dropdown is open also refetches the list', async () => {
    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
      requestTicket: async () => 'test-ticket',
    });

    renderBell(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(unreadCountCalls).toBe(1);
    expect(listCalls).toBe(0);

    // Open notification dropdown
    const bellButton = screen.getByTestId('notification-bell-button');
    await act(async () => {
      fireEvent.click(bellButton);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(listCalls).toBe(1);

    // Push notification.hint while dropdown is open
    currentUnreadCount = 4;
    await act(async () => {
      serverSocket.send(
        JSON.stringify({
          type: 'event',
          room: `user:${TEST_USER_ID}`,
          event: 'notification.hint',
          data: { kind: 'VIDEO_COMMENT' },
          ts: new Date().toISOString(),
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    // Advance 2000ms trailing coalescing timer
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // BOTH count query and list query were refetched!
    expect(unreadCountCalls).toBe(2);
    expect(listCalls).toBe(2);

    client.disconnect();
  });

  it('6. hints are ignored when signed out', async () => {
    mockIsAuthenticated = false;
    mockUser = null;

    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
    });

    renderBell(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // When signed out, Bell renders null, 0 queries executed
    expect(unreadCountCalls).toBe(0);

    // Send a hint to server socket
    if (serverSocket) {
      act(() => {
        serverSocket.send(
          JSON.stringify({
            type: 'event',
            room: `user:${TEST_USER_ID}`,
            event: 'notification.hint',
            data: { kind: 'VIDEO_COMMENT' },
            ts: new Date().toISOString(),
          }),
        );
      });
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // Still 0 queries executed
    expect(unreadCountCalls).toBe(0);

    client.disconnect();
  });
});
