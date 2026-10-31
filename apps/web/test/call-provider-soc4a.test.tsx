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
  fetchMessages: vi.fn(async (..._args: unknown[]): Promise<{ items: unknown[] }> => ({
    items: [answer],
  })),
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

  it('reads past old history this device has no key for, but waits on a recent message until its key arrives', async () => {
    const old = {
      status: 'WAITING_FOR_KEY',
      message: {
        seq: 1,
        sender_id: 'user-binh',
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
      },
    };
    const recent = {
      ...old,
      message: { ...old.message, seq: 3, created_at: new Date().toISOString() },
    };
    const invite = {
      ...answer,
      callEvent: { type: 'm.call.invite', v: 1, call_id: 'call-2', sdp: 'v=0', kind: 'audio' },
      message: { ...answer.message, seq: 4 },
    };
    databases = [{ name: (await import('../src/lib/e2ee/storage')).DB_NAME }];
    chat.fetchMessages
      .mockResolvedValueOnce({ items: [old, answer, recent, invite] })
      .mockResolvedValueOnce({ items: [{ ...recent, status: 'DECRYPTED' }, invite] });
    render(
      <CallProvider>
        <p>trang</p>
      </CallProvider>,
    );
    await waitFor(() => expect(onEvent).not.toBeNull());

    await act(async () => {
      onEvent!({ event: 'chat.hint', data: { kind: 'MESSAGE', conversation_id: 'conv-1' } });
    });
    // The hour-old message is skipped, the answer is read, the scan stops at the recent unreadable one.
    await waitFor(() => expect(handleRoomEvent).toHaveBeenCalledTimes(1));
    expect(handleRoomEvent).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 2 }));

    // Its key arrives: the conversation is scanned again from after the answer and the invite is read.
    await act(async () => {
      onEvent!({ event: 'chat.hint', data: { kind: 'TO_DEVICE' } });
    });
    await waitFor(() => expect(handleRoomEvent).toHaveBeenCalledTimes(2));
    expect(chat.fetchMessages).toHaveBeenLastCalledWith('conv-1', { after_seq: 2, limit: 50 });
    expect(handleRoomEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: invite.callEvent, seq: 4 }),
    );
  });
});
