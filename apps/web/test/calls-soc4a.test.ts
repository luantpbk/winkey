import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const chat = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({})),
  sendToDevice: vi.fn(async () => {}),
  getDeviceId: vi.fn(() => 'device-me-0001'),
}));
vi.mock('../src/lib/e2ee/chat-service', () => ({ getChatService: () => chat }));
vi.mock('../src/lib/api-client', () => ({
  api: {
    chat: {
      POST: vi.fn(async () => ({ data: undefined, response: new Response(null, { status: 503 }) })),
    },
  },
}));

import { parseCallEvent, describeCallEvent, CALL_LIFETIME_MS } from '../src/lib/calls/events';
import { callReducer, IDLE, isBusy, type CallState } from '../src/lib/calls/state-machine';
import { CallManager } from '../src/lib/calls/call-manager';
import type { Conversation } from '@winkey/api-client';

const CALL = '0192f5e4-7c1a-7b3e-9d2a-00000000ca11';
const ME = '0192f5e4-7c1a-7b3e-9d2a-0000000000a1';
const PEER = '0192f5e4-7c1a-7b3e-9d2a-0000000000b2';

describe('SOC-4a call events', () => {
  it('accepts every well-formed event with v: 1', () => {
    const events = [
      {
        type: 'm.call.invite',
        v: 1,
        call_id: CALL,
        media: 'video',
        sdp: 'v=0',
        lifetime_ms: 45000,
      },
      { type: 'm.call.answer', v: 1, call_id: CALL, sdp: 'v=0', answerer_device_id: 'dev-1' },
      { type: 'm.call.reject', v: 1, call_id: CALL, reason: 'busy' },
      { type: 'm.call.hangup', v: 1, call_id: CALL, reason: 'user_hangup', duration_ms: 180000 },
      {
        type: 'm.call.candidates',
        v: 1,
        call_id: CALL,
        candidates: [
          { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 },
        ],
      },
      { type: 'm.call.select_answer', v: 1, call_id: CALL, device_id: 'dev-1' },
      { type: 'm.call.negotiate', v: 1, call_id: CALL, kind: 'offer', sdp: 'v=0' },
    ];
    for (const e of events) expect(parseCallEvent(e)).toEqual(e);
  });

  it('ignores unknown, versioned-differently and malformed events', () => {
    const invite = {
      type: 'm.call.invite',
      v: 1,
      call_id: CALL,
      media: 'audio',
      sdp: 'v=0',
      lifetime_ms: 45000,
    };
    expect(parseCallEvent({ ...invite, v: 2 })).toBeNull();
    expect(parseCallEvent({ ...invite, type: 'm.call.unknown' })).toBeNull();
    expect(parseCallEvent({ ...invite, media: 'screen' })).toBeNull();
    expect(parseCallEvent({ ...invite, call_id: 'bad id!' })).toBeNull();
    expect(parseCallEvent({ ...invite, sdp: 'x'.repeat(40000) })).toBeNull();
    expect(parseCallEvent({ ...invite, lifetime_ms: 10 ** 9 })).toBeNull();
    expect(
      parseCallEvent({
        type: 'm.call.hangup',
        v: 1,
        call_id: CALL,
        reason: 'other',
        duration_ms: 1,
      }),
    ).toBeNull();
    expect(
      parseCallEvent({ type: 'm.call.candidates', v: 1, call_id: CALL, candidates: [] }),
    ).toBeNull();
    expect(
      parseCallEvent({
        type: 'm.call.candidates',
        v: 1,
        call_id: CALL,
        candidates: [{ candidate: 1 }],
      }),
    ).toBeNull();
    expect(parseCallEvent(null)).toBeNull();
    expect(parseCallEvent('m.call.invite')).toBeNull();
  });

  it('renders history lines like "Cuộc gọi thoại · 3 phút" and "Cuộc gọi video nhỡ"', () => {
    const hangup = (reason: 'user_hangup' | 'invite_timeout', duration_ms: number) =>
      ({ type: 'm.call.hangup', v: 1, call_id: CALL, reason, duration_ms }) as const;
    expect(describeCallEvent(hangup('user_hangup', 180_000), 'audio', true)).toBe(
      'Cuộc gọi thoại · 3 phút',
    );
    expect(describeCallEvent(hangup('user_hangup', 42_000), 'video', false)).toBe(
      'Cuộc gọi video · 42 giây',
    );
    expect(describeCallEvent(hangup('invite_timeout', 0), 'video', false)).toBe(
      'Cuộc gọi video nhỡ',
    );
    expect(describeCallEvent(hangup('invite_timeout', 0), 'audio', true)).toBe(
      'Cuộc gọi thoại không được trả lời',
    );
    expect(
      describeCallEvent(
        { type: 'm.call.reject', v: 1, call_id: CALL, reason: 'busy' },
        'audio',
        false,
      ),
    ).toBe('Cuộc gọi thoại · người nhận đang bận');
    expect(
      describeCallEvent(
        {
          type: 'm.call.invite',
          v: 1,
          call_id: CALL,
          media: 'audio',
          sdp: 'v',
          lifetime_ms: 45000,
        },
        'audio',
        true,
      ),
    ).toBeNull();
  });
});

describe('SOC-4a call state machine', () => {
  const t0 = 1_000_000;
  const start = callReducer(IDLE, {
    type: 'START',
    callId: CALL,
    conversationId: 'c',
    media: 'audio',
    now: t0,
  });

  it('outgoing: calling → connecting → connected → ended with the connected duration', () => {
    expect(start.status).toBe('calling');
    const connecting = callReducer(start, {
      type: 'ANSWER_RECEIVED',
      callId: CALL,
      answererDeviceId: 'd',
      now: t0 + 5000,
    });
    expect(connecting).toMatchObject({
      status: 'connecting',
      direction: 'outgoing',
      peerDeviceId: 'd',
    });
    const connected = callReducer(connecting, { type: 'ICE_CONNECTED', now: t0 + 6000 });
    expect(connected.status).toBe('connected');
    const reconnecting = callReducer(connected, { type: 'ICE_DISCONNECTED' });
    expect(reconnecting).toMatchObject({ status: 'connected', reconnecting: true });
    const back = callReducer(reconnecting, { type: 'ICE_CONNECTED', now: t0 + 7000 });
    expect(back).toMatchObject({ reconnecting: false, connectedAt: t0 + 6000 });
    expect(callReducer(back, { type: 'HANGUP', now: t0 + 186_000 })).toMatchObject({
      status: 'ended',
      outcome: 'completed',
      durationMs: 180_000,
    });
  });

  it('incoming: ringing → accept → connecting; decline → rejected; timeout → missed', () => {
    const ringing = callReducer(IDLE, {
      type: 'INVITE_RECEIVED',
      callId: CALL,
      conversationId: 'c',
      media: 'video',
      callerDeviceId: 'cd',
      now: t0,
    });
    expect(ringing.status).toBe('ringing');
    expect(callReducer(ringing, { type: 'ACCEPT', now: t0, callerDeviceId: 'cd' })).toMatchObject({
      status: 'connecting',
      direction: 'incoming',
    });
    expect(callReducer(ringing, { type: 'DECLINE', now: t0 })).toMatchObject({
      status: 'ended',
      outcome: 'rejected',
    });
    expect(
      callReducer(ringing, { type: 'TIMEOUT', callId: CALL, now: t0 + CALL_LIFETIME_MS }),
    ).toMatchObject({ outcome: 'missed' });
    expect(
      callReducer(ringing, { type: 'REMOTE_HANGUP', callId: CALL, reason: 'user_hangup', now: t0 }),
    ).toMatchObject({ outcome: 'missed' });
    expect(
      callReducer(ringing, { type: 'ANSWERED_ELSEWHERE', callId: CALL, now: t0 }),
    ).toMatchObject({ outcome: 'answered_elsewhere' });
  });

  it('busy, rejected, cancelled, failed; events for another call are ignored', () => {
    expect(
      callReducer(start, { type: 'REJECT_RECEIVED', callId: CALL, reason: 'busy', now: t0 }),
    ).toMatchObject({ outcome: 'busy' });
    expect(callReducer(start, { type: 'REJECT_RECEIVED', callId: CALL, now: t0 })).toMatchObject({
      outcome: 'rejected',
    });
    expect(callReducer(start, { type: 'HANGUP', now: t0 })).toMatchObject({ outcome: 'cancelled' });
    expect(callReducer(start, { type: 'FAILED', now: t0 })).toMatchObject({ outcome: 'failed' });
    expect(callReducer(start, { type: 'REJECT_RECEIVED', callId: 'other', now: t0 })).toBe(start);
    expect(isBusy(start)).toBe(true);
    expect(
      callReducer(start, {
        type: 'INVITE_RECEIVED',
        callId: 'x',
        conversationId: 'c',
        media: 'audio',
        callerDeviceId: 'd',
        now: t0,
      }),
    ).toBe(start);
    expect(isBusy({ status: 'ended' } as CallState)).toBe(false);
  });
});

describe('SOC-4a CallManager signaling (fake WebRTC)', () => {
  const conversation = {
    id: 'conv-1',
    kind: 'DIRECT',
    my_state: 'ACTIVE',
    members: [
      {
        user_id: ME,
        state: 'ACTIVE',
        role: 'OWNER',
        user: { id: ME, handle: 'me', display_name: 'Tôi', avatar_url: null },
      },
      {
        user_id: PEER,
        state: 'ACTIVE',
        role: 'MEMBER',
        user: { id: PEER, handle: 'peer', display_name: 'Bạn', avatar_url: null },
      },
    ],
  } as unknown as Conversation;

  class FakePc {
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    iceConnectionState: RTCIceConnectionState = 'new';
    ontrack: unknown = null;
    onicecandidate: unknown = null;
    oniceconnectionstatechange: unknown = null;
    transceivers: Array<{ sender: { replaceTrack: () => Promise<void> }; direction: string }> = [];
    addTransceiver() {
      this.transceivers.push({ sender: { replaceTrack: async () => {} }, direction: 'sendrecv' });
    }
    getTransceivers() {
      return this.transceivers;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0 offer' } as RTCSessionDescriptionInit;
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'v=0 answer' } as RTCSessionDescriptionInit;
    }
    async setLocalDescription(d: RTCSessionDescriptionInit) {
      this.localDescription = d;
    }
    async setRemoteDescription(d: RTCSessionDescriptionInit) {
      this.remoteDescription = d;
    }
    async addIceCandidate() {}
    close() {}
  }
  const fakeStream = () =>
    ({
      getAudioTracks: () => [],
      getVideoTracks: () => [],
      getTracks: () => [],
      addTrack() {},
    }) as unknown as MediaStream;

  beforeEach(() => {
    vi.useFakeTimers();
    chat.sendMessage.mockClear();
    chat.sendToDevice.mockClear();
    vi.stubGlobal(
      'MediaStream',
      class {
        getTracks() {
          return [];
        }
        getVideoTracks() {
          return [];
        }
        addTrack() {}
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const makeManager = () =>
    new CallManager(ME, {
      getUserMedia: async () => fakeStream(),
      createPeerConnection: () => new FakePc() as unknown as RTCPeerConnection,
    });

  it('sends an encrypted invite, and a missed-call hangup after 45 s without answer', async () => {
    const m = makeManager();
    await m.startCall(conversation, 'audio');
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    const invite = (
      chat.sendMessage.mock.calls[0] as unknown as [
        { callEvent: { type: string; media: string; lifetime_ms: number } },
      ]
    )[0].callEvent;
    expect(invite).toMatchObject({ type: 'm.call.invite', media: 'audio', lifetime_ms: 45000 });
    expect(m.getSnapshot().state.status).toBe('calling');

    await vi.advanceTimersByTimeAsync(CALL_LIFETIME_MS + 10);
    const hangup = (
      chat.sendMessage.mock.calls[1] as unknown as [{ callEvent: { type: string; reason: string } }]
    )[0].callEvent;
    expect(hangup).toMatchObject({ type: 'm.call.hangup', reason: 'invite_timeout' });
    expect(m.getSnapshot().state).toMatchObject({ status: 'ended', outcome: 'missed' });
  });

  it('rings for a fresh invite, answers busy to a second one, and ignores stale invites', async () => {
    const m = makeManager();
    const invite = (callId: string) => ({
      type: 'm.call.invite' as const,
      v: 1 as const,
      call_id: callId,
      media: 'video' as const,
      sdp: 'v=0',
      lifetime_ms: 45000,
    });
    await m.handleRoomEvent({
      event: invite('0192f5e4-7c1a-7b3e-9d2a-0000000ca0ld'),
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation,
      fresh: false,
    });
    expect(m.getSnapshot().state.status).toBe('idle');

    await m.handleRoomEvent({
      event: invite(CALL),
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation,
      fresh: true,
    });
    expect(m.getSnapshot().state).toMatchObject({ status: 'ringing', media: 'video' });

    await m.handleRoomEvent({
      event: invite('0192f5e4-7c1a-7b3e-9d2a-00000000ca22'),
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation,
      fresh: true,
    });
    const busy = (
      chat.sendMessage.mock.calls.at(-1) as unknown as [
        { callEvent: { type: string; reason: string; call_id: string } },
      ]
    )[0].callEvent;
    expect(busy).toMatchObject({
      type: 'm.call.reject',
      reason: 'busy',
      call_id: '0192f5e4-7c1a-7b3e-9d2a-00000000ca22',
    });
    expect(m.getSnapshot().state.status).toBe('ringing');

    // Another of my devices answered → stop ringing here.
    await m.handleRoomEvent({
      event: {
        type: 'm.call.answer',
        v: 1,
        call_id: CALL,
        sdp: 'v=0',
        answerer_device_id: 'device-other',
      },
      senderId: ME,
      senderDeviceId: 'device-other',
      conversation,
      fresh: true,
    });
    expect(m.getSnapshot().state).toMatchObject({ status: 'ended', outcome: 'answered_elsewhere' });
  });

  it('accepting answers with this device id; the caller then tells the other devices with select_answer', async () => {
    const callee = makeManager();
    await callee.handleRoomEvent({
      event: {
        type: 'm.call.invite',
        v: 1,
        call_id: CALL,
        media: 'audio',
        sdp: 'v=0 offer',
        lifetime_ms: 45000,
      },
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation,
      fresh: true,
    });
    await callee.acceptCall();
    const answer = (
      chat.sendMessage.mock.calls.at(-1) as unknown as [
        { callEvent: { type: string; answerer_device_id: string } },
      ]
    )[0].callEvent;
    expect(answer).toMatchObject({ type: 'm.call.answer', answerer_device_id: 'device-me-0001' });
    expect(callee.getSnapshot().state).toMatchObject({
      status: 'connecting',
      direction: 'incoming',
    });

    const caller = makeManager();
    await caller.startCall(conversation, 'audio');
    const callId = (
      chat.sendMessage.mock.calls.at(-1) as unknown as [{ callEvent: { call_id: string } }]
    )[0].callEvent.call_id;
    await caller.handleRoomEvent({
      event: {
        type: 'm.call.answer',
        v: 1,
        call_id: callId,
        sdp: 'v=0 answer',
        answerer_device_id: 'pd-2',
      },
      senderId: PEER,
      senderDeviceId: 'pd-2',
      conversation,
      fresh: true,
    });
    expect(caller.getSnapshot().state).toMatchObject({
      status: 'connecting',
      peerDeviceId: 'pd-2',
    });
    const select = chat.sendToDevice.mock.calls.find(
      (c) =>
        (c as unknown as [{ event: { type: string } }])[0].event.type === 'm.call.select_answer',
    );
    expect(select).toBeTruthy();
    expect((select as unknown as [{ deviceIds?: string[]; userIds: string[] }])[0]).toMatchObject({
      userIds: [PEER],
      deviceIds: undefined,
    });
  });

  it('refuses to call outside an ACTIVE 1-1 conversation', async () => {
    const m = makeManager();
    await m.startCall({ ...conversation, kind: 'GROUP' } as Conversation, 'audio');
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(m.getSnapshot().error).toMatch(/1-1/);
    expect(
      CallManager.canCall(
        {
          ...conversation,
          members: [conversation.members[0]!, { ...conversation.members[1]!, state: 'REQUESTED' }],
        } as Conversation,
        ME,
      ),
    ).toBe(false);
  });

  // --- architect review of #555: identities come from the sender metadata, never from the payload ---------------

  const inviteEvent = (callId = CALL) => ({
    type: 'm.call.invite' as const,
    v: 1 as const,
    call_id: callId,
    media: 'audio' as const,
    sdp: 'v=0 offer',
    lifetime_ms: 45000,
  });
  const STRANGER = '0192f5e4-7c1a-7b3e-9d2a-0000000000ff';

  it('ignores an invite from a group, from a non-member of the 1-1, or before both accepted — no ring, no busy reply', async () => {
    const m = makeManager();
    const group = {
      ...conversation,
      id: 'conv-group',
      kind: 'GROUP',
      members: [
        ...conversation.members,
        { ...conversation.members[1]!, user_id: STRANGER, user: { id: STRANGER } },
      ],
    } as unknown as Conversation;
    await m.handleRoomEvent({
      event: inviteEvent(),
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation: group,
      fresh: true,
    });
    expect(m.getSnapshot().state.status).toBe('idle');

    await m.handleRoomEvent({
      event: inviteEvent(),
      senderId: STRANGER,
      senderDeviceId: 'sd',
      conversation,
      fresh: true,
    });
    expect(m.getSnapshot().state.status).toBe('idle');

    const requested = {
      ...conversation,
      members: [conversation.members[0]!, { ...conversation.members[1]!, state: 'REQUESTED' }],
    } as Conversation;
    await m.handleRoomEvent({
      event: inviteEvent(),
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation: requested,
      fresh: true,
    });
    expect(m.getSnapshot().state.status).toBe('idle');
    expect(chat.sendMessage).not.toHaveBeenCalled();

    // The same invite in the real 1-1 rings.
    await m.handleRoomEvent({
      event: inviteEvent(),
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation,
      fresh: true,
    });
    expect(m.getSnapshot().state.status).toBe('ringing');
  });

  it('ignores an answer whose answerer_device_id is not the sending device', async () => {
    const caller = makeManager();
    await caller.startCall(conversation, 'audio');
    const callId = (
      chat.sendMessage.mock.calls.at(-1) as unknown as [{ callEvent: { call_id: string } }]
    )[0].callEvent.call_id;
    const answer = (answerer: string) => ({
      type: 'm.call.answer' as const,
      v: 1 as const,
      call_id: callId,
      sdp: 'v=0 answer',
      answerer_device_id: answerer,
    });

    await caller.handleRoomEvent({
      event: answer('pd-victim'),
      senderId: PEER,
      senderDeviceId: 'pd-2',
      conversation,
      fresh: true,
    });
    expect(caller.getSnapshot().state.status).toBe('calling');
    expect(chat.sendToDevice).not.toHaveBeenCalled();

    // On my own devices too: a forged "answered elsewhere" does not stop the call.
    await caller.handleRoomEvent({
      event: answer('device-other'),
      senderId: ME,
      senderDeviceId: 'device-me-0001',
      conversation,
      fresh: true,
    });
    expect(caller.getSnapshot().state.status).toBe('calling');

    await caller.handleRoomEvent({
      event: answer('pd-2'),
      senderId: PEER,
      senderDeviceId: 'pd-2',
      conversation,
      fresh: true,
    });
    expect(caller.getSnapshot().state).toMatchObject({
      status: 'connecting',
      peerDeviceId: 'pd-2',
    });
  });

  it('ignores select_answer from a third user; the caller or my own device may stop the ringing', async () => {
    const m = makeManager();
    await m.handleRoomEvent({
      event: inviteEvent(),
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation,
      fresh: true,
    });
    expect(m.getSnapshot().state.status).toBe('ringing');
    const select = {
      type: 'm.call.select_answer' as const,
      v: 1 as const,
      call_id: CALL,
      device_id: 'elsewhere',
    };

    await m.handleDeviceEvent({ event: select, senderId: STRANGER, senderDeviceId: 'sd' });
    expect(m.getSnapshot().state.status).toBe('ringing');

    await m.handleDeviceEvent({ event: select, senderId: PEER, senderDeviceId: 'pd' });
    expect(m.getSnapshot().state).toMatchObject({ status: 'ended', outcome: 'answered_elsewhere' });
  });

  it('ignores a hangup for this call_id sent from another conversation or by a third user', async () => {
    const m = makeManager();
    await m.handleRoomEvent({
      event: inviteEvent(),
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation,
      fresh: true,
    });
    const hangup = {
      type: 'm.call.hangup' as const,
      v: 1 as const,
      call_id: CALL,
      reason: 'user_hangup' as const,
      duration_ms: 0,
    };
    const other = { ...conversation, id: 'conv-other' } as Conversation;
    await m.handleRoomEvent({
      event: hangup,
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation: other,
      fresh: true,
    });
    await m.handleRoomEvent({
      event: hangup,
      senderId: STRANGER,
      senderDeviceId: 'sd',
      conversation,
      fresh: true,
    });
    expect(m.getSnapshot().state.status).toBe('ringing');
    await m.handleRoomEvent({
      event: hangup,
      senderId: PEER,
      senderDeviceId: 'pd',
      conversation,
      fresh: true,
    });
    expect(m.getSnapshot().state.status).toBe('ended');
  });
});
