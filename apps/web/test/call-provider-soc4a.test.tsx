import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

// SOC-4a regression: the E2EE device is usually created after CallProvider mounts (first /tin-nhan visit after
// login). The provider must pick it up on the next hint instead of staying deaf to call events for the whole tab.

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({ user: { id: 'user-an' }, isAuthenticated: true, isLoading: false }),
}));

let onEvent: ((evt: { event: string; data: unknown }) => void) | null = null;
vi.mock('../src/lib/realtime/realtime-context', () => ({
  useRealtimeRoom: (_room: string | null, handler: typeof onEvent) => {
    onEvent = handler;
  },
}));

const handleRoomEvent = vi.fn(async () => {});
vi.mock('../src/lib/calls/call-manager', () => ({
  CallManager: class {
    subscribe = () => () => {};
    getSnapshot = () => null;
    handleRoomEvent = handleRoomEvent;
    handleDeviceEvent = vi.fn();
  },
}));

const conversation = {
  id: 'conv-1',
  kind: 'DIRECT',
  members: [{ user_id: 'user-an' }, { user_id: 'user-binh' }],
};
const answer = {
  status: 'CALL',
  callEvent: { type: 'm.call.answer', v: 1, call_id: 'call-1', sdp: 'v=0' },
  message: {
    seq: 2,
    sender_id: 'user-binh',
    sender_device_id: 'dev-binh',
    created_at: new Date().toISOString(),
  },
};
const chat = {
  onCallSignal: vi.fn(() => () => {}),
  ensureReady: vi.fn(async () => {}),
  processToDeviceMessages: vi.fn(async () => []),
  getConversation: vi.fn(async () => conversation),
  fetchMessages: vi.fn(async () => ({ items: [answer] })),
};
vi.mock('../src/lib/e2ee/chat-service', () => ({ getChatService: () => chat }));

import { CallProvider } from '../src/components/calls/call-provider';

let databases: { name: string }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  databases = [];
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: { databases: async () => databases },
  });
});

describe('SOC-4a CallProvider', () => {
  it('starts reading call events once the E2EE device exists, even if it was created after mount', async () => {
    render(
      <CallProvider>
        <p>trang</p>
      </CallProvider>,
    );
    await waitFor(() => expect(onEvent).not.toBeNull());

    // No device yet: the hint is ignored and nothing is fetched.
    await act(async () => {
      onEvent!({ event: 'chat.hint', data: { kind: 'MESSAGE', conversation_id: 'conv-1' } });
    });
    expect(chat.ensureReady).not.toHaveBeenCalled();
    expect(chat.fetchMessages).not.toHaveBeenCalled();

    // The chat page creates the device; the next hint (the callee's answer) is read and handed to the manager.
    const { DB_NAME } = await import('../src/lib/e2ee/storage');
    databases = [{ name: DB_NAME }];
    await act(async () => {
      onEvent!({ event: 'chat.hint', data: { kind: 'MESSAGE', conversation_id: 'conv-1' } });
    });
    await waitFor(() => expect(handleRoomEvent).toHaveBeenCalledTimes(1));
    expect(chat.ensureReady).toHaveBeenCalledWith('user-an');
    expect(chat.processToDeviceMessages).toHaveBeenCalled();
    expect(handleRoomEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: answer.callEvent, senderDeviceId: 'dev-binh', fresh: true }),
    );
  });
});
