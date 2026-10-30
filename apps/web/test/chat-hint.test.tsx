import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import type { Conversation, ConversationPage } from '@winkey/api-client';

// 1. Mock routing
const mockPush = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/tin-nhan',
  Link: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

// 2. Mock auth-context
const mockUser = {
  id: 'user-alice-001',
  email: 'alice@winkey.vn',
  display_name: 'Alice',
  roles: ['user'],
};
let mockIsAuthenticated = true;
let mockAuthLoading = false;

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockAuthLoading,
  }),
}));

// 3. Mock realtime-context
let capturedRoom: string | null | undefined = null;
let capturedOnEvent: ((evt: any) => void) | null = null;
let capturedOnReconnect: (() => void) | null = null;

vi.mock('../src/lib/realtime/realtime-context', () => ({
  useRealtimeRoom: (room: string | null, onEvent: any, onReconnect: any) => {
    capturedRoom = room;
    capturedOnEvent = onEvent;
    capturedOnReconnect = onReconnect;
    return { isConnected: true };
  },
}));

// 4. Mock ChatService
const mockListConversations = vi.fn();
const mockProcessToDeviceMessages = vi.fn();
const mockGetDeviceId = vi.fn();
const mockEnsureReady = vi.fn();

const mockChatService = {
  listConversations: mockListConversations,
  processToDeviceMessages: mockProcessToDeviceMessages,
  getDeviceId: mockGetDeviceId,
  ensureReady: mockEnsureReady,
};

vi.mock('../src/lib/e2ee/chat-service', () => ({
  getChatService: () => mockChatService,
}));

// 5. Mock child components of tin-nhan to inspect passed props
let lastConversationViewProps: any = null;
vi.mock('../src/components/chat/conversation-view', () => ({
  ConversationView: (props: any) => {
    lastConversationViewProps = props;
    return (
      <div data-testid="conversation-view">
        Conversation View (realtimeVersion: {props.realtimeVersion})
      </div>
    );
  },
}));

vi.mock('../src/components/chat/conversation-list', () => ({
  ConversationList: ({ conversations, onSelectConversation }: any) => (
    <div data-testid="conversation-list">
      {conversations.map((c: any) => (
        <button key={c.id} data-testid={`select-${c.id}`} onClick={() => onSelectConversation(c)}>
          {c.id}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../src/components/chat/new-chat-dialog', () => ({
  NewChatDialog: () => <div data-testid="new-chat-dialog" />,
}));

import ChatPage from '../src/app/[locale]/tin-nhan/page';

const sampleConversation: Conversation = {
  id: 'conv-hint-test-1',
  kind: 'DIRECT',
  title: null,
  my_role: 'MEMBER',
  my_state: 'ACTIVE',
  last_seq: 10,
  last_message_at: '2026-10-30T06:00:00Z',
  unread_count: 0,
  muted_until: null,
  created_at: '2026-10-30T05:00:00Z',
  members: [
    {
      user_id: 'user-alice-001',
      user: { id: 'user-alice-001', handle: 'alice', display_name: 'Alice', avatar_url: null },
      role: 'MEMBER',
      state: 'ACTIVE',
    },
    {
      user_id: 'user-bob-002',
      user: { id: 'user-bob-002', handle: 'bob', display_name: 'Bob', avatar_url: null },
      role: 'MEMBER',
      state: 'ACTIVE',
    },
  ],
};

const emptyPage: ConversationPage = {
  items: [sampleConversation],
  next_cursor: null,
};

describe('Chat UI chat.hint realtime handlers (ADR-049 / SOC-3a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRoom = null;
    capturedOnEvent = null;
    capturedOnReconnect = null;
    lastConversationViewProps = null;

    mockIsAuthenticated = true;
    mockAuthLoading = false;
    mockGetDeviceId.mockReturnValue('dev-alice-001');
    mockEnsureReady.mockResolvedValue('dev-alice-001');
    mockListConversations.mockResolvedValue(emptyPage);
    mockProcessToDeviceMessages.mockResolvedValue([]);
  });

  it('subscribes to user room and initializes conversation list and device', async () => {
    render(<ChatPage />);

    await waitFor(() => {
      expect(capturedRoom).toBe(`user:${mockUser.id}`);
      expect(mockListConversations).toHaveBeenCalledWith('ACTIVE');
      expect(mockListConversations).toHaveBeenCalledWith('REQUESTED');
      expect(mockEnsureReady).toHaveBeenCalledWith(mockUser.id);
    });
  });

  it('handles chat.hint TO_DEVICE: triggers processToDeviceMessages and increments realtimeVersion', async () => {
    render(<ChatPage />);

    const selectBtn = await screen.findByTestId('select-conv-hint-test-1');
    fireEvent.click(selectBtn);

    await waitFor(() => {
      expect(lastConversationViewProps).not.toBeNull();
      expect(capturedOnEvent).toBeTypeOf('function');
    });

    const initialVersion = lastConversationViewProps.realtimeVersion;
    const initialToDeviceCalls = mockProcessToDeviceMessages.mock.calls.length;

    // Trigger chat.hint TO_DEVICE
    await act(async () => {
      capturedOnEvent!({
        event: 'chat.hint',
        data: { kind: 'TO_DEVICE' },
      });
    });

    await waitFor(() => {
      expect(mockProcessToDeviceMessages.mock.calls.length).toBe(initialToDeviceCalls + 1);
      expect(lastConversationViewProps.realtimeVersion).toBe(initialVersion + 1);
    });
  });

  it('handles chat.hint MESSAGE: refetches conversations and increments realtimeVersion', async () => {
    render(<ChatPage />);

    const selectBtn = await screen.findByTestId('select-conv-hint-test-1');
    fireEvent.click(selectBtn);

    await waitFor(() => {
      expect(lastConversationViewProps).not.toBeNull();
      expect(capturedOnEvent).toBeTypeOf('function');
    });

    const initialVersion = lastConversationViewProps.realtimeVersion;
    const initialListCalls = mockListConversations.mock.calls.length;

    // Trigger chat.hint MESSAGE
    await act(async () => {
      capturedOnEvent!({
        event: 'chat.hint',
        data: { kind: 'MESSAGE', conversation_id: 'conv-hint-test-1' },
      });
    });

    await waitFor(() => {
      expect(mockListConversations.mock.calls.length).toBeGreaterThan(initialListCalls);
      expect(lastConversationViewProps.realtimeVersion).toBe(initialVersion + 1);
    });
  });

  it('handles chat.hint CONVERSATION and DEVICES: refetches conversations and increments realtimeVersion', async () => {
    render(<ChatPage />);

    const selectBtn = await screen.findByTestId('select-conv-hint-test-1');
    fireEvent.click(selectBtn);

    await waitFor(() => {
      expect(lastConversationViewProps).not.toBeNull();
      expect(capturedOnEvent).toBeTypeOf('function');
    });

    const initialVersion = lastConversationViewProps.realtimeVersion;

    // Trigger CONVERSATION
    await act(async () => {
      capturedOnEvent!({
        event: 'chat.hint',
        data: { kind: 'CONVERSATION' },
      });
    });

    await waitFor(() => {
      expect(lastConversationViewProps.realtimeVersion).toBe(initialVersion + 1);
    });

    // Trigger DEVICES
    await act(async () => {
      capturedOnEvent!({
        event: 'chat.hint',
        data: { kind: 'DEVICES' },
      });
    });

    await waitFor(() => {
      expect(lastConversationViewProps.realtimeVersion).toBe(initialVersion + 2);
    });
  });

  it('handles WebSocket reconnect: refetches conversations and processes pending to-device messages', async () => {
    render(<ChatPage />);

    const selectBtn = await screen.findByTestId('select-conv-hint-test-1');
    fireEvent.click(selectBtn);

    await waitFor(() => {
      expect(lastConversationViewProps).not.toBeNull();
      expect(capturedOnReconnect).toBeTypeOf('function');
    });

    const initialVersion = lastConversationViewProps.realtimeVersion;
    const listCountBefore = mockListConversations.mock.calls.length;
    const toDeviceCountBefore = mockProcessToDeviceMessages.mock.calls.length;

    // Trigger reconnect
    await act(async () => {
      capturedOnReconnect!();
    });

    await waitFor(() => {
      expect(mockListConversations.mock.calls.length).toBeGreaterThan(listCountBefore);
      expect(mockProcessToDeviceMessages.mock.calls.length).toBeGreaterThan(toDeviceCountBefore);
      expect(lastConversationViewProps.realtimeVersion).toBe(initialVersion + 1);
    });
  });
});
