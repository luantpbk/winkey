/**
 * Strong TypeScript types for Winkey Realtime Gateway protocol.
 * Strictly implements contracts/realtime/client.schema.json & server.schema.json.
 */

// --- Client -> Server Frames ---

export interface ClientSubscribeMessage {
  type: 'subscribe';
  id: string;
  room: string;
}

export interface ClientUnsubscribeMessage {
  type: 'unsubscribe';
  id: string;
  room: string;
}

export interface ClientPingMessage {
  type: 'ping';
  id: string;
}

export type ClientMessage = ClientSubscribeMessage | ClientUnsubscribeMessage | ClientPingMessage;

// --- Server -> Client Frames ---

export interface ServerWelcomeMessage {
  type: 'welcome';
  connection_id: string;
  user_id: string | null;
  heartbeat_interval_ms: number;
}

export interface ServerAckMessage {
  type: 'ack';
  id: string;
}

export type ServerErrorCode =
  | 'BAD_MESSAGE'
  | 'ROOM_INVALID'
  | 'ROOM_FORBIDDEN'
  | 'AUTH_REQUIRED'
  | 'TOO_MANY_ROOMS'
  | 'RATE_LIMITED';

export interface ServerErrorMessage {
  type: 'error';
  id: string | null;
  code: ServerErrorCode;
  message: string;
}

export interface ServerPongMessage {
  type: 'pong';
  id: string;
}

// Event Data Payloads

export interface VideoProgressData {
  video_id: string;
  stage: 'DOWNLOADING' | 'PROBING' | 'TRANSCODING' | 'UPLOADING';
  percent: number;
}

export interface VideoReadyData {
  video_id: string;
}

export interface VideoFailedData {
  video_id: string;
  reason: 'INVALID_INPUT' | 'TIMEOUT' | 'ENCODER_ERROR' | 'STORAGE_ERROR' | 'INTERNAL';
  message: string;
  retryable: boolean;
}

export interface CommentRefData {
  comment_id: string;
  video_id: string;
  parent_id: string | null;
}

export interface LikeCountData {
  video_id: string;
  like_count: number;
}

export interface ServerVideoProgressEvent {
  type: 'event';
  room: string; // upload:{video_id}
  event: 'video.progress';
  data: VideoProgressData;
  ts: string;
}

export interface ServerVideoReadyEvent {
  type: 'event';
  room: string; // upload:{video_id} or user:{user_id}
  event: 'video.ready';
  data: VideoReadyData;
  ts: string;
}

export interface ServerVideoFailedEvent {
  type: 'event';
  room: string; // upload:{video_id} or user:{user_id}
  event: 'video.failed';
  data: VideoFailedData;
  ts: string;
}

export interface ServerCommentCreatedEvent {
  type: 'event';
  room: string; // video:{video_id}
  event: 'comment.created';
  data: CommentRefData;
  ts: string;
}

export interface ServerCommentReplyEvent {
  type: 'event';
  room: string; // user:{user_id}
  event: 'comment.reply';
  data: CommentRefData;
  ts: string;
}

export interface ServerLikeCountEvent {
  type: 'event';
  room: string; // video:{video_id}
  event: 'like.count';
  data: LikeCountData;
  ts: string;
}

export type NotificationHintKind = 'VIDEO_COMMENT' | 'COMMENT_REPLY' | 'NEW_SUBSCRIBER';

export interface NotificationHintData {
  kind: NotificationHintKind;
}

export interface ServerNotificationHintEvent {
  type: 'event';
  room: string; // user:{user_id}
  event: 'notification.hint';
  data: NotificationHintData;
  ts: string;
}

export type ServerEventMessage =
  | ServerVideoProgressEvent
  | ServerVideoReadyEvent
  | ServerVideoFailedEvent
  | ServerCommentCreatedEvent
  | ServerCommentReplyEvent
  | ServerLikeCountEvent
  | ServerNotificationHintEvent;

export type ServerMessage =
  | ServerWelcomeMessage
  | ServerAckMessage
  | ServerErrorMessage
  | ServerPongMessage
  | ServerEventMessage;
