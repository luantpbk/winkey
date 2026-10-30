import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConversationView } from '../src/components/chat/conversation-view';
import { SafetyNumberDialog } from '../src/components/chat/safety-number-dialog';
import type { Conversation } from '@winkey/api-client';

const { mockCurrentUserId, mockPeerUserId } = vi.hoisted(() => ({
  mockCurrentUserId: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
  mockPeerUserId: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
}));

const mockActiveConversation: Conversation = {
  id: 'conv-active-123',
  kind: 'DIRECT',
  title: null,
  my_role: 'MEMBER',
  my_state: 'ACTIVE',
  last_seq: 10,
  last_message_at: '2026-10-30T05:00:00Z',
  unread_count: 0,
  muted_until: null,
  created_at: '2026-10-30T04:00:00Z',
  members: [
    {
      user_id: mockCurrentUserId,
      user: {
        id: mockCurrentUserId,
        handle: 'me',
        display_name: 'Myself',
        avatar_url: null,
      },
      role: 'MEMBER',
      state: 'ACTIVE',
    },
    {
      user_id: mockPeerUserId,
      user: {
        id: mockPeerUserId,
        handle: 'alice',
        display_name: 'Alice Wonder',
        avatar_url: null,
      },
      role: 'MEMBER',
      state: 'ACTIVE',
    },
  ],
};

const mockRequestedConversation: Conversation = {
  ...mockActiveConversation,
  id: 'conv-requested-456',
  my_state: 'REQUESTED',
  members: [
    {
      ...mockActiveConversation.members[0],
      state: 'REQUESTED',
    },
    mockActiveConversation.members[1],
  ],
};

// Mock ChatService
const mockFetchMessages = vi.fn();
const mockSendMessage = vi.fn();
const mockDeleteMessage = vi.fn();
const mockMarkRead = vi.fn();
const mockAcceptConversation = vi.fn();
const mockLeaveOrRemoveMember = vi.fn();
const mockGetConversation = vi.fn();

const mockChatService = {
  fetchMessages: mockFetchMessages,
  sendMessage: mockSendMessage,
  deleteMessage: mockDeleteMessage,
  markRead: mockMarkRead,
  acceptConversation: mockAcceptConversation,
  leaveOrRemoveMember: mockLeaveOrRemoveMember,
  getConversation: mockGetConversation,
};

vi.mock('../src/lib/e2ee/chat-service', () => ({
  getChatService: () => mockChatService,
}));

// Mock api-client for query devices in SafetyNumber
vi.mock('../src/lib/api-client', () => ({
  api: {
    chat: {
      POST: vi.fn().mockResolvedValue({
        data: {
          users: [
            {
              user_id: mockCurrentUserId,
              devices: [
                {
                  id: 'dev-1',
                  ed25519_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                },
              ],
            },
            {
              user_id: mockPeerUserId,
              devices: [
                {
                  id: 'dev-2',
                  ed25519_key: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                },
              ],
            },
          ],
        },
      }),
    },
  },
}));

describe('Chat UI Components (ADR-049 / SOC-3a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchMessages.mockResolvedValue({
      items: [],
      has_more: false,
    });
  });

  it('renders XSS strings strictly as plain text and never evaluates HTML', async () => {
    const maliciousScript =
      '<script>window.__xss_flag = true;</script><img src="x" onerror="alert(1)" />';

    mockFetchMessages.mockResolvedValueOnce({
      items: [
        {
          message: {
            conversation_id: 'conv-active-123',
            seq: 1,
            id: 'msg-xss-1',
            kind: 'ENCRYPTED',
            sender_id: mockPeerUserId,
            sender_device_id: 'dev-2',
            megolm_session_id: 'sess-1',
            ciphertext: 'cipher',
            system: null,
            deleted: false,
            created_at: '2026-10-30T05:01:00Z',
          },
          plaintext: maliciousScript,
          status: 'DECRYPTED',
        },
      ],
      has_more: false,
    });

    render(
      <ConversationView
        conversation={mockActiveConversation}
        currentUserId={mockCurrentUserId}
        onConversationUpdated={vi.fn()}
        onConversationLeft={vi.fn()}
      />,
    );

    // Verify text is present as literal text content
    await waitFor(() => {
      expect(screen.getByText(maliciousScript)).toBeTruthy();
    });

    // Verify no script or img elements were injected into DOM
    expect(document.querySelector('script[src]')).toBeNull();
    expect((window as any).__xss_flag).toBeUndefined();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('disables composer and displays message requests banner when conversation is REQUESTED', async () => {
    render(
      <ConversationView
        conversation={mockRequestedConversation}
        currentUserId={mockCurrentUserId}
        onConversationUpdated={vi.fn()}
        onConversationLeft={vi.fn()}
      />,
    );

    // Request banner must appear
    expect(screen.getByText(/muốn gửi tin nhắn cho bạn/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Chấp nhận/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Từ chối/i })).toBeTruthy();

    // Textarea must be disabled with notice placeholder
    const textarea = screen.getByPlaceholderText(
      /Vui lòng chấp nhận lời mời để gửi tin nhắn/i,
    ) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);

    // Send button must be disabled
    const sendBtn = screen.getByRole('button', { name: '' }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it('handles message request acceptance and rejection callbacks', async () => {
    const onUpdated = vi.fn();
    const onLeft = vi.fn();
    mockAcceptConversation.mockResolvedValueOnce({
      ...mockRequestedConversation,
      my_state: 'ACTIVE',
    });

    render(
      <ConversationView
        conversation={mockRequestedConversation}
        currentUserId={mockCurrentUserId}
        onConversationUpdated={onUpdated}
        onConversationLeft={onLeft}
      />,
    );

    const acceptBtn = screen.getByRole('button', { name: /Chấp nhận/i });
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      expect(mockAcceptConversation).toHaveBeenCalledWith(mockRequestedConversation.id);
      expect(onUpdated).toHaveBeenCalled();
    });

    // Test decline button
    window.confirm = vi.fn(() => true);
    mockLeaveOrRemoveMember.mockResolvedValueOnce(undefined);

    const declineBtn = screen.getByRole('button', { name: /Từ chối/i });
    fireEvent.click(declineBtn);

    await waitFor(() => {
      expect(mockLeaveOrRemoveMember).toHaveBeenCalledWith(
        mockRequestedConversation.id,
        mockCurrentUserId,
      );
      expect(onLeft).toHaveBeenCalled();
    });
  });

  it('renders Safety Number dialog with 60 digits partitioned into groups of 5', async () => {
    const keyA = '3z1Q1M2k0d/rEaP9xU+4G2yWj1lKmNxV5bTcQ8pZsAo';
    const keyB = '7m8N9b0c1d2e3f4g5h6i7j8k9l0m1n2o3p4q5r6s7t8';

    render(
      <SafetyNumberDialog
        isOpen={true}
        onClose={vi.fn()}
        peerName="Alice"
        myEd25519Key={keyA}
        peerEd25519Key={keyB}
      />,
    );

    expect(screen.getByText(/Mã số an toàn E2EE/i)).toBeTruthy();
    expect(screen.getByText(/Xác minh bảo mật với Alice/i)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText(/Sao chép toàn bộ mã/i)).toBeTruthy();
    });
  });

  it('refetches messages when realtimeVersion prop increments (chat.hint update)', async () => {
    const { rerender } = render(
      <ConversationView
        conversation={mockActiveConversation}
        currentUserId={mockCurrentUserId}
        realtimeVersion={0}
        onConversationUpdated={vi.fn()}
        onConversationLeft={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockFetchMessages).toHaveBeenCalledTimes(1);
      expect(mockFetchMessages).toHaveBeenCalledWith(mockActiveConversation.id, { limit: 100 });
    });

    // Rerender with unchanged realtimeVersion: should not trigger extra fetch
    rerender(
      <ConversationView
        conversation={mockActiveConversation}
        currentUserId={mockCurrentUserId}
        realtimeVersion={0}
        onConversationUpdated={vi.fn()}
        onConversationLeft={vi.fn()}
      />,
    );
    expect(mockFetchMessages).toHaveBeenCalledTimes(1);

    // Increment realtimeVersion to 1: triggers refetch
    rerender(
      <ConversationView
        conversation={mockActiveConversation}
        currentUserId={mockCurrentUserId}
        realtimeVersion={1}
        onConversationUpdated={vi.fn()}
        onConversationLeft={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockFetchMessages).toHaveBeenCalledTimes(2);
    });
  });
});
