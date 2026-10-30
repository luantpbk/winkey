/**
 * High-level Chat Service for Winkey E2EE (ADR-049 §5 / SOC-3a)
 *
 * Coordinates:
 * - Device registration and key replenishment via DeviceManager
 * - Worker encryption/decryption RPC via E2eeClient
 * - Network REST communication via api.chat
 * - To-device batching and message retry
 */

import { api } from '../api-client';
import { getDeviceManager } from './device-manager';
import { getE2eeClient } from './client';
import type { Conversation, ConversationPage, Message, ToDeviceMessage } from '@winkey/api-client';
import type { MemberDeviceRef, ClaimedOtkRef } from './protocol';
import { getKeyBackupService } from './key-backup-service';

export interface DecryptedMessageItem {
  message: Message;
  plaintext: string | null;
  status: 'DECRYPTED' | 'WAITING_FOR_KEY' | 'SYSTEM' | 'DELETED' | 'UNSUPPORTED' | 'ERROR';
  error?: string;
}

export class ChatService {
  private deviceManager = getDeviceManager();
  private e2eeClient = getE2eeClient();
  private processingToDevice = false;

  async ensureReady(userId: string): Promise<string> {
    return this.deviceManager.ensureDeviceRegistered(userId);
  }

  getDeviceId(): string | null {
    return this.deviceManager.getDeviceId();
  }

  async listConversations(
    state: 'ACTIVE' | 'REQUESTED' = 'ACTIVE',
    cursor?: string,
  ): Promise<ConversationPage> {
    const { data, error } = await api.chat.GET('/v1/chat/conversations', {
      params: {
        query: {
          state,
          cursor,
          limit: 30,
        },
      },
    });

    if (error || !data) {
      throw new Error(error?.detail || 'Không thể tải danh sách cuộc trò chuyện.');
    }

    return data;
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    const { data, error } = await api.chat.GET('/v1/chat/conversations/{conversation_id}', {
      params: { path: { conversation_id: conversationId } },
    });

    if (error || !data) {
      throw new Error(error?.detail || 'Không thể tải thông tin cuộc trò chuyện.');
    }

    return data;
  }

  async createConversation(params: {
    kind: 'DIRECT' | 'GROUP';
    userIds: string[];
    title?: string;
  }): Promise<Conversation> {
    const { data, error, response } = await api.chat.POST('/v1/chat/conversations', {
      body: {
        kind: params.kind,
        user_ids: params.userIds,
        title: params.kind === 'GROUP' ? params.title || 'Nhóm mới' : undefined,
      },
    });

    if (error || !data) {
      if (response.status === 403) {
        throw new Error('Không thể tạo cuộc trò chuyện do quan hệ chặn giữa người dùng.');
      }
      throw new Error(error?.detail || 'Không thể tạo cuộc trò chuyện.');
    }

    return data;
  }

  /**
   * Process pending to-device messages: fetches, decrypts in worker, imports Megolm keys, and ACKs.
   */
  async processToDeviceMessages(): Promise<string[]> {
    const deviceId = this.deviceManager.getDeviceId();
    if (!deviceId || this.processingToDevice) {
      return [];
    }

    this.processingToDevice = true;
    const newSessionIds: string[] = [];

    try {
      let hasMore = true;
      let afterSeq: string | undefined = undefined;

      while (hasMore) {
        const toDeviceRes = await api.chat.GET('/v1/chat/devices/{device_id}/to-device', {
          params: {
            path: { device_id: deviceId },
            query: afterSeq ? { after: afterSeq, limit: 100 } : { limit: 100 },
          },
        });

        const data = toDeviceRes.data as
          { items: ToDeviceMessage[]; has_more: boolean } | undefined;
        const error = toDeviceRes.error;

        if (error || !data || data.items.length === 0) {
          break;
        }

        hasMore = data.has_more;
        afterSeq = data.items[data.items.length - 1].id;

        // Query sender curve25519 keys
        const senderUserIds: string[] = Array.from(
          new Set(data.items.map((m: ToDeviceMessage) => m.sender_id)),
        );
        const { data: usersData } = await api.chat.POST('/v1/chat/devices/query', {
          body: { user_ids: senderUserIds },
        });

        const deviceKeyMap = new Map<string, string>();
        if (usersData?.users) {
          for (const u of usersData.users) {
            for (const d of u.devices || []) {
              deviceKeyMap.set(d.id, d.curve25519_key);
            }
          }
        }

        const workerPayload = data.items.map((item: ToDeviceMessage) => ({
          id: item.id,
          senderId: item.sender_id,
          senderDeviceId: item.sender_device_id,
          senderCurve25519: deviceKeyMap.get(item.sender_device_id),
          ciphertext: item.ciphertext,
        }));

        const decryptResult = await this.e2eeClient.decryptToDeviceBatch(workerPayload);
        newSessionIds.push(...decryptResult.newMegolmSessionIds);

        // ACK processed to-device messages
        if (decryptResult.processedIds.length > 0) {
          const maxAckId = decryptResult.processedIds[decryptResult.processedIds.length - 1];
          await api.chat.POST('/v1/chat/devices/{device_id}/to-device/ack', {
            params: { path: { device_id: deviceId } },
            body: { up_to: maxAckId },
          });
        }
      }
    } catch (err) {
      console.warn('[ChatService] Error processing to-device messages:', err);
    } finally {
      this.processingToDevice = false;
    }

    // SOC-3b: new inbound sessions go to the key backup (a no-op while the backup is off or locked).
    if (newSessionIds.length > 0) getKeyBackupService().scheduleUpload();

    return newSessionIds;
  }

  async fetchMessages(
    conversationId: string,
    options?: { after_seq?: number; before_seq?: number; limit?: number },
  ): Promise<{ items: DecryptedMessageItem[]; has_more: boolean }> {
    const { data, error } = await api.chat.GET(
      '/v1/chat/conversations/{conversation_id}/messages',
      {
        params: {
          path: { conversation_id: conversationId },
          query: options,
        },
      },
    );

    if (error || !data) {
      throw new Error(error?.detail || 'Không thể tải tin nhắn.');
    }

    const decryptedItems = await Promise.all(
      data.items.map((msg) => this.decryptMessageItem(conversationId, msg)),
    );

    return {
      items: decryptedItems,
      has_more: data.has_more,
    };
  }

  async decryptMessageItem(conversationId: string, msg: Message): Promise<DecryptedMessageItem> {
    if (msg.kind === 'SYSTEM') {
      return { message: msg, plaintext: null, status: 'SYSTEM' };
    }

    if (msg.deleted || !msg.ciphertext) {
      return { message: msg, plaintext: null, status: 'DELETED' };
    }

    if (!msg.megolm_session_id) {
      return { message: msg, plaintext: null, status: 'WAITING_FOR_KEY' };
    }

    const result = await this.e2eeClient.decryptGroupMessage(
      conversationId,
      msg.megolm_session_id,
      msg.ciphertext,
    );

    if (result.status === 'WAITING_FOR_KEY') {
      return { message: msg, plaintext: null, status: 'WAITING_FOR_KEY' };
    }

    if (result.status === 'ERROR') {
      return { message: msg, plaintext: null, status: 'ERROR', error: result.error };
    }

    try {
      const parsed = JSON.parse(result.plaintext);
      if (parsed?.type === 'text' && typeof parsed.body === 'string') {
        return {
          message: msg,
          plaintext: parsed.body,
          status: 'DECRYPTED',
        };
      }
      return {
        message: msg,
        plaintext: null,
        status: 'UNSUPPORTED',
      };
    } catch {
      return {
        message: msg,
        plaintext: result.plaintext,
        status: 'DECRYPTED',
      };
    }
  }

  /**
   * Encrypts and sends a message to a conversation.
   * Ensures outbound Megolm session is shared with all member devices via to-device messages.
   */
  async sendMessage(params: {
    conversation: Conversation;
    text: string;
    clientMsgId?: string;
  }): Promise<DecryptedMessageItem> {
    const { conversation, text } = params;
    const clientMsgId = params.clientMsgId || crypto.randomUUID();

    const senderDeviceId = this.deviceManager.getDeviceId();
    if (!senderDeviceId) {
      throw new Error('Chưa thiết lập thiết bị nhắn tin bảo mật.');
    }

    if (conversation.my_state === 'REQUESTED') {
      throw new Error('Vui lòng chấp nhận lời mời để gửi tin nhắn.');
    }

    // 1. Query active member devices (ACTIVE and REQUESTED)
    const memberUserIds = conversation.members
      .filter((m) => m.state === 'ACTIVE' || m.state === 'REQUESTED')
      .map((m) => m.user_id);

    const { data: devicesData, error: devQueryErr } = await api.chat.POST(
      '/v1/chat/devices/query',
      {
        body: { user_ids: memberUserIds },
      },
    );

    if (devQueryErr || !devicesData) {
      throw new Error('Không thể truy vấn khoá thiết bị của thành viên.');
    }

    const allMemberDevices: MemberDeviceRef[] = [];
    for (const u of devicesData.users || []) {
      for (const d of u.devices || []) {
        allMemberDevices.push({
          userId: u.user_id,
          deviceId: d.id,
          curve25519: d.curve25519_key,
          ed25519: d.ed25519_key,
        });
      }
    }

    // 2. Claim one-time keys for devices that might need an Olm session
    // Batching max 200 device ids
    const targetDeviceIds = allMemberDevices
      .map((d) => d.deviceId)
      .filter((id) => id !== senderDeviceId);

    const claimedKeys: Record<string, ClaimedOtkRef> = {};
    if (targetDeviceIds.length > 0) {
      const { data: claimData } = await api.chat.POST('/v1/chat/keys/claim', {
        body: { device_ids: targetDeviceIds.slice(0, 200) },
      });

      if (claimData?.keys) {
        for (const k of claimData.keys) {
          claimedKeys[k.device_id] = {
            keyId: k.key_id,
            publicKey: k.public_key,
          };
        }
      }
    }

    // 3. Worker prepares Megolm outbound session and generates Olm to-device envelopes
    const prepResult = await this.e2eeClient.prepareOutboundMegolm({
      conversationId: conversation.id,
      memberDevices: allMemberDevices,
      claimedKeys,
    });

    // 4. Send to-device messages if a new session was created or rotated
    if (prepResult.toDeviceMessages.length > 0) {
      // Our own copy of the new session is an inbound session too: back it up (SOC-3b).
      getKeyBackupService().scheduleUpload();
      // Batch up to 200 per call as per contract
      const batchSize = 200;
      for (let i = 0; i < prepResult.toDeviceMessages.length; i += batchSize) {
        const batch = prepResult.toDeviceMessages.slice(i, i + batchSize);
        const { error: tdErr } = await api.chat.POST('/v1/chat/to-device', {
          body: {
            sender_device_id: senderDeviceId,
            messages: batch.map((m) => ({
              device_id: m.deviceId,
              ciphertext: m.ciphertext,
            })),
          },
        });

        if (tdErr) {
          console.warn('[ChatService] Warning sending to-device batch:', tdErr);
        }
      }
    }

    // 5. Encrypt message plaintext: JSON {"type":"text","body":"..."}
    const plaintextPayload = JSON.stringify({
      type: 'text',
      body: text.slice(0, 4000),
    });

    const encResult = await this.e2eeClient.encryptMessage(conversation.id, plaintextPayload);

    // 6. Post Megolm-encrypted message to chat-svc
    const {
      data: msgData,
      error: sendErr,
      response,
    } = await api.chat.POST('/v1/chat/conversations/{conversation_id}/messages', {
      params: { path: { conversation_id: conversation.id } },
      body: {
        client_msg_id: clientMsgId,
        sender_device_id: senderDeviceId,
        megolm_session_id: encResult.megolmSessionId,
        ciphertext: encResult.ciphertext,
      },
    });

    if (sendErr || !msgData) {
      if (response.status === 403) {
        throw new Error('Không thể gửi tin nhắn do quan hệ chặn hoặc chưa được chấp nhận.');
      }
      if (response.status === 409) {
        throw new Error('Cuộc trò chuyện này đã kết thúc do đối phương đã rời đi.');
      }
      if (response.status === 429) {
        throw new Error('Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau giây lát.');
      }
      throw new Error(sendErr?.detail || 'Không thể gửi tin nhắn.');
    }

    return {
      message: msgData,
      plaintext: text,
      status: 'DECRYPTED',
    };
  }

  async deleteMessage(conversationId: string, seq: number): Promise<void> {
    const { error } = await api.chat.DELETE(
      '/v1/chat/conversations/{conversation_id}/messages/{seq}',
      {
        params: {
          path: {
            conversation_id: conversationId,
            seq,
          },
        },
      },
    );

    if (error) {
      throw new Error(error?.detail || 'Không thể xoá tin nhắn.');
    }
  }

  async markRead(conversationId: string, seq: number): Promise<void> {
    await api.chat.POST('/v1/chat/conversations/{conversation_id}/read', {
      params: { path: { conversation_id: conversationId } },
      body: { seq },
    });
  }

  async acceptConversation(conversationId: string): Promise<Conversation> {
    const { data, error } = await api.chat.POST('/v1/chat/conversations/{conversation_id}/accept', {
      params: { path: { conversation_id: conversationId } },
    });

    if (error || !data) {
      throw new Error(error?.detail || 'Không thể chấp nhận lời mời nhắn tin.');
    }

    return data;
  }

  async leaveOrRemoveMember(conversationId: string, userId: string): Promise<void> {
    const { error } = await api.chat.DELETE(
      '/v1/chat/conversations/{conversation_id}/members/{user_id}',
      {
        params: {
          path: {
            conversation_id: conversationId,
            user_id: userId,
          },
        },
      },
    );

    if (error) {
      throw new Error(error?.detail || 'Không thể rời nhóm hoặc xoá thành viên.');
    }
  }

  async updateGroupTitle(conversationId: string, title: string): Promise<Conversation> {
    const { data, error } = await api.chat.PATCH('/v1/chat/conversations/{conversation_id}', {
      params: { path: { conversation_id: conversationId } },
      body: { title },
    });

    if (error || !data) {
      throw new Error(error?.detail || 'Không thể cập nhật tên nhóm.');
    }

    return data;
  }

  async addMembers(conversationId: string, userIds: string[]): Promise<Conversation> {
    const { data, error } = await api.chat.POST(
      '/v1/chat/conversations/{conversation_id}/members',
      {
        params: { path: { conversation_id: conversationId } },
        body: { user_ids: userIds },
      },
    );

    if (error || !data) {
      throw new Error(error?.detail || 'Không thể thêm thành viên vào nhóm.');
    }

    return data;
  }
}

let chatServiceInstance: ChatService | null = null;

export function getChatService(): ChatService {
  if (!chatServiceInstance) {
    chatServiceInstance = new ChatService();
  }
  return chatServiceInstance;
}
