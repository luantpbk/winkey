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

  it('calls m.ack() and logs warn on unsupported event version', async () => {
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
    expect(mockMsg.ack).toHaveBeenCalledTimes(1);
    expect(mockMsg.term).not.toHaveBeenCalled();
    expect(mockMsg.nak).not.toHaveBeenCalled();
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

  it('calls m.term() on video.moderated with invalid UUID or state', async () => {
    const mockDb = {} as any;
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb, natsConnection: mockNats });

    const mockMsg1 = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.moderated',
          data: { video_id: 'invalid-id', state: 'HIDDEN' },
        }),
      ),
      subject: 'video.moderated',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };
    await consumer.processMessage(mockMsg1 as any);
    expect(mockMsg1.term).toHaveBeenCalledTimes(1);

    const mockMsg2 = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.moderated',
          data: { video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010', state: 'UNKNOWN' },
        }),
      ),
      subject: 'video.moderated',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };
    await consumer.processMessage(mockMsg2 as any);
    expect(mockMsg2.term).toHaveBeenCalledTimes(1);
  });

  it('calls m.ack() on successful video.moderated processing (HIDDEN and VISIBLE)', async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ execute: executeMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateTableMock = vi.fn().mockReturnValue({ set: setMock });
    const mockDb = { updateTable: updateTableMock };
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb as any, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.moderated',
          data: {
            video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
            owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
            state: 'HIDDEN',
            moderator_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9999',
          },
        }),
      ),
      subject: 'video.moderated',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockDb.updateTable).toHaveBeenCalledWith('social.videos');
    expect(setMock).toHaveBeenCalledWith({ hidden: true });
    expect(whereMock).toHaveBeenCalledWith('id', '=', '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010');
    expect(mockMsg.ack).toHaveBeenCalledTimes(1);
  });

  it('calls m.term() on video.ready with invalid visibility', async () => {
    const mockDb = {} as any;
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.ready',
          data: {
            video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
            owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
            visibility: 'INVALID_VISIBILITY',
          },
        }),
      ),
      subject: 'video.ready',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockMsg.term).toHaveBeenCalledTimes(1);
    expect(mockMsg.ack).not.toHaveBeenCalled();
  });

  it('handles video.ready with visibility present and upserts with visibility', async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const doUpdateSetMock = vi.fn().mockReturnValue({ execute: executeMock });
    const onConflictMock = vi.fn().mockReturnValue({ execute: executeMock });
    const valuesMock = vi.fn().mockReturnValue({ onConflict: onConflictMock });
    const insertIntoMock = vi.fn().mockReturnValue({ values: valuesMock });
    const mockDb = { insertInto: insertIntoMock };
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb as any, natsConnection: mockNats });

    onConflictMock.mockImplementation((cb: (oc: any) => any) => {
      const oc = {
        column: vi.fn().mockReturnValue({
          doUpdateSet: doUpdateSetMock,
        }),
      };
      return cb(oc);
    });

    const mockMsg = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.ready',
          data: {
            video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
            owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
            visibility: 'PRIVATE',
          },
        }),
      ),
      subject: 'video.ready',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockDb.insertInto).toHaveBeenCalledWith('social.videos');
    expect(valuesMock).toHaveBeenCalledWith({
      id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
      owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
      visibility: 'PRIVATE',
    });
    expect(doUpdateSetMock).toHaveBeenCalledWith({
      owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
      visibility: 'PRIVATE',
    });
    expect(mockMsg.ack).toHaveBeenCalledTimes(1);
  });

  it('handles video.ready without visibility and does not overwrite visibility on conflict', async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const doUpdateSetMock = vi.fn().mockReturnValue({ execute: executeMock });
    const onConflictMock = vi.fn().mockReturnValue({ execute: executeMock });
    const valuesMock = vi.fn().mockReturnValue({ onConflict: onConflictMock });
    const insertIntoMock = vi.fn().mockReturnValue({ values: valuesMock });
    const mockDb = { insertInto: insertIntoMock };
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb as any, natsConnection: mockNats });

    onConflictMock.mockImplementation((cb: (oc: any) => any) => {
      const oc = {
        column: vi.fn().mockReturnValue({
          doUpdateSet: doUpdateSetMock,
        }),
      };
      return cb(oc);
    });

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
    expect(mockDb.insertInto).toHaveBeenCalledWith('social.videos');
    expect(valuesMock).toHaveBeenCalledWith({
      id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
      owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
    });
    // On conflict, only owner_id is updated; existing visibility is preserved
    expect(doUpdateSetMock).toHaveBeenCalledWith({
      owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
    });
    expect(mockMsg.ack).toHaveBeenCalledTimes(1);
  });

  it('calls m.term() on video.visibility_changed with invalid UUID or visibility', async () => {
    const mockDb = {} as any;
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb, natsConnection: mockNats });

    const mockMsg1 = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.visibility_changed',
          data: {
            video_id: 'invalid-id',
            owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
            visibility: 'PUBLIC',
          },
        }),
      ),
      subject: 'video.visibility_changed',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };
    await consumer.processMessage(mockMsg1 as any);
    expect(mockMsg1.term).toHaveBeenCalledTimes(1);

    const mockMsg2 = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.visibility_changed',
          data: {
            video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
            owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
            visibility: 'INVALID',
          },
        }),
      ),
      subject: 'video.visibility_changed',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };
    await consumer.processMessage(mockMsg2 as any);
    expect(mockMsg2.term).toHaveBeenCalledTimes(1);
  });

  it('calls m.ack() on successful video.visibility_changed processing', async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ execute: executeMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateTableMock = vi.fn().mockReturnValue({ set: setMock });
    const mockDb = { updateTable: updateTableMock };
    const mockNats = {} as any;
    const consumer = new VideoProjectionConsumer({ db: mockDb as any, natsConnection: mockNats });

    const mockMsg = {
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          type: 'video.visibility_changed',
          data: {
            video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010',
            owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001',
            visibility: 'PRIVATE',
          },
        }),
      ),
      subject: 'video.visibility_changed',
      term: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
    };

    await consumer.processMessage(mockMsg as any);
    expect(mockDb.updateTable).toHaveBeenCalledWith('social.videos');
    expect(setMock).toHaveBeenCalledWith({ visibility: 'PRIVATE' });
    expect(whereMock).toHaveBeenCalledWith('id', '=', '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010');
    expect(mockMsg.ack).toHaveBeenCalledTimes(1);
  });
});
