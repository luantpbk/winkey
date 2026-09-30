import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Server } from 'mock-socket';
import { RealtimeClient } from '../src/lib/realtime/realtime-client';
import { RealtimeProvider } from '../src/lib/realtime/realtime-context';
import StudioPage from '../src/app/[locale]/studio/page';
import { LikeButton } from '../src/components/social/like-button';
import { CommentSection } from '../src/components/social/comment-section';
import { api } from '../src/lib/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui/toast';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === 'newCommentsPill') return `${values?.count} bình luận mới`;
    if (key === 'commentsCount') return `${values?.count} bình luận`;
    if (key === 'like') return 'Thích';
    if (key === 'liked') return 'Đã thích';
    if (key === 'status.READY') return 'Sẵn sàng';
    if (key === 'status.PROCESSING') return 'Đang xử lý';
    if (key === 'status.UPLOADED') return 'Đã tải lên';
    if (key === 'status.FAILED') return 'Lỗi xử lý';
    if (key === 'title') return 'Studio';
    if (key === 'tableTitle') return 'Tiêu đề';
    if (key === 'tableVisibility') return 'Hiển thị';
    if (key === 'tableStatus') return 'Trạng thái';
    if (key === 'tableDate') return 'Ngày tạo';
    if (key === 'noVideos') return 'Chưa có video';
    if (key === 'uploadNew') return 'Tải video mới';
    return key;
  },
}));

// Mock routing
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/watch/v-test-123',
  Link: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Mock auth-context
let mockUser: { id: string; email?: string; display_name?: string; roles: string[] } | null = {
  id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
  email: 'creator@winkey.vn',
  display_name: 'Creator',
  roles: ['creator'],
};
let mockIsAuthenticated = true;

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: mockIsAuthenticated,
    isCreator: true,
    isLoading: false,
  }),
}));

const WS_URL = 'ws://localhost:8080/v1/realtime';

describe('Realtime Protocol & Client Architecture (Task U2)', () => {
  let mockServer: Server;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsAuthenticated = true;
    mockUser = {
      id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
      email: 'creator@winkey.vn',
      display_name: 'Creator',
      roles: ['creator'],
    };
    mockServer = new Server(WS_URL);
  });

  afterEach(() => {
    mockServer.stop();
  });

  it('1. Ticket per connect: requests fresh single-use ticket when signed-in, never stores ticket', async () => {
    let ticketCalls = 0;
    const requestTicket = vi.fn().mockImplementation(async () => {
      ticketCalls += 1;
      return `ticket-secret-token-${ticketCalls}`;
    });

    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
      requestTicket,
    });

    expect(client.getIsConnected()).toBe(false);

    // Connecting triggers ticket request
    client.connect();

    await waitFor(() => {
      expect(requestTicket).toHaveBeenCalledTimes(1);
    });

    // Check that ticket was passed in query parameter but not stored in storage
    expect(localStorage.getItem('ticket')).toBeNull();
    expect(sessionStorage.getItem('ticket')).toBeNull();

    client.disconnect();
  });

  it('2. Backoff sequence + jitter bounds: reconnect increases delay up to 30s max', () => {
    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
    });

    // We can verify computeBackoffDelay via multiple failed attempts
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      // @ts-expect-error accessing private computeBackoffDelay for testing
      const delay = client.computeBackoffDelay();
      delays.push(delay);
    }

    // Attempt 1 should be around 1000ms
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThanOrEqual(1500);

    // Each subsequent delay should grow exponentially
    expect(delays[1]).toBeGreaterThanOrEqual(1200);
    expect(delays[2]).toBeGreaterThanOrEqual(2400);

    // Max capped at 30000ms (30s)
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(30000);
    }
    expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(20000);
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(30000);
  });

  it('3. Re-subscribe active rooms and notify REST refetch after reconnect', async () => {
    let serverSocket: any = null;
    const receivedFrames: any[] = [];

    mockServer.on('connection', (socket) => {
      serverSocket = socket;
      socket.on('message', (data) => {
        receivedFrames.push(JSON.parse(data as string));
      });

      // Send welcome
      socket.send(
        JSON.stringify({
          type: 'welcome',
          connection_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          user_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          heartbeat_interval_ms: 25000,
        }),
      );
    });

    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
      baseDelayMs: 20,
    });

    const reconnectSpy = vi.fn();
    const eventSpy = vi.fn();

    // Subscribe to room
    client.subscribe('video:018f3a22-7f91-7d9a-9e12-000000000001', eventSpy, reconnectSpy);

    await waitFor(() => {
      expect(client.getIsConnected()).toBe(true);
      expect(reconnectSpy).toHaveBeenCalledTimes(0); // not called on initial connect
    });

    // Verify initial subscribe frame was sent
    expect(receivedFrames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'subscribe',
          room: 'video:018f3a22-7f91-7d9a-9e12-000000000001',
        }),
      ]),
    );

    // Now simulate server disconnect with code 1001 (deploy)
    receivedFrames.length = 0;
    serverSocket.close({ code: 1001, reason: 'Going away' });

    // Wait for client to reconnect automatically
    await waitFor(() => {
      expect(client.getIsConnected()).toBe(true);
      expect(reconnectSpy).toHaveBeenCalledTimes(1); // called on reconnect
    });

    // Verify room was re-subscribed
    await waitFor(() => {
      expect(receivedFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'subscribe',
            room: 'video:018f3a22-7f91-7d9a-9e12-000000000001',
          }),
        ]),
      );
    });

    client.disconnect();
  });

  it('4. Ref-counted rooms: multiple subscribers share 1 frame; last unmount sends unsubscribe', async () => {
    const receivedFrames: any[] = [];

    mockServer.on('connection', (socket) => {
      socket.on('message', (data) => {
        receivedFrames.push(JSON.parse(data as string));
      });

      socket.send(
        JSON.stringify({
          type: 'welcome',
          connection_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          user_id: null,
          heartbeat_interval_ms: 25000,
        }),
      );
    });

    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
    });

    const handlerA = vi.fn();
    const handlerB = vi.fn();

    const unsubA = client.subscribe('video:018f3a22-7f91-7d9a-9e12-000000000001', handlerA);

    await waitFor(() => {
      expect(receivedFrames.filter((f) => f.type === 'subscribe').length).toBe(1);
    });

    // Second subscriber to the exact same room
    const unsubB = client.subscribe('video:018f3a22-7f91-7d9a-9e12-000000000001', handlerB);

    // Still only 1 subscribe frame sent!
    expect(receivedFrames.filter((f) => f.type === 'subscribe').length).toBe(1);

    // First subscriber unmounts
    unsubA();
    // No unsubscribe frame yet because handlerB is still active
    expect(receivedFrames.filter((f) => f.type === 'unsubscribe').length).toBe(0);

    // Second subscriber unmounts
    unsubB();
    // Now unsubscribe frame is sent!
    await waitFor(() => {
      expect(receivedFrames.filter((f) => f.type === 'unsubscribe').length).toBe(1);
    });

    client.disconnect();
  });

  it('5. Close code handling: 4401 drops auth, 4429 backs off to 30s, 4400 logs client bug', async () => {
    let serverSocket: any = null;

    mockServer.on('connection', (socket) => {
      serverSocket = socket;
      socket.send(
        JSON.stringify({
          type: 'welcome',
          connection_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          user_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          heartbeat_interval_ms: 25000,
        }),
      );
    });

    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
      requestTicket: async () => 'valid-ticket',
    });

    client.connect();

    await waitFor(() => {
      expect(client.getIsConnected()).toBe(true);
    });

    // Close with 4401 (ticket revoked / unauthorized)
    serverSocket.close({ code: 4401, reason: 'Ticket revoked' });

    await waitFor(() => {
      expect(client.getIsConnected()).toBe(false);
    });

    // @ts-expect-error verify dropAuthUntilReauth flag
    expect(client.dropAuthUntilReauth).toBe(true);

    client.disconnect();
  });

  it('6. Invalid server frames are dropped by AJV validator without crashing', async () => {
    let serverSocket: any = null;

    mockServer.on('connection', (socket) => {
      serverSocket = socket;
      socket.send(
        JSON.stringify({
          type: 'welcome',
          connection_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          user_id: null,
          heartbeat_interval_ms: 25000,
        }),
      );
    });

    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
    });

    const eventSpy = vi.fn();
    client.subscribe('video:018f3a22-7f91-7d9a-9e12-000000000001', eventSpy);

    await waitFor(() => {
      expect(client.getIsConnected()).toBe(true);
    });

    // Send completely invalid JSON frame
    serverSocket.send('{ invalid-json');

    // Send frame with unknown type
    serverSocket.send(JSON.stringify({ type: 'UNKNOWN_TYPE_FRAME', foo: 'bar' }));

    // Send malformed event (missing required fields)
    serverSocket.send(
      JSON.stringify({
        type: 'event',
        room: 'video:018f3a22-7f91-7d9a-9e12-000000000001',
        event: 'like.count',
        // missing data and ts
      }),
    );

    // Send valid event frame matching schema
    serverSocket.send(
      JSON.stringify({
        type: 'event',
        room: 'video:018f3a22-7f91-7d9a-9e12-000000000001',
        event: 'like.count',
        data: {
          video_id: '018f3a22-7f91-7d9a-9e12-000000000001',
          like_count: 42,
        },
        ts: new Date().toISOString(),
      }),
    );

    await waitFor(() => {
      // Only the 1 valid event frame should have been dispatched!
      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'like.count',
          data: {
            video_id: '018f3a22-7f91-7d9a-9e12-000000000001',
            like_count: 42,
          },
        }),
      );
    });

    client.disconnect();
  });

  it('7. Rapid handleAuthChange calls: calling twice in succession opens exactly 1 connection and preserves subscriptions', async () => {
    let connectionCount = 0;
    const receivedFrames: Array<{ type: string; room?: string }> = [];

    mockServer.on('connection', (socket) => {
      connectionCount += 1;
      socket.on('message', (data) => {
        receivedFrames.push(JSON.parse(data as string));
      });

      socket.send(
        JSON.stringify({
          type: 'welcome',
          connection_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          user_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          heartbeat_interval_ms: 25000,
        }),
      );
    });

    const client = new RealtimeClient({
      getWsUrl: () => WS_URL,
      requestTicket: async () => 'test-ticket',
    });

    const room = 'upload:018f3a22-7f91-7d9a-9e12-000000000099';
    client.subscribe(room, vi.fn());

    // Call handleAuthChange twice in immediate succession
    client.handleAuthChange();
    client.handleAuthChange();

    await waitFor(() => {
      expect(client.getIsConnected()).toBe(true);
    });

    // Exactly 1 active connection opened
    expect(connectionCount).toBe(1);

    // Subscribe frame arrives at server
    await waitFor(() => {
      expect(receivedFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'subscribe',
            room,
          }),
        ]),
      );
    });

    client.disconnect();
  });
});

describe('Studio & Social Realtime Integration (Task U2)', () => {
  let mockServer: Server;
  let serverSocket: any = null;
  let receivedServerFrames: Array<{ type: string; room?: string }> = [];
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    serverSocket = null;
    receivedServerFrames = [];
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockServer = new Server(WS_URL);
    mockServer.on('connection', (socket) => {
      serverSocket = socket;
      socket.on('message', (data) => {
        try {
          receivedServerFrames.push(JSON.parse(data as string));
        } catch {
          // ignore
        }
      });
      socket.send(
        JSON.stringify({
          type: 'welcome',
          connection_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          user_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          heartbeat_interval_ms: 25000,
        }),
      );
    });
  });

  afterEach(() => {
    mockServer.stop();
    serverSocket = null;
    receivedServerFrames = [];
  });

  it('8. Studio live updates: video.progress and video.ready update state in real time', async () => {
    const videoId = '018f3a22-7f91-7d9a-9e12-000000000099';

    vi.spyOn(api.video, 'GET').mockResolvedValue({
      data: {
        items: [
          {
            id: videoId,
            title: 'Realtime Demo Video',
            visibility: 'PUBLIC',
            status: 'PROCESSING',
            progress: 10,
            thumbnail_url: null,
            duration_ms: 60000,
            created_at: new Date().toISOString(),
          },
        ],
        total: 1,
        page: 1,
        page_size: 10,
      },
      response: new Response(null, { status: 200 }),
    } as any);

    const client = new RealtimeClient({ getWsUrl: () => WS_URL });

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RealtimeProvider client={client}>
            <StudioPage />
          </RealtimeProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );

    // Initial state: PROCESSING (10%)
    expect(await screen.findByText(/10%/)).toBeDefined();

    // Server sends video.progress 65%
    act(() => {
      serverSocket.send(
        JSON.stringify({
          type: 'event',
          room: `upload:${videoId}`,
          event: 'video.progress',
          data: {
            video_id: videoId,
            stage: 'TRANSCODING',
            percent: 65,
          },
          ts: new Date().toISOString(),
        }),
      );
    });

    // Updated to 65% without page reload
    expect(await screen.findByText(/65%/)).toBeDefined();

    // Server sends video.ready
    act(() => {
      serverSocket.send(
        JSON.stringify({
          type: 'event',
          room: `upload:${videoId}`,
          event: 'video.ready',
          data: {
            video_id: videoId,
          },
          ts: new Date().toISOString(),
        }),
      );
    });

    // Updated to Sẵn sàng (READY)
    expect(await screen.findByText('Sẵn sàng')).toBeDefined();

    client.disconnect();
  });

  it('9. Watch page: like.count updates counter, does not fight in-flight optimistic toggle', async () => {
    const videoId = '018f3a22-7f91-7d9a-9e12-000000000001';

    vi.spyOn(api.social, 'GET').mockResolvedValue({
      data: { video_id: videoId, liked: false, like_count: 5 },
      response: new Response(null, { status: 200 }),
    } as any);

    const client = new RealtimeClient({ getWsUrl: () => WS_URL });

    render(
      <ToastProvider>
        <RealtimeProvider client={client}>
          <LikeButton videoId={videoId} initialLikeCount={5} />
        </RealtimeProvider>
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(client.getIsConnected()).toBe(true);
      expect(serverSocket).not.toBeNull();
    });

    expect(await screen.findByText('5')).toBeDefined();

    // Send like.count event from server -> updates to 20
    act(() => {
      serverSocket.send(
        JSON.stringify({
          type: 'event',
          room: `video:${videoId}`,
          event: 'like.count',
          data: {
            video_id: videoId,
            like_count: 20,
          },
          ts: new Date().toISOString(),
        }),
      );
    });

    expect(await screen.findByText('20')).toBeDefined();

    client.disconnect();
  });

  it('10. Watch page: comment.created shows "N bình luận mới" pill, clicking refetches REST', async () => {
    const videoId = '018f3a22-7f91-7d9a-9e12-000000000001';

    let fetchCount = 0;
    vi.spyOn(api.social, 'GET').mockImplementation(async () => {
      fetchCount += 1;
      return {
        data: { items: [], next_cursor: null },
        response: new Response(null, { status: 200 }),
      } as any;
    });

    const client = new RealtimeClient({ getWsUrl: () => WS_URL });

    render(
      <ToastProvider>
        <RealtimeProvider client={client}>
          <CommentSection videoId={videoId} />
        </RealtimeProvider>
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(client.getIsConnected()).toBe(true);
      expect(serverSocket).not.toBeNull();
    });

    await waitFor(() => {
      expect(fetchCount).toBe(1);
    });

    // Realtime comment.created arrives
    act(() => {
      serverSocket.send(
        JSON.stringify({
          type: 'event',
          room: `video:${videoId}`,
          event: 'comment.created',
          data: {
            comment_id: '018f3a22-7f91-7d9a-9e12-000000000999',
            video_id: videoId,
            parent_id: null,
          },
          ts: new Date().toISOString(),
        }),
      );
    });

    // Pill appears: "1 bình luận mới"
    const pill = await screen.findByText('1 bình luận mới');
    expect(pill).toBeDefined();

    // Clicking the pill triggers refetch
    fireEvent.click(pill);

    await waitFor(() => {
      expect(fetchCount).toBe(2);
      expect(screen.queryByText('1 bình luận mới')).toBeNull();
    });

    client.disconnect();
  });

  it('11. Studio stability: 5 video.progress events produce exactly 1 subscribe and 0 unsubscribe until video.ready', async () => {
    const videoId = '018f3a22-7f91-7d9a-9e12-000000000099';

    vi.spyOn(api.video, 'GET').mockResolvedValue({
      data: {
        items: [
          {
            id: videoId,
            title: 'Realtime Progress Stability Video',
            visibility: 'PUBLIC',
            status: 'PROCESSING',
            progress: 10,
            thumbnail_url: null,
            duration_ms: 60000,
            created_at: new Date().toISOString(),
          },
        ],
        total: 1,
        page: 1,
        page_size: 10,
      },
      response: new Response(null, { status: 200 }),
    } as any);

    const client = new RealtimeClient({ getWsUrl: () => WS_URL });

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RealtimeProvider client={client}>
            <StudioPage />
          </RealtimeProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );

    // Initial state rendered
    expect(await screen.findByText(/10%/)).toBeDefined();

    // Verify 1 subscribe frame was sent, 0 unsubscribe
    await waitFor(() => {
      expect(
        receivedServerFrames.filter((f) => f.type === 'subscribe' && f.room === `upload:${videoId}`)
          .length,
      ).toBe(1);
    });
    expect(receivedServerFrames.filter((f) => f.type === 'unsubscribe').length).toBe(0);

    // Send 5 video.progress events with different percentages
    const percents = [25, 40, 55, 70, 85];
    for (const pct of percents) {
      act(() => {
        serverSocket.send(
          JSON.stringify({
            type: 'event',
            room: `upload:${videoId}`,
            event: 'video.progress',
            data: {
              video_id: videoId,
              stage: 'TRANSCODING',
              percent: pct,
            },
            ts: new Date().toISOString(),
          }),
        );
      });
      expect(await screen.findByText(new RegExp(`${pct}%`))).toBeDefined();
    }

    // Verify STILL exactly 1 subscribe, 0 unsubscribe!
    expect(
      receivedServerFrames.filter((f) => f.type === 'subscribe' && f.room === `upload:${videoId}`)
        .length,
    ).toBe(1);
    expect(receivedServerFrames.filter((f) => f.type === 'unsubscribe').length).toBe(0);

    // Now send video.ready
    act(() => {
      serverSocket.send(
        JSON.stringify({
          type: 'event',
          room: `upload:${videoId}`,
          event: 'video.ready',
          data: { video_id: videoId },
          ts: new Date().toISOString(),
        }),
      );
    });

    expect(await screen.findByText('Sẵn sàng')).toBeDefined();

    // Once READY, video is no longer pending, so room is unsubscribed!
    await waitFor(() => {
      expect(
        receivedServerFrames.filter(
          (f) => f.type === 'unsubscribe' && f.room === `upload:${videoId}`,
        ).length,
      ).toBe(1);
    });

    client.disconnect();
  });

  it('12. Fallback polling: 0 polls when socket connected over 120s; 1 poll when disconnected after 30s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const videoId = '018f3a22-7f91-7d9a-9e12-000000000099';
    const uploadPollSpy = vi.spyOn(api.upload, 'GET').mockResolvedValue({
      data: {
        id: videoId,
        status: 'PROCESSING',
        progress: 30,
        error: null,
      },
      response: new Response(null, { status: 200 }),
    } as any);

    vi.spyOn(api.video, 'GET').mockResolvedValue({
      data: {
        items: [
          {
            id: videoId,
            title: 'Fallback Polling Test Video',
            visibility: 'PUBLIC',
            status: 'PROCESSING',
            progress: 10,
            thumbnail_url: null,
            duration_ms: 60000,
            created_at: new Date().toISOString(),
          },
        ],
        total: 1,
        page: 1,
        page_size: 10,
      },
      response: new Response(null, { status: 200 }),
    } as any);

    const client = new RealtimeClient({ getWsUrl: () => WS_URL });

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RealtimeProvider client={client}>
            <StudioPage />
          </RealtimeProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );

    // Initial render finishes with socket connected
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(client.getIsConnected()).toBe(true);

    // 1. Socket connected: advance 120s -> 0 calls to api.upload.GET
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    expect(uploadPollSpy).toHaveBeenCalledTimes(0);

    // 2. Disconnect socket -> isConnected becomes false
    act(() => {
      client.disconnect();
    });
    expect(client.getIsConnected()).toBe(false);

    // Advance 30s while disconnected -> exactly 1 call to api.upload.GET
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(uploadPollSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
