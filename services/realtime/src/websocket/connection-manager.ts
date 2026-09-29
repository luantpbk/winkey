import { WebSocket } from 'ws';
import { v7 as uuidv7 } from 'uuid';
import {
  validateClientMessage,
  type ServerMessage,
  type ServerEventName,
} from '../schemas/validation.js';
import type { VideoClient } from '../video/video-client.js';

export interface ConnectionMeta {
  userId: string | null;
  roles: string[];
}

export interface ConnectionManagerOptions {
  videoClient: VideoClient;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxRoomsPerConnection?: number;
  maxConnectionsPerUser?: number;
  logger?: {
    info: (obj: Record<string, unknown> | string, msg?: string) => void;
    warn: (obj: Record<string, unknown> | string, msg?: string) => void;
    error: (obj: Record<string, unknown> | string, msg?: string) => void;
    debug?: (obj: Record<string, unknown> | string, msg?: string) => void;
  };
}

class ManagedConnection {
  public readonly id: string;
  public readonly ws: WebSocket;
  public readonly userId: string | null;
  public readonly roles: string[];
  public readonly rooms = new Set<string>();

  public lastPongReceivedAt: number;
  public consecutiveBadMessages = 0;

  // Rate limiting
  private currentSec = 0;
  private msgCountInSec = 0;
  private consecutiveRateLimitSecs = 0;

  // Outbound queue buffer (max 256)
  private outboundQueue: string[] = [];
  private isFlushing = false;

  constructor(id: string, ws: WebSocket, meta: ConnectionMeta) {
    this.id = id;
    this.ws = ws;
    this.userId = meta.userId;
    this.roles = meta.roles;
    this.lastPongReceivedAt = Date.now();
  }

  checkRateLimit(msgId: string | null): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec === this.currentSec) {
      this.msgCountInSec++;
    } else {
      if (this.msgCountInSec > 20) {
        this.consecutiveRateLimitSecs++;
      } else {
        this.consecutiveRateLimitSecs = 0;
      }
      this.currentSec = nowSec;
      this.msgCountInSec = 1;
    }

    if (this.consecutiveRateLimitSecs >= 5) {
      this.close(4429, 'Rate limit exceeded continuously');
      return false;
    }

    if (this.msgCountInSec > 20) {
      this.send({
        type: 'error',
        id: msgId,
        code: 'RATE_LIMITED',
        message: 'Message rate limit exceeded (20 msgs/s)',
      });
      return false;
    }

    return true;
  }

  send(msg: ServerMessage, onDropped?: () => void): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = JSON.stringify(msg);

    if (this.outboundQueue.length >= 256) {
      // Drop oldest message to protect memory buffer
      this.outboundQueue.shift();
      onDropped?.();
    }

    this.outboundQueue.push(payload);
    this.flushQueue();
  }

  private flushQueue(): void {
    if (this.isFlushing || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.isFlushing = true;
    while (this.outboundQueue.length > 0 && this.ws.readyState === WebSocket.OPEN) {
      const item = this.outboundQueue.shift();
      if (item !== undefined) {
        this.ws.send(item);
      }
    }
    this.isFlushing = false;
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason.slice(0, 120));
    } catch {
      // Ignore errors on closing
    }
  }
}

export class ConnectionManager {
  private readonly videoClient: VideoClient;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxRoomsPerConnection: number;
  private readonly maxConnectionsPerUser: number;
  private readonly logger: ConnectionManagerOptions['logger'];

  private readonly connections = new Map<string, ManagedConnection>();
  private readonly userConnections = new Map<string, Set<string>>();
  private readonly roomSubscriptions = new Map<string, Set<string>>();

  private heartbeatInterval: NodeJS.Timeout | null = null;
  public droppedMessagesTotal = 0;

  constructor(options: ConnectionManagerOptions) {
    this.videoClient = options.videoClient;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60000;
    this.maxRoomsPerConnection = options.maxRoomsPerConnection ?? 50;
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? 5;
    this.logger = options.logger;

    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const conn of this.connections.values()) {
        if (now - conn.lastPongReceivedAt > this.heartbeatTimeoutMs) {
          this.logger?.info(
            { connectionId: conn.id },
            'Connection heartbeat timed out, closing 4408',
          );
          conn.close(4408, 'Heartbeat timeout');
          this.removeConnection(conn.id);
          continue;
        }

        if (conn.ws.readyState === WebSocket.OPEN) {
          try {
            conn.ws.ping();
          } catch {
            // Ignore ping errors
          }
        }
      }
    }, this.heartbeatIntervalMs);
  }

  handleNewConnection(ws: WebSocket, meta: ConnectionMeta): string | null {
    const connectionId = uuidv7();

    // Enforce 5 connections per user limit
    if (meta.userId) {
      const existingUserConns = this.userConnections.get(meta.userId);
      if (existingUserConns && existingUserConns.size >= this.maxConnectionsPerUser) {
        this.logger?.warn(
          { userId: meta.userId },
          'User exceeded maximum connection limit, closing 4429',
        );
        // Accept and immediately close with 4429
        ws.close(4429, 'Too many connections for this user');
        return null;
      }
    }

    const conn = new ManagedConnection(connectionId, ws, meta);
    this.connections.set(connectionId, conn);

    if (meta.userId) {
      let userSet = this.userConnections.get(meta.userId);
      if (!userSet) {
        userSet = new Set<string>();
        this.userConnections.set(meta.userId, userSet);
      }
      userSet.add(connectionId);

      // Authenticated users automatically join user:{user_id}
      const userRoom = `user:${meta.userId}`;
      this.subscribeRoomInternal(conn, userRoom);
    }

    // Send welcome frame first
    conn.send({
      type: 'welcome',
      connection_id: connectionId,
      user_id: meta.userId,
      heartbeat_interval_ms: this.heartbeatIntervalMs,
    });

    ws.on('pong', () => {
      conn.lastPongReceivedAt = Date.now();
    });

    ws.on('message', async (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      await this.handleClientFrame(conn, data, isBinary);
    });

    ws.on('close', () => {
      this.removeConnection(connectionId);
    });

    ws.on('error', () => {
      this.removeConnection(connectionId);
    });

    return connectionId;
  }

  private async handleClientFrame(
    conn: ManagedConnection,
    raw: Buffer | ArrayBuffer | Buffer[],
    isBinary: boolean,
  ): Promise<void> {
    // 1. Binary or oversized frame check (4 KiB max)
    const rawBuffer = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw);

    if (isBinary || rawBuffer.length > 4096) {
      this.handleBadMessage(
        conn,
        null,
        'Binary frames or frames larger than 4 KiB are not allowed',
      );
      return;
    }

    // 2. Parse UTF-8 JSON
    let parsed: unknown;
    try {
      const text = rawBuffer.toString('utf-8');
      parsed = JSON.parse(text);
    } catch {
      this.handleBadMessage(conn, null, 'Frame is not valid JSON');
      return;
    }

    // 3. Schema validation with ajv against client.schema.json
    const validation = validateClientMessage(parsed);
    if (!validation.valid || !validation.message) {
      const msgId =
        typeof parsed === 'object' &&
        parsed !== null &&
        'id' in parsed &&
        typeof (parsed as { id: unknown }).id === 'string'
          ? (parsed as { id: string }).id
          : null;
      this.handleBadMessage(
        conn,
        msgId,
        validation.error || 'Message does not conform to client schema',
      );
      return;
    }

    // Reset bad message count on valid client message
    conn.consecutiveBadMessages = 0;

    const msg = validation.message;

    // 4. Rate limit check (20 msgs/s)
    if (!conn.checkRateLimit(msg.id)) {
      return;
    }

    // 5. Handle message types
    if (msg.type === 'ping') {
      conn.send({ type: 'pong', id: msg.id });
      return;
    }

    if (msg.type === 'unsubscribe') {
      this.unsubscribeRoomInternal(conn, msg.room);
      conn.send({ type: 'ack', id: msg.id });
      return;
    }

    if (msg.type === 'subscribe') {
      await this.handleSubscribe(conn, msg.id, msg.room);
    }
  }

  private handleBadMessage(conn: ManagedConnection, msgId: string | null, message: string): void {
    conn.consecutiveBadMessages++;
    if (conn.consecutiveBadMessages >= 5) {
      conn.close(4400, 'Too many bad messages');
      this.removeConnection(conn.id);
      return;
    }

    conn.send({
      type: 'error',
      id: msgId,
      code: 'BAD_MESSAGE',
      message: message.slice(0, 200),
    });
  }

  private async handleSubscribe(
    conn: ManagedConnection,
    msgId: string,
    room: string,
  ): Promise<void> {
    // Check if already in room -> idempotent ack
    if (conn.rooms.has(room)) {
      conn.send({ type: 'ack', id: msgId });
      return;
    }

    // Max 50 rooms per connection limit
    if (conn.rooms.size >= this.maxRoomsPerConnection) {
      conn.send({
        type: 'error',
        id: msgId,
        code: 'TOO_MANY_ROOMS',
        message: 'Maximum 50 rooms per connection reached',
      });
      return;
    }

    if (room.startsWith('upload:')) {
      if (!conn.userId) {
        conn.send({
          type: 'error',
          id: msgId,
          code: 'AUTH_REQUIRED',
          message: 'Authentication required for upload rooms',
        });
        return;
      }

      this.subscribeRoomInternal(conn, room);
      conn.send({ type: 'ack', id: msgId });
      return;
    }

    if (room.startsWith('video:')) {
      const videoId = room.slice('video:'.length);
      const allowed = await this.videoClient.canAccessVideo({
        videoId,
        userId: conn.userId,
        roles: conn.roles,
      });

      if (!allowed) {
        conn.send({
          type: 'error',
          id: msgId,
          code: 'ROOM_FORBIDDEN',
          message: 'Access to this video room is forbidden',
        });
        return;
      }

      this.subscribeRoomInternal(conn, room);
      conn.send({ type: 'ack', id: msgId });
      return;
    }

    conn.send({
      type: 'error',
      id: msgId,
      code: 'ROOM_INVALID',
      message: 'Invalid room prefix',
    });
  }

  private subscribeRoomInternal(conn: ManagedConnection, room: string): void {
    conn.rooms.add(room);
    let subs = this.roomSubscriptions.get(room);
    if (!subs) {
      subs = new Set<string>();
      this.roomSubscriptions.set(room, subs);
    }
    subs.add(conn.id);
  }

  private unsubscribeRoomInternal(conn: ManagedConnection, room: string): void {
    conn.rooms.delete(room);
    const subs = this.roomSubscriptions.get(room);
    if (subs) {
      subs.delete(conn.id);
      if (subs.size === 0) {
        this.roomSubscriptions.delete(room);
      }
    }
  }

  public removeConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    this.connections.delete(connectionId);

    if (conn.userId) {
      const userConns = this.userConnections.get(conn.userId);
      if (userConns) {
        userConns.delete(connectionId);
        if (userConns.size === 0) {
          this.userConnections.delete(conn.userId);
        }
      }
    }

    for (const room of conn.rooms) {
      const subs = this.roomSubscriptions.get(room);
      if (subs) {
        subs.delete(connectionId);
        if (subs.size === 0) {
          this.roomSubscriptions.delete(room);
        }
      }
    }
  }

  /**
   * Broadcast an event to matching connections in a room.
   * If room is upload:{videoId}, only delivers if connection.userId === eventOwnerId
   * or connection has role moderator/admin.
   */
  broadcastEvent(
    room: string,
    event: ServerEventName,
    data: Record<string, unknown>,
    eventOwnerId?: string,
  ): void {
    const subs = this.roomSubscriptions.get(room);
    if (!subs || subs.size === 0) {
      return;
    }

    const ts = new Date().toISOString();
    const isUploadRoom = room.startsWith('upload:');

    for (const connId of subs) {
      const conn = this.connections.get(connId);
      if (!conn) continue;

      if (isUploadRoom) {
        const isOwner = eventOwnerId && conn.userId === eventOwnerId;
        const isStaff = conn.roles.includes('moderator') || conn.roles.includes('admin');
        if (!isOwner && !isStaff) {
          // Never leak another owner's progress/ready/failed events
          continue;
        }
      }

      conn.send(
        {
          type: 'event',
          room,
          event,
          data,
          ts,
        },
        () => {
          this.droppedMessagesTotal++;
        },
      );
    }
  }

  getConnectionCount(): { total: number; anonymous: number; authenticated: number } {
    let anonymous = 0;
    let authenticated = 0;
    for (const conn of this.connections.values()) {
      if (conn.userId) {
        authenticated++;
      } else {
        anonymous++;
      }
    }
    return {
      total: this.connections.size,
      anonymous,
      authenticated,
    };
  }

  getRoomCount(): number {
    return this.roomSubscriptions.size;
  }

  async closeAll(code = 1001, reason = 'Server shutting down'): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const conn of this.connections.values()) {
      conn.close(code, reason);
    }

    this.connections.clear();
    this.userConnections.clear();
    this.roomSubscriptions.clear();
  }
}
