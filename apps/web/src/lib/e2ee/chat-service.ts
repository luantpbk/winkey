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
import { parseChatEvent, serializeTextEvent, type AttachmentRef } from './events';
import {
  isRoomEvent,
  parseCallEvent,
  type CallDeviceEvent,
  type CallRoomEvent,
} from '../calls/events';

/** A call event that reached this device, already validated (SOC-4a). */
export interface IncomingCallSignal {
  event: CallRoomEvent | CallDeviceEvent;
  senderId: string;
  senderDeviceId: string;
  conversationId?: string;
  /** Megolm events: when chat-svc stored them (rings only for fresh invites). */
  sentAt?: string;
  seq?: number;
}

export interface DecryptedMessageItem {
  message: Message;
  plaintext: string | null;
  status: 'DECRYPTED' | 'WAITING_FOR_KEY' | 'SYSTEM' | 'DELETED' | 'UNSUPPORTED' | 'ERROR' | 'CALL';
  /** SOC-4a: a call event in the history (invite, answer, reject, hangup), rendered as a call line. */
  callEvent?: CallRoomEvent;
  error?: string;
  /** SOC-3b: files carried by the encrypted event, validated (events.ts). Lives only on this device. */
  attachments?: AttachmentRef[];
}

export class ChatService {
  private deviceManager = getDeviceManager();
  private e2eeClient = getE2eeClient();
  private processingToDevice = false;
  private toDeviceRun: Promise<string[]> | null = null;
  private callListeners = new Set<(signal: IncomingCallSignal) => void>();

  /** SOC-4a: to-device call events are delivered here (validated), whoever triggered the fetch. */
  onCallSignal(listener: (signal: IncomingCallSignal) => void): () => void {
    this.callListeners.add(listener);
    return () => this.callListeners.delete(listener);
  }

  private emitCallSignal(signal: IncomingCallSignal): void {
    for (const listener of this.callListeners) {
      try {
        listener(signal);
      } catch (err) {
        console.warn('[ChatService] call listener failed', err);
      }
    }
  }

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
  /**
   * Concurrent callers (chat page, CallProvider) share the run in flight, so whoever waits for it knows the new
   * Megolm keys are imported when it resolves (SOC-4a: an answer must not be read before its key arrived).
   */
  async processToDeviceMessages(): Promise<string[]> {
    if (this.toDeviceRun) return this.toDeviceRun;
    this.toDeviceRun = this.runToDevice().finally(() => {
      this.toDeviceRun = null;
    });
    return this.toDeviceRun;
  }

  private async runToDevice(): Promise<string[]> {
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
        for (const e of decryptResult.events ?? []) {
          const event = parseCallEvent(e.event);
          if (event && !isRoomEvent(event)) {
            this.emitCallSignal({ event, senderId: e.senderId, senderDeviceId: e.senderDeviceId });
          }
        }

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

    const event = parseChatEvent(result.plaintext);
    if (!event) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(result.plaintext);
      } catch {
        // not JSON: unsupported below
      }
      const callEvent = parseCallEvent(parsed);
      if (callEvent && isRoomEvent(callEvent)) {
        return { message: msg, plaintext: null, status: 'CALL', callEvent };
      }
      return { message: msg, plaintext: null, status: 'UNSUPPORTED' };
    }
    // An attachment the server no longer lists (deleted, expired by the janitor) is still shown from the event,
    // and its download answers 404 / 410.
    return {
      message: msg,
      plaintext: event.body,
      status: 'DECRYPTED',
      ...(event.attachments ? { attachments: event.attachments } : {}),
    };
  }

  /**
   * Encrypts and sends a message to a conversation.
   * Ensures outbound Megolm session is shared with all member devices via to-device messages.
   */
  async sendMessage(params: {
    conversation: Conversation;
    text: string;
    clientMsgId?: string;
    attachments?: AttachmentRef[];
    /** SOC-4a: send a call event (invite, answer, reject, hangup) instead of a text event. */
    callEvent?: CallRoomEvent;
  }): Promise<DecryptedMessageItem> {
    const { conversation, text, attachments = [], callEvent } = params;
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
    const plaintextPayload = callEvent
      ? JSON.stringify(callEvent)
      : serializeTextEvent(text, attachments);

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
        ...(attachments.length > 0 ? { attachment_ids: attachments.map((a) => a.id) } : {}),
      },
    });

    if (sendErr || !msgData) {
      if (response.status === 403) {
        throw new Error('Không thể gửi tin nhắn do quan hệ chặn hoặc chưa được chấp nhận.');
      }
      if (response.status === 409 && sendErr?.code === 'ATTACHMENT_UNAVAILABLE') {
        throw new Error('Một tệp đính kèm đã hết hạn hoặc không còn, hãy đính kèm lại.');
      }
      if (response.status === 409) {
        throw new Error('Cuộc trò chuyện này đã kết thúc do đối phương đã rời đi.');
      }
      if (response.status === 429) {
        throw new Error('Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau giây lát.');
      }
      throw new Error(sendErr?.detail || 'Không thể gửi tin nhắn.');
    }

    if (callEvent) {
      return { message: msgData, plaintext: null, status: 'CALL', callEvent };
    }

    return {
      message: msgData,
      plaintext: text,
      status: 'DECRYPTED',
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  /**
   * SOC-4a: Olm-encrypted to-device event to some devices of `userIds` (all of them when `deviceIds` is omitted),
   * claiming one-time keys only for devices this device has no Olm session with yet.
   */
  async sendToDevice(params: {
    userIds: string[];
    deviceIds?: string[];
    event: CallDeviceEvent;
  }): Promise<void> {
    const senderDeviceId = this.deviceManager.getDeviceId();
    if (!senderDeviceId) throw new Error('Chưa thiết lập thiết bị nhắn tin bảo mật.');
    const { data } = await api.chat.POST('/v1/chat/devices/query', {
      body: { user_ids: params.userIds },
    });
    const targets: MemberDeviceRef[] = [];
    for (const u of data?.users ?? []) {
      for (const d of u.devices ?? []) {
        if (d.id === senderDeviceId) continue;
        if (params.deviceIds && !params.deviceIds.includes(d.id)) continue;
        targets.push({
          userId: u.user_id,
          deviceId: d.id,
          curve25519: d.curve25519_key,
          ed25519: d.ed25519_key,
        });
      }
    }
    if (targets.length === 0) return;

    const first = await this.e2eeClient.encryptToDevice({
      targets,
      claimedKeys: {},
      event: params.event,
    });
    const { needKeys } = first;
    let messages = first.messages;
    if (needKeys.length > 0) {
      const { data: claim } = await api.chat.POST('/v1/chat/keys/claim', {
        body: { device_ids: needKeys },
      });
      const claimedKeys: Record<string, ClaimedOtkRef> = {};
      for (const k of claim?.keys ?? [])
        claimedKeys[k.device_id] = { keyId: k.key_id, publicKey: k.public_key };
      const second = await this.e2eeClient.encryptToDevice({
        targets: targets.filter((t) => needKeys.includes(t.deviceId)),
        claimedKeys,
        event: params.event,
      });
      messages = [...messages, ...second.messages];
    }
    if (messages.length === 0) return;
    await api.chat.POST('/v1/chat/to-device', {
      body: {
        sender_device_id: senderDeviceId,
        messages: messages.map((m) => ({ device_id: m.deviceId, ciphertext: m.ciphertext })),
      },
    });
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
