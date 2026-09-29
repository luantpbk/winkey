/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { VideoProjectionConsumer } from '../../src/projection/consumer.js';

describe('VideoProjectionConsumer unit tests', () => {
  it('calls m.term() on malformed JSON (poison message)', async () => {
    const mockDb = {} as any;
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from('not valid json {[[['),
      subject: 'video.ready',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockMsg.term).toHaveBeenCalledTimes(1);
    expect(mockMsg.ack).not.toHaveBeenCalled();
    expect(mockMsg.nak).not.toHaveBeenCalled();
  });

  it('calls m.term() on invalid event format (not an object)', async () => {
    const mockDb = {} as any;
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(JSON.stringify(['an', 'array'])),
      subject: 'video.ready',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockMsg.term).toHaveBeenCalledTimes(1);
  });

  it('calls m.term() on missing or invalid version', async () => {
    const mockDb = {} as any;
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(JSON.stringify({ version: 2, type: 'video.ready' })),
      subject: 'video.ready',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockMsg.term).toHaveBeenCalledTimes(1);
  });

  it('calls m.term() on video.ready with invalid UUIDs', async () => {
    const mockDb = {} as any;
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.ready',
          data: { video_id: 'not-a-uuid', owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001' },
        }),
      ),
      subject: 'video.ready',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockMsg.term).toHaveBeenCalledTimes(1);
  });

  it('calls m.term() on video.deleted with missing or invalid video_id', async () => {
    const mockDb = {} as any;
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.deleted',
          data: {},
        }),
      ),
      subject: 'video.deleted',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockMsg.term).toHaveBeenCalledTimes(1);
  });

  it('calls m.nak(5000) on database error during video.ready', async () => {
    const mockDb = {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflict: vi.fn().mockReturnValue({
            execute: vi.fn().mockRejectedValue(new Error('DB connection lost')),
          }),
        }),
      }),
    };
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb as any, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.ready',
          data: {
            video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
            owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
          },
        }),
      ),
      subject: 'video.ready',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockMsg.nak).toHaveBeenCalledWith(5000);
    expect(mockMsg.ack).not.toHaveBeenCalled();
    expect(mockMsg.term).not.toHaveBeenCalled();
  });

  it('calls m.nak(5000) on database error during video.deleted', async () => {
    const mockDb = {
      deleteFrom: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: vi.fn().mockRejectedValue(new Error('DB deadlock')),
        }),
      }),
    };
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb as any, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.deleted',
          data: {
            video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
          },
        }),
      ),
      subject: 'video.deleted',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockMsg.nak).toHaveBeenCalledWith(5000);
    expect(mockMsg.ack).not.toHaveBeenCalled();
  });

  it('calls m.ack() on successful projection processing', async () => {
    const mockDb = {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflict: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb as any, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.ready',
          data: {
            video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
            owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
          },
        }),
      ),
      subject: 'video.ready',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockMsg.ack).toHaveBeenCalledTimes(1);
    expect(mockMsg.nak).not.toHaveBeenCalled();
    expect(mockMsg.term).not.toHaveBeenCalled();
  });
});
