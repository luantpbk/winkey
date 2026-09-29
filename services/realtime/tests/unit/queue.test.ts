import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { ConnectionManager } from '../../src/websocket/connection-manager.js';
import { VideoClient } from '../../src/video/video-client.js';

describe('Outbound Queue Backpressure', () => {
  it('drops oldest messages when buffer reaches 256: sending 300 messages results in 44 dropped', () => {
    const videoClient = new VideoClient('http://localhost:8080');
    const manager = new ConnectionManager({ videoClient });

    let isWelcome = true;
    // Mock WebSocket where send does not call callback (simulating backpressure/blocked socket)
    const mockWs = {
      readyState: 1, // WebSocket.OPEN
      send: (_data: unknown, cb?: (err?: Error) => void) => {
        if (isWelcome) {
          isWelcome = false;
          cb?.(); // Welcome frame completes immediately
          return;
        }
        // Does not call cb, keeping messages in-flight
      },
      close: () => {},
      on: () => {},
      ping: () => {},
    } as unknown as WebSocket;

    const userId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0001';
    const connId = manager.handleNewConnection(mockWs, { userId, roles: [] });
    expect(connId).toBeTruthy();

    const conn = (
      manager as unknown as {
        connections: Map<string, { send: (msg: unknown, onDropped?: () => void) => void }>;
      }
    ).connections.get(connId!);
    expect(conn).toBeDefined();

    // Send 300 messages without send callback completing
    for (let i = 0; i < 300; i++) {
      conn!.send({
        type: 'event',
        room: `upload:${userId}`,
        event: 'video.progress',
        data: { percent: i },
        ts: new Date().toISOString(),
      });
    }

    // 256 in-flight, remaining 44 dropped
    expect(manager.droppedMessagesTotal).toBe(44);
  });
});
