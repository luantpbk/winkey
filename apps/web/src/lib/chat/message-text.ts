import type { Message } from '@winkey/api-client';
import type { DecryptedMessageItem } from '../e2ee/chat-service';
import { describeCallEvent } from '../calls/events';

/** The line shown for a SYSTEM message (group changes, request accepted, …). */
export function systemMessageText(system: Message['system']): string {
  const sys = system as { type?: string; title?: string } | null | undefined;
  switch (sys?.type) {
    case 'conversation_created':
      return 'Đoạn chat đã được tạo';
    case 'member_added':
      return 'Thành viên mới đã được thêm vào nhóm';
    case 'member_left':
      return 'Một thành viên đã rời khỏi nhóm';
    case 'member_removed':
      return 'Một thành viên đã bị xoá khỏi nhóm';
    case 'request_accepted':
      return 'Lời mời nhắn tin đã được chấp nhận';
    case 'title_changed':
      return `Tên nhóm đã đổi thành "${sys.title ?? ''}"`;
    case 'owner_changed':
      return 'Chủ sở hữu nhóm đã thay đổi';
    default:
      return 'Thông báo hệ thống';
  }
}

/**
 * One-line preview of a decrypted message for the conversation list. Built on this device from the decrypted event;
 * never sent anywhere. `waiting` = the key has not arrived yet (retried when to-device keys come in).
 */
export function previewOf(item: DecryptedMessageItem): { text: string; waiting: boolean } {
  switch (item.status) {
    case 'DECRYPTED': {
      const text = (item.plaintext ?? '').replace(/\s+/g, ' ').trim();
      if (text) return { text: text.slice(0, 120), waiting: false };
      const n = item.attachments?.length ?? 0;
      if (n > 0) {
        const allImages = item.attachments!.every((a) => a.mime.startsWith('image/'));
        return { text: allImages ? `Đã gửi ${n} ảnh` : `Đã gửi ${n} tệp`, waiting: false };
      }
      return { text: 'Tin nhắn', waiting: false };
    }
    case 'CALL': {
      const event = item.callEvent;
      const media = event && 'media' in event ? (event.media ?? null) : null;
      const line = event ? describeCallEvent(event, media, false) : null;
      return { text: line ?? 'Cuộc gọi', waiting: false };
    }
    case 'SYSTEM':
      return { text: systemMessageText(item.message.system), waiting: false };
    case 'DELETED':
      return { text: 'Tin nhắn đã bị xoá', waiting: false };
    case 'WAITING_FOR_KEY':
      return { text: 'Tin nhắn mã hoá · đang chờ khoá', waiting: true };
    default:
      return { text: 'Tin nhắn không hiển thị được', waiting: false };
  }
}
