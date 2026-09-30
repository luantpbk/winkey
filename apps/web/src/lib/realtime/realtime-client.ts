/**
 * Realtime WebSocket client manager.
 * Implements lazy connection, ticket flow, backoff with jitter, close code handling,
 * room ref-counting, and AJV schema validation.
 * Strictly adheres to contracts/realtime/README.md.
 */

import { validateServerFrame } from './schema-validator';
import type { ClientMessage, ServerEventMessage, ServerWelcomeMessage } from './realtime-types';

export type RoomEventHandler = (event: ServerEventMessage) => void;
export type ReconnectHandler = () => void;
export type StatusChangeHandler = (connected: boolean) => void;

export interface RealtimeClientOptions {
  getWsUrl?: () => string;
  requestTicket?: () => Promise<string | null>;
  onStatusChange?: StatusChangeHandler;
  WebSocketClass?: typeof WebSocket;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private wsUrlGetter: () => string;
  private requestTicketFn?: () => Promise<string | null>;
  private WebSocketImpl: typeof WebSocket;

  // Connection state
  private isExplicitlyClosed = false;
  private isConnecting = false;
  private isConnected = false;
  private hasConnectedBefore = false;
  private dropAuthUntilReauth = false;
  private connectionId: string | null = null;
  private userId: string | null = null;
  private connectGeneration = 0;

  // Reconnection backoff
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  // Room tracking with ref counts: room -> { count, handlers, reconnectHandlers }
  private rooms = new Map<
    string,
    {
      count: number;
      handlers: Set<RoomEventHandler>;
      reconnectHandlers: Set<ReconnectHandler>;
    }
  >();

  // Global listeners for user:{me} events or status
  private userEventHandlers = new Set<RoomEventHandler>();
  private statusListeners = new Set<StatusChangeHandler>();

  constructor(options: RealtimeClientOptions = {}) {
    this.wsUrlGetter =
      options.getWsUrl ||
      (() => {
        if (typeof window === 'undefined') return 'ws://localhost:8080/v1/realtime';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/v1/realtime`;
      });
    this.requestTicketFn = options.requestTicket;
    this.WebSocketImpl =
      options.WebSocketClass ||
      (typeof WebSocket !== 'undefined' ? WebSocket : (null as unknown as typeof WebSocket));
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30000;

    if (options.onStatusChange) {
      this.statusListeners.add(options.onStatusChange);
    }
  }

  public getIsConnected(): boolean {
    return this.isConnected;
  }

  public getConnectionId(): string | null {
    return this.connectionId;
  }

  public getUserId(): string | null {
    return this.userId;
  }

  public onStatusChange(handler: StatusChangeHandler): () => void {
    this.statusListeners.add(handler);
    return () => {
      this.statusListeners.delete(handler);
    };
  }

  public onUserEvent(handler: RoomEventHandler): () => void {
    this.userEventHandlers.add(handler);
    return () => {
      this.userEventHandlers.delete(handler);
    };
  }

  /**
   * Lazily initiate connection if not already open or connecting.
   */
  public connect(): void {
    if (this.isConnected || this.isConnecting) return;
    this.isExplicitlyClosed = false;
    void this.doConnect();
  }

  /**
   * Close socket and clean up event handlers to prevent ghost events.
   */
  private closeSocket(): void {
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, 'Client closed');
      } catch {
        // ignore
      }
    }
  }

  /**
   * Close connection and prevent auto-reconnect (e.g. unmount / logout).
   */
  public disconnect(): void {
    this.isExplicitlyClosed = true;
    this.connectGeneration++;
    this.hasConnectedBefore = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.setConnectedState(false);
    this.isConnecting = false;
  }

  /**
   * Called when authentication state changes (login / logout)
   * Reconnects so socket identity matches session.
   */
  public handleAuthChange(): void {
    this.dropAuthUntilReauth = false;
    this.connectGeneration++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.setConnectedState(false);
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    if (this.rooms.size > 0) {
      this.connect();
    }
  }

  /**
   * Subscribe to a room with ref-counting. Respects max 50 rooms limit.
   */
  public subscribe(
    room: string,
    onEvent: RoomEventHandler,
    onReconnect?: ReconnectHandler,
  ): () => void {
    let entry = this.rooms.get(room);

    if (!entry) {
      // Respect 50 rooms limit per connection
      if (this.rooms.size >= 50) {
        console.warn(`[Realtime] Cannot subscribe to ${room}: maximum 50 rooms limit reached`);
        return () => {};
      }

      entry = {
        count: 1,
        handlers: new Set([onEvent]),
        reconnectHandlers: onReconnect ? new Set([onReconnect]) : new Set(),
      };
      this.rooms.set(room, entry);

      // Send subscribe frame only if already connected (welcome received)
      if (this.isConnected) {
        this.sendSubscribe(room);
      }
    } else {
      entry.count += 1;
      entry.handlers.add(onEvent);
      if (onReconnect) {
        entry.reconnectHandlers.add(onReconnect);
      }
    }

    // Lazily open connection if this is the first subscription
    if (!this.isConnected && !this.isConnecting) {
      this.connect();
    }

    // Return cleanup function to unsubscribe
    return () => {
      this.unsubscribe(room, onEvent, onReconnect);
    };
  }

  /**
   * Decrement ref count; send unsubscribe frame when count reaches 0.
   */
  public unsubscribe(
    room: string,
    onEvent: RoomEventHandler,
    onReconnect?: ReconnectHandler,
  ): void {
    const entry = this.rooms.get(room);
    if (!entry) return;

    entry.handlers.delete(onEvent);
    if (onReconnect) {
      entry.reconnectHandlers.delete(onReconnect);
    }
    entry.count -= 1;

    if (entry.count <= 0) {
      this.rooms.delete(room);
      this.sendUnsubscribe(room);
    }
  }

  /**
   * Ping server for liveness if needed.
   */
  public ping(): void {
    this.sendJson({
      type: 'ping',
      id: this.generateId(),
    });
  }

  private async doConnect(): Promise<void> {
    if (this.isConnecting || this.isConnected) return;
    this.isConnecting = true;
    const currentGen = ++this.connectGeneration;

    try {
      let ticket: string | null = null;

      // Only request ticket if not forced to anonymous and ticket requester provided
      if (!this.dropAuthUntilReauth && this.requestTicketFn) {
        try {
          ticket = await this.requestTicketFn();
        } catch {
          ticket = null;
        }
      }

      if (this.isExplicitlyClosed || this.connectGeneration !== currentGen) {
        this.isConnecting = false;
        return;
      }

      const base = this.wsUrlGetter();
      const url = ticket ? `${base}?ticket=${encodeURIComponent(ticket)}` : base;

      const ws = new this.WebSocketImpl(url);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        // Connection opened; wait for welcome frame before marking connected
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.ws !== ws) return;
        this.handleMessage(event.data);
      };

      ws.onclose = (event: CloseEvent) => {
        if (this.ws !== ws) return;
        this.handleClose(event.code, event.reason);
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        // Handled via onclose
      };
    } catch {
      if (this.connectGeneration === currentGen) {
        this.handleClose(1006, 'Connection creation failed');
      }
    }
  }

  private handleMessage(rawData: unknown): void {
    if (typeof rawData !== 'string') {
      return; // Drop binary frames
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return; // Drop invalid JSON
    }

    const validation = validateServerFrame(parsed);
    if (!validation.valid || !validation.message) {
      // Validate every server frame against server.schema.json; drop invalid frames
      return;
    }

    const msg = validation.message;

    switch (msg.type) {
      case 'welcome':
        this.handleWelcome(msg);
        break;

      case 'ack':
        // Acknowledged
        break;

      case 'error':
        console.warn(`[Realtime] Server error (${msg.code}): ${msg.message}`);
        break;

      case 'pong':
        // Pong received
        break;

      case 'event':
        this.handleEvent(msg as ServerEventMessage);
        break;
    }
  }

  private handleWelcome(msg: ServerWelcomeMessage): void {
    const isReconnect = this.reconnectAttempts > 0;
    this.hasConnectedBefore = true;
    this.isConnecting = false;
    this.connectionId = msg.connection_id;
    this.userId = msg.user_id;
    this.reconnectAttempts = 0;
    this.setConnectedState(true);

    // Re-subscribe all active rooms after (re)connect
    for (const room of this.rooms.keys()) {
      this.sendSubscribe(room);
    }

    // Trigger onReconnect for consumers only on reconnect to refetch REST state
    if (isReconnect) {
      for (const entry of this.rooms.values()) {
        for (const handler of entry.reconnectHandlers) {
          try {
            handler();
          } catch (err) {
            console.error('[Realtime] Error in reconnect handler:', err);
          }
        }
      }
    }
  }

  private handleEvent(eventMsg: ServerEventMessage): void {
    const room = eventMsg.room;

    // Dispatch to specific room handlers
    const entry = this.rooms.get(room);
    if (entry) {
      for (const handler of entry.handlers) {
        try {
          handler(eventMsg);
        } catch (err) {
          console.error(`[Realtime] Error in handler for room ${room}:`, err);
        }
      }
    }

    // If event is on user:{me} room, dispatch to global user listeners (toasts)
    if (room.startsWith('user:')) {
      for (const handler of this.userEventHandlers) {
        try {
          handler(eventMsg);
        } catch (err) {
          console.error('[Realtime] Error in user event handler:', err);
        }
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    this.isConnecting = false;
    this.ws = null;
    this.connectionId = null;
    this.setConnectedState(false);

    if (this.isExplicitlyClosed) return;

    let delay = this.computeBackoffDelay();

    switch (code) {
      case 1001:
        // Server restart / deploy -> reconnect with normal backoff
        break;

      case 4401:
        // Ticket revoked / unauthorized -> drop auth and reconnect anonymous
        this.dropAuthUntilReauth = true;
        break;

      case 4429:
        // Connection rate limited or too many connections -> back off to max delay
        delay = this.maxDelayMs;
        break;

      case 4400:
        // Client sent bad frames -> log a bug and back off
        console.error(
          '[Realtime BUG] Server closed connection with 4400 (Client sent bad frames):',
          reason,
        );
        delay = this.maxDelayMs;
        break;

      default:
        // Standard exponential backoff
        break;
    }

    this.scheduleReconnect(delay);
  }

  private computeBackoffDelay(): number {
    this.reconnectAttempts += 1;
    // Exponential: 1s, 2s, 4s, 8s, 16s, up to 30s
    const exponential = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * Math.pow(2, this.reconnectAttempts - 1),
    );
    // Jitter: ±25% random variation, bounded within [1s, 30s]
    const jitterFactor = 0.75 + Math.random() * 0.5;
    const delay = Math.round(
      Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, exponential * jitterFactor)),
    );
    return delay;
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isExplicitlyClosed) {
        void this.doConnect();
      }
    }, delayMs);
  }

  private sendSubscribe(room: string): void {
    this.sendJson({
      type: 'subscribe',
      id: this.generateId(),
      room,
    });
  }

  private sendUnsubscribe(room: string): void {
    this.sendJson({
      type: 'unsubscribe',
      id: this.generateId(),
      room,
    });
  }

  private sendJson(msg: ClientMessage): void {
    if (
      this.ws &&
      (this.ws.readyState === 1 ||
        (typeof WebSocket !== 'undefined' && this.ws.readyState === WebSocket.OPEN))
    ) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        console.warn('[Realtime] Failed to send frame:', err);
      }
    }
  }

  private setConnectedState(connected: boolean): void {
    if (this.isConnected !== connected) {
      this.isConnected = connected;
      for (const listener of this.statusListeners) {
        try {
          listener(connected);
        } catch (err) {
          console.error('[Realtime] Error in status listener:', err);
        }
      }
    }
  }

  private generateId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
  }
}
