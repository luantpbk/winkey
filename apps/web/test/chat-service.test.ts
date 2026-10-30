import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation, Message, ToDeviceMessage } from '@winkey/api-client';

// Mock device manager
const mockGetDeviceId = vi.fn();
const mockEnsureDeviceRegistered = vi.fn();
vi.mock('../src/lib/e2ee/device-manager', () => ({
  getDeviceManager: () => ({
    getDeviceId: mockGetDeviceId,
    ensureDeviceRegistered: mockEnsureDeviceRegistered,
  }),
}));

// Mock e2ee client
const mockDecryptToDeviceBatch = vi.fn();
const mockPrepareOutboundMegolm = vi.fn();
const mockEncryptMessage = vi.fn();
const mockDecryptGroupMessage = vi.fn();
vi.mock('../src/lib/e2ee/client', () => ({
  getE2eeClient: () => ({
    decryptToDeviceBatch: mockDecryptToDeviceBatch,
    prepareOutboundMegolm: mockPrepareOutboundMegolm,
    encryptMessage: mockEncryptMessage,
    decryptGroupMessage: mockDecryptGroupMessage,
  }),
}));

// Mock api-client
const mockChatGet = vi.fn();
const mockChatPost = vi.fn();
vi.mock('../src/lib/api-client', () => ({
  api: {
    chat: {
      GET: (...args: any[]) => mockChatGet(...args),
      POST: (...args: any[]) => mockChatPost(...args),
    },
  },
}));

import { ChatService } from '../src/lib/e2ee/chat-service';

describe('ChatService queryDevices parsing & E2EE messaging (ADR-049 / SOC-3a)', () => {
  let service: ChatService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ChatService();
    mockGetDeviceId.mockReturnValue('my-dev-001');
  });

  describe('processToDeviceMessages', () => {
    it('correctly parses users array from /v1/chat/devices/query and maps curve25519 keys', async () => {
      // 1. Mock to-device batch with 2 messages from 2 different senders/devices
      const mockItems: ToDeviceMessage[] = [
        {
          id: '101',
          sender_id: 'user-alice-1',
          sender_device_id: 'alice-dev-a',
          ciphertext: 'cipher-alice',
          created_at: '2026-10-30T06:00:00Z',
        },
        {
          id: '102',
          sender_id: 'user-bob-2',
          sender_device_id: 'bob-dev-b',
          ciphertext: 'cipher-bob',
          created_at: '2026-10-30T06:01:00Z',
        },
      ];

      mockChatGet.mockResolvedValueOnce({
        data: {
          items: mockItems,
          has_more: false,
        },
        error: null,
      });

      // 2. Mock contract-compliant array response: users: [{ user_id, devices }]
      mockChatPost.mockImplementation(async (endpoint: string, opts: any) => {
        if (endpoint === '/v1/chat/devices/query') {
          expect(opts.body.user_ids).toEqual(
            expect.arrayContaining(['user-alice-1', 'user-bob-2']),
          );
          return {
            data: {
              users: [
                {
                  user_id: 'user-alice-1',
                  devices: [
                    {
                      id: 'alice-dev-a',
                      curve25519_key: 'curve-alice-key-123',
                      ed25519_key: 'ed-alice-key-123',
                    },
                    {
                      id: 'alice-dev-other',
                      curve25519_key: 'curve-alice-other',
                      ed25519_key: 'ed-alice-other',
                    },
                  ],
                },
                {
                  user_id: 'user-bob-2',
                  devices: [
                    {
                      id: 'bob-dev-b',
                      curve25519_key: 'curve-bob-key-456',
                      ed25519_key: 'ed-bob-key-456',
                    },
                  ],
                },
              ],
            },
            error: null,
          };
        }

        if (endpoint === '/v1/chat/devices/{device_id}/to-device/ack') {
          return { data: { acknowledged: true }, error: null };
        }

        return { data: null, error: null };
      });

      mockDecryptToDeviceBatch.mockResolvedValueOnce({
        processedIds: ['101', '102'],
        newMegolmSessionIds: ['sess-new-1'],
      });

      const res = await service.processToDeviceMessages();

      // Check worker payload
      expect(mockDecryptToDeviceBatch).toHaveBeenCalledWith([
        {
          id: '101',
          senderId: 'user-alice-1',
          senderDeviceId: 'alice-dev-a',
          senderCurve25519: 'curve-alice-key-123',
          ciphertext: 'cipher-alice',
        },
        {
          id: '102',
          senderId: 'user-bob-2',
          senderDeviceId: 'bob-dev-b',
          senderCurve25519: 'curve-bob-key-456',
          ciphertext: 'cipher-bob',
        },
      ]);

      // Check ACK call with max ID (102)
      expect(mockChatPost).toHaveBeenCalledWith(
        '/v1/chat/devices/{device_id}/to-device/ack',
        expect.objectContaining({
          params: { path: { device_id: 'my-dev-001' } },
          body: { up_to: '102' },
        }),
      );

      expect(res).toEqual(['sess-new-1']);
    });

    it('gracefully handles empty users or devices array in query response', async () => {
      mockChatGet.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: '201',
              sender_id: 'user-unknown-9',
              sender_device_id: 'dev-unknown-9',
              ciphertext: 'cipher-data',
              created_at: '2026-10-30T06:00:00Z',
            },
          ],
          has_more: false,
        },
        error: null,
      });

      // users array has empty devices or unknown user
      mockChatPost.mockImplementation(async (endpoint: string) => {
        if (endpoint === '/v1/chat/devices/query') {
          return {
            data: {
              users: [
                {
                  user_id: 'user-empty',
                  devices: [],
                },
                {
                  user_id: 'user-no-devs',
                  devices: null as any,
                },
              ],
            },
            error: null,
          };
        }
        return { data: { acknowledged: true }, error: null };
      });

      mockDecryptToDeviceBatch.mockResolvedValueOnce({
        processedIds: ['201'],
        newMegolmSessionIds: [],
      });

      const res = await service.processToDeviceMessages();

      // senderCurve25519 should be undefined without throwing
      expect(mockDecryptToDeviceBatch).toHaveBeenCalledWith([
        {
          id: '201',
          senderId: 'user-unknown-9',
          senderDeviceId: 'dev-unknown-9',
          senderCurve25519: undefined,
          ciphertext: 'cipher-data',
        },
      ]);
      expect(res).toEqual([]);
    });

    it('handles pagination when has_more is true', async () => {
      // First page
      mockChatGet.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: '1',
              sender_id: 'u1',
              sender_device_id: 'd1',
              ciphertext: 'c1',
              created_at: '2026-10-30T06:00:00Z',
            },
          ],
          has_more: true,
        },
        error: null,
      });

      // Second page
      mockChatGet.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: '2',
              sender_id: 'u2',
              sender_device_id: 'd2',
              ciphertext: 'c2',
              created_at: '2026-10-30T06:01:00Z',
            },
          ],
          has_more: false,
        },
        error: null,
      });

      mockChatPost.mockImplementation(async (endpoint: string) => {
        if (endpoint === '/v1/chat/devices/query') {
          return {
            data: { users: [] },
            error: null,
          };
        }
        return { data: { acknowledged: true }, error: null };
      });

      mockDecryptToDeviceBatch
        .mockResolvedValueOnce({
          processedIds: ['1'],
          newMegolmSessionIds: ['sess-1'],
        })
        .mockResolvedValueOnce({
          processedIds: ['2'],
          newMegolmSessionIds: ['sess-2'],
        });

      const res = await service.processToDeviceMessages();

      expect(mockChatGet).toHaveBeenCalledTimes(2);
      expect(mockChatGet).toHaveBeenNthCalledWith(
        2,
        '/v1/chat/devices/{device_id}/to-device',
        expect.objectContaining({
          params: {
            path: { device_id: 'my-dev-001' },
            query: { after: '1', limit: 100 },
          },
        }),
      );
      expect(res).toEqual(['sess-1', 'sess-2']);
    });

    it('returns empty array if no device registered or no messages', async () => {
      mockGetDeviceId.mockReturnValueOnce(null);
      const res1 = await service.processToDeviceMessages();
      expect(res1).toEqual([]);

      mockChatGet.mockResolvedValueOnce({
        data: { items: [], has_more: false },
        error: null,
      });
      const res2 = await service.processToDeviceMessages();
      expect(res2).toEqual([]);
    });
  });

  describe('sendMessage', () => {
    const mockConversation: Conversation = {
      id: 'conv-test-123',
      kind: 'DIRECT',
      title: null,
      my_role: 'MEMBER',
      my_state: 'ACTIVE',
      last_seq: 5,
      last_message_at: '2026-10-30T06:00:00Z',
      unread_count: 0,
      muted_until: null,
      created_at: '2026-10-30T05:00:00Z',
      members: [
        {
          user_id: 'my-user-id',
          user: { id: 'my-user-id', handle: 'me', display_name: 'Me', avatar_url: null },
          role: 'MEMBER',
          state: 'ACTIVE',
        },
        {
          user_id: 'peer-user-id',
          user: { id: 'peer-user-id', handle: 'peer', display_name: 'Peer', avatar_url: null },
          role: 'MEMBER',
          state: 'ACTIVE',
        },
      ],
    };

    it('queries member devices array and constructs allMemberDevices correctly', async () => {
      mockChatPost.mockImplementation(async (endpoint: string, opts: any) => {
        if (endpoint === '/v1/chat/devices/query') {
          return {
            data: {
              users: [
                {
                  user_id: 'my-user-id',
                  devices: [
                    {
                      id: 'my-dev-001',
                      curve25519_key: 'my-curve-key',
                      ed25519_key: 'my-ed-key',
                    },
                  ],
                },
                {
                  user_id: 'peer-user-id',
                  devices: [
                    {
                      id: 'peer-dev-001',
                      curve25519_key: 'peer-curve-key-1',
                      ed25519_key: 'peer-ed-key-1',
                    },
                    {
                      id: 'peer-dev-002',
                      curve25519_key: 'peer-curve-key-2',
                      ed25519_key: 'peer-ed-key-2',
                    },
                  ],
                },
              ],
            },
            error: null,
          };
        }

        if (endpoint === '/v1/chat/keys/claim') {
          expect(opts.body.device_ids).toEqual(['peer-dev-001', 'peer-dev-002']);
          return {
            data: {
              keys: [
                {
                  device_id: 'peer-dev-001',
                  key_id: 'otk-1',
                  public_key: 'otk-pub-1',
                },
              ],
            },
            error: null,
          };
        }

        if (endpoint === '/v1/chat/to-device') {
          return { data: { sent: true }, error: null };
        }

        if (endpoint === '/v1/chat/conversations/{conversation_id}/messages') {
          return {
            data: {
              id: 'msg-001',
              conversation_id: 'conv-test-123',
              seq: 6,
              kind: 'ENCRYPTED',
              sender_id: 'my-user-id',
              sender_device_id: 'my-dev-001',
              megolm_session_id: 'meg-sess-1',
              ciphertext: 'cipher-msg-1',
              system: null,
              deleted: false,
              created_at: '2026-10-30T06:05:00Z',
            } as Message,
            error: null,
            response: { status: 201 },
          };
        }

        return { data: null, error: null };
      });

      mockPrepareOutboundMegolm.mockResolvedValueOnce({
        sessionId: 'meg-sess-1',
        toDeviceMessages: [
          { deviceId: 'peer-dev-001', ciphertext: 'to-dev-cipher-1' },
          { deviceId: 'peer-dev-002', ciphertext: 'to-dev-cipher-2' },
        ],
      });

      mockEncryptMessage.mockResolvedValueOnce({
        megolmSessionId: 'meg-sess-1',
        ciphertext: 'cipher-msg-1',
        messageIndex: 0,
      });

      const res = await service.sendMessage({
        conversation: mockConversation,
        text: 'Xin chào bạn!',
      });

      // Verify allMemberDevices received by prepareOutboundMegolm
      expect(mockPrepareOutboundMegolm).toHaveBeenCalledWith({
        conversationId: 'conv-test-123',
        memberDevices: [
          {
            userId: 'my-user-id',
            deviceId: 'my-dev-001',
            curve25519: 'my-curve-key',
            ed25519: 'my-ed-key',
          },
          {
            userId: 'peer-user-id',
            deviceId: 'peer-dev-001',
            curve25519: 'peer-curve-key-1',
            ed25519: 'peer-ed-key-1',
          },
          {
            userId: 'peer-user-id',
            deviceId: 'peer-dev-002',
            curve25519: 'peer-curve-key-2',
            ed25519: 'peer-ed-key-2',
          },
        ],
        claimedKeys: {
          'peer-dev-001': {
            keyId: 'otk-1',
            publicKey: 'otk-pub-1',
          },
        },
      });

      // Verify to-device batch dispatch
      expect(mockChatPost).toHaveBeenCalledWith(
        '/v1/chat/to-device',
        expect.objectContaining({
          body: {
            sender_device_id: 'my-dev-001',
            messages: [
              { device_id: 'peer-dev-001', ciphertext: 'to-dev-cipher-1' },
              { device_id: 'peer-dev-002', ciphertext: 'to-dev-cipher-2' },
            ],
          },
        }),
      );

      // Verify returned decrypted message
      expect(res.message.id).toBe('msg-001');
      expect(res.plaintext).toBe('Xin chào bạn!');
      expect(res.status).toBe('DECRYPTED');
    });

    it('throws error when device is not configured', async () => {
      mockGetDeviceId.mockReturnValueOnce(null);

      await expect(
        service.sendMessage({
          conversation: mockConversation,
          text: 'test',
        }),
      ).rejects.toThrow('Chưa thiết lập thiết bị nhắn tin bảo mật.');
    });

    it('throws error when conversation is REQUESTED', async () => {
      const requestedConv: Conversation = {
        ...mockConversation,
        my_state: 'REQUESTED',
      };

      await expect(
        service.sendMessage({
          conversation: requestedConv,
          text: 'test',
        }),
      ).rejects.toThrow('Vui lòng chấp nhận lời mời để gửi tin nhắn.');
    });

    it('throws error when /v1/chat/devices/query fails', async () => {
      mockChatPost.mockImplementation(async (endpoint: string) => {
        if (endpoint === '/v1/chat/devices/query') {
          return {
            data: null,
            error: { detail: 'Internal server error' },
          };
        }
        return { data: null, error: null };
      });

      await expect(
        service.sendMessage({
          conversation: mockConversation,
          text: 'test',
        }),
      ).rejects.toThrow('Không thể truy vấn khoá thiết bị của thành viên.');
    });

    it('handles HTTP error statuses 403, 409, 429 correctly when posting message', async () => {
      mockChatPost.mockImplementation(async (endpoint: string) => {
        if (endpoint === '/v1/chat/devices/query') {
          return {
            data: { users: [] },
            error: null,
          };
        }
        if (endpoint === '/v1/chat/conversations/{conversation_id}/messages') {
          return {
            data: null,
            error: { detail: 'Forbidden' },
            response: { status: 403 },
          };
        }
        return { data: null, error: null };
      });

      mockPrepareOutboundMegolm.mockResolvedValueOnce({
        sessionId: 'meg-sess-1',
        toDeviceMessages: [],
      });
      mockEncryptMessage.mockResolvedValueOnce({
        megolmSessionId: 'meg-sess-1',
        ciphertext: 'cipher',
        messageIndex: 0,
      });

      await expect(
        service.sendMessage({
          conversation: mockConversation,
          text: 'hello',
        }),
      ).rejects.toThrow('Không thể gửi tin nhắn do quan hệ chặn hoặc chưa được chấp nhận.');

      // Test 409
      mockChatPost.mockImplementation(async (endpoint: string) => {
        if (endpoint === '/v1/chat/devices/query') return { data: { users: [] }, error: null };
        if (endpoint === '/v1/chat/conversations/{conversation_id}/messages') {
          return { data: null, error: { detail: 'Conflict' }, response: { status: 409 } };
        }
        return { data: null, error: null };
      });
      mockPrepareOutboundMegolm.mockResolvedValueOnce({ sessionId: 's', toDeviceMessages: [] });
      mockEncryptMessage.mockResolvedValueOnce({
        megolmSessionId: 's',
        ciphertext: 'c',
        messageIndex: 0,
      });

      await expect(
        service.sendMessage({
          conversation: mockConversation,
          text: 'hello',
        }),
      ).rejects.toThrow('Cuộc trò chuyện này đã kết thúc do đối phương đã rời đi.');

      // Test 429
      mockChatPost.mockImplementation(async (endpoint: string) => {
        if (endpoint === '/v1/chat/devices/query') return { data: { users: [] }, error: null };
        if (endpoint === '/v1/chat/conversations/{conversation_id}/messages') {
          return { data: null, error: { detail: 'Rate limit' }, response: { status: 429 } };
        }
        return { data: null, error: null };
      });
      mockPrepareOutboundMegolm.mockResolvedValueOnce({ sessionId: 's', toDeviceMessages: [] });
      mockEncryptMessage.mockResolvedValueOnce({
        megolmSessionId: 's',
        ciphertext: 'c',
        messageIndex: 0,
      });

      await expect(
        service.sendMessage({
          conversation: mockConversation,
          text: 'hello',
        }),
      ).rejects.toThrow('Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau giây lát.');
    });
  });
});
