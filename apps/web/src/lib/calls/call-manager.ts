import { api } from '../api-client';
import { getChatService, type IncomingCallSignal } from '../e2ee/chat-service';
import type { Conversation } from '@winkey/api-client';
import {
  CALL_LIFETIME_MS,
  type CallCandidate,
  type CallDeviceEvent,
  type CallMedia,
  type CallRoomEvent,
  type HangupReason,
} from './events';
import { callReducer, IDLE, isBusy, type CallAction, type CallState } from './state-machine';

/**
 * SOC-4a 1-1 calls on this page (ADR-049 SOC-4a addendum). WebRTC runs here (not in the crypto worker); every
 * signaling message goes through the E2EE chat channel: invite / answer / reject / hangup as Megolm messages in
 * the DIRECT conversation, candidates / select_answer / negotiate as Olm to-device messages to the one device in
 * the call. Both audio and video transceivers are always negotiated, so switching voice ↔ video and changing
 * devices only replaces tracks; renegotiation is needed only for an ICE restart (`m.call.negotiate`).
 */

export class CallMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallMediaError';
  }
}

export interface CallSnapshot {
  state: CallState;
  peer: { userId: string; name: string; avatarUrl: string | null } | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  error: string | null;
}

interface ActiveCall {
  callId: string;
  conversation: Conversation;
  peerUserId: string;
  pc: RTCPeerConnection | null;
  /** Peer device we exchange to-device messages with (known after answer / at invite). */
  peerDeviceId: string | null;
  /** Remote offer kept while ringing. */
  remoteOffer?: string;
  pendingLocalCandidates: CallCandidate[];
  pendingRemoteCandidates: RTCIceCandidateInit[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  ringTimer: ReturnType<typeof setTimeout> | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  restarts: number;
}

const CANDIDATE_BATCH_MS = 150;
const RECONNECT_GRACE_MS = 3000;

function mediaErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Bạn chưa cho phép dùng micro/camera. Hãy bật quyền trong cài đặt trình duyệt rồi thử lại.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'Không tìm thấy micro hoặc camera.';
  }
  if (name === 'NotReadableError') return 'Micro hoặc camera đang được ứng dụng khác dùng.';
  return 'Không mở được micro/camera.';
}

export class CallManager {
  private snapshot: CallSnapshot = {
    state: IDLE,
    peer: null,
    localStream: null,
    remoteStream: null,
    muted: false,
    cameraOff: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private call: ActiveCall | null = null;
  private chat = getChatService();
  private ownDeviceId: () => string | null = () => this.chat.getDeviceId();

  constructor(
    private readonly userId: string,
    private readonly deps: {
      getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
      createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
      now?: () => number;
    } = {},
  ) {}

  // --- store ------------------------------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CallSnapshot => this.snapshot;

  private set(patch: Partial<CallSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private dispatch(action: CallAction) {
    const next = callReducer(this.snapshot.state, action);
    if (next !== this.snapshot.state) this.set({ state: next });
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // --- media and peer connection ----------------------------------------------------------------------------------

  private async openMedia(media: CallMedia): Promise<MediaStream> {
    const gum = this.deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
    try {
      return await gum({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: media === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      throw new CallMediaError(mediaErrorMessage(err));
    }
  }

  private async iceServers(): Promise<RTCIceServer[]> {
    try {
      const { data } = await api.chat.POST('/v1/chat/calls/turn-credentials');
      if (data) return [{ urls: data.urls, username: data.username, credential: data.credential }];
    } catch {
      // TURN unavailable: direct (host / STUN-less) connectivity only.
    }
    return [];
  }

  private async createPeer(call: ActiveCall): Promise<RTCPeerConnection> {
    const config: RTCConfiguration = {
      iceServers: await this.iceServers(),
      bundlePolicy: 'max-bundle',
    };
    const pc = this.deps.createPeerConnection
      ? this.deps.createPeerConnection(config)
      : new RTCPeerConnection(config);
    const remote = new MediaStream();
    this.set({ remoteStream: remote });
    pc.ontrack = (e) => {
      if (!remote.getTracks().includes(e.track)) remote.addTrack(e.track);
      this.set({ remoteStream: remote });
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      call.pendingLocalCandidates.push({
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      });
      this.scheduleCandidateFlush(call);
    };
    pc.oniceconnectionstatechange = () => this.onIceState(call, pc.iceConnectionState);
    return pc;
  }

  private attachLocal(pc: RTCPeerConnection, stream: MediaStream) {
    // Always one audio and one video transceiver, in this order, so later switches never renegotiate.
    const audio = stream.getAudioTracks()[0] ?? null;
    const video = stream.getVideoTracks()[0] ?? null;
    const transceivers = pc.getTransceivers();
    if (transceivers.length >= 2) {
      void transceivers[0]!.sender.replaceTrack(audio);
      transceivers[0]!.direction = 'sendrecv';
      void transceivers[1]!.sender.replaceTrack(video);
      transceivers[1]!.direction = 'sendrecv';
    } else {
      pc.addTransceiver(audio ?? 'audio', { direction: 'sendrecv', streams: [stream] });
      pc.addTransceiver(video ?? 'video', { direction: 'sendrecv', streams: [stream] });
    }
  }

  private scheduleCandidateFlush(call: ActiveCall) {
    if (!call.peerDeviceId || call.flushTimer) return;
    call.flushTimer = setTimeout(() => {
      call.flushTimer = null;
      const batch = call.pendingLocalCandidates.splice(0, 50);
      if (batch.length === 0 || !call.peerDeviceId) return;
      void this.sendDevice(call, {
        type: 'm.call.candidates',
        v: 1,
        call_id: call.callId,
        candidates: batch,
      });
      if (call.pendingLocalCandidates.length > 0) this.scheduleCandidateFlush(call);
    }, CANDIDATE_BATCH_MS);
  }

  /** To the peer device in the call, or to every device of the peer with `allDevices`. */
  private async sendDevice(call: ActiveCall, event: CallDeviceEvent, allDevices = false) {
    try {
      await this.chat.sendToDevice({
        userIds: [call.peerUserId],
        deviceIds: allDevices || !call.peerDeviceId ? undefined : [call.peerDeviceId],
        event,
      });
    } catch (err) {
      console.warn('[CallManager] to-device send failed', (err as Error)?.message);
    }
  }

  private async sendRoom(call: ActiveCall, event: CallRoomEvent) {
    await this.chat.sendMessage({ conversation: call.conversation, text: '', callEvent: event });
  }

  private onIceState(call: ActiveCall, state: RTCIceConnectionState) {
    if (this.call !== call) return;
    if (state === 'connected' || state === 'completed') {
      if (call.disconnectTimer) clearTimeout(call.disconnectTimer);
      call.disconnectTimer = null;
      call.restarts = 0;
      this.dispatch({ type: 'ICE_CONNECTED', now: this.now() });
    } else if (state === 'disconnected') {
      this.dispatch({ type: 'ICE_DISCONNECTED' });
      if (!call.disconnectTimer) {
        call.disconnectTimer = setTimeout(() => {
          call.disconnectTimer = null;
          void this.restartIce();
        }, RECONNECT_GRACE_MS);
      }
    } else if (state === 'failed') {
      this.dispatch({ type: 'ICE_DISCONNECTED' });
      void this.restartIce();
    }
  }

  /** ICE restart (network change). Only the side that sent the invite offers, so both never collide. */
  async restartIce(): Promise<void> {
    const call = this.call;
    const s = this.snapshot.state;
    if (!call?.pc || (s.status !== 'connected' && s.status !== 'connecting')) return;
    if (s.direction !== 'outgoing') return;
    if (call.restarts >= 3) {
      await this.hangup('ice_failed');
      return;
    }
    call.restarts++;
    const offer = await call.pc.createOffer({ iceRestart: true });
    await call.pc.setLocalDescription(offer);
    await this.sendDevice(call, {
      type: 'm.call.negotiate',
      v: 1,
      call_id: call.callId,
      kind: 'offer',
      sdp: offer.sdp!,
    });
  }

  // --- outgoing ---------------------------------------------------------------------------------------------------

  /** Only a DIRECT conversation where both members are ACTIVE can be called. */
  static canCall(conversation: Conversation, userId: string): boolean {
    return (
      conversation.kind === 'DIRECT' &&
      conversation.my_state === 'ACTIVE' &&
      conversation.members.length === 2 &&
      conversation.members.every((m) => m.state === 'ACTIVE') &&
      conversation.members.some((m) => m.user_id !== userId)
    );
  }

  async startCall(conversation: Conversation, media: CallMedia): Promise<void> {
    if (isBusy(this.snapshot.state)) return;
    if (!CallManager.canCall(conversation, this.userId)) {
      this.set({ error: 'Chỉ gọi được trong cuộc trò chuyện 1-1 mà cả hai đã chấp nhận.' });
      return;
    }
    const peer = conversation.members.find((m) => m.user_id !== this.userId)!;
    const callId = crypto.randomUUID();
    const call: ActiveCall = {
      callId,
      conversation,
      peerUserId: peer.user_id,
      pc: null,
      peerDeviceId: null,
      pendingLocalCandidates: [],
      pendingRemoteCandidates: [],
      flushTimer: null,
      ringTimer: null,
      disconnectTimer: null,
      restarts: 0,
    };
    this.call = call;
    this.set({
      error: null,
      muted: false,
      cameraOff: media !== 'video',
      peer: {
        userId: peer.user_id,
        name: peer.user?.display_name ?? 'Người dùng Winkey',
        avatarUrl: peer.user?.avatar_url ?? null,
      },
    });
    this.dispatch({
      type: 'START',
      callId,
      conversationId: conversation.id,
      media,
      now: this.now(),
    });

    try {
      const stream = await this.openMedia(media);
      this.set({ localStream: stream });
      const pc = await this.createPeer(call);
      call.pc = pc;
      this.attachLocal(pc, stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendRoom(call, {
        type: 'm.call.invite',
        v: 1,
        call_id: callId,
        media,
        sdp: offer.sdp!,
        lifetime_ms: CALL_LIFETIME_MS,
      });
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : 'Không bắt đầu được cuộc gọi.' });
      this.dispatch({ type: 'FAILED', now: this.now() });
      this.cleanup();
      return;
    }

    call.ringTimer = setTimeout(() => {
      if (this.call !== call || this.snapshot.state.status !== 'calling') return;
      void this.sendRoom(call, {
        type: 'm.call.hangup',
        v: 1,
        call_id: callId,
        reason: 'invite_timeout',
        duration_ms: 0,
      }).catch(() => {});
      this.dispatch({ type: 'TIMEOUT', callId, now: this.now() });
      this.cleanup();
    }, CALL_LIFETIME_MS);
  }

  // --- incoming ---------------------------------------------------------------------------------------------------

  async acceptCall(): Promise<void> {
    const call = this.call;
    const s = this.snapshot.state;
    if (!call || s.status !== 'ringing' || !call.remoteOffer) return;
    if (call.ringTimer) clearTimeout(call.ringTimer);
    this.dispatch({ type: 'ACCEPT', now: this.now(), callerDeviceId: s.callerDeviceId });
    call.peerDeviceId = s.callerDeviceId;
    try {
      const stream = await this.openMedia(s.media);
      this.set({ localStream: stream, cameraOff: s.media !== 'video' });
      const pc = await this.createPeer(call);
      call.pc = pc;
      await pc.setRemoteDescription({ type: 'offer', sdp: call.remoteOffer });
      this.attachLocal(pc, stream);
      for (const c of call.pendingRemoteCandidates.splice(0))
        await pc.addIceCandidate(c).catch(() => {});
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.sendRoom(call, {
        type: 'm.call.answer',
        v: 1,
        call_id: call.callId,
        sdp: answer.sdp!,
        answerer_device_id: this.ownDeviceId() ?? '',
      });
      this.scheduleCandidateFlush(call);
    } catch (err) {
      const reason: HangupReason =
        err instanceof CallMediaError ? 'user_media_failed' : 'ice_failed';
      this.set({ error: err instanceof Error ? err.message : 'Không nhận được cuộc gọi.' });
      await this.sendRoom(call, {
        type: 'm.call.hangup',
        v: 1,
        call_id: call.callId,
        reason,
        duration_ms: 0,
      }).catch(() => {});
      this.dispatch({ type: 'FAILED', now: this.now() });
      this.cleanup();
    }
  }

  async declineCall(): Promise<void> {
    const call = this.call;
    if (!call || this.snapshot.state.status !== 'ringing') return;
    this.dispatch({ type: 'DECLINE', now: this.now() });
    this.cleanup();
    await this.sendRoom(call, {
      type: 'm.call.reject',
      v: 1,
      call_id: call.callId,
      reason: 'declined',
    }).catch(() => {});
  }

  async hangup(reason: HangupReason = 'user_hangup'): Promise<void> {
    const call = this.call;
    const s = this.snapshot.state;
    if (!call || s.status === 'idle' || s.status === 'ended' || s.status === 'ringing') return;
    const duration = s.status === 'connected' ? this.now() - s.connectedAt : 0;
    this.dispatch({ type: 'HANGUP', now: this.now(), reason });
    this.cleanup();
    await this.sendRoom(call, {
      type: 'm.call.hangup',
      v: 1,
      call_id: call.callId,
      reason,
      duration_ms: Math.round(duration),
    }).catch(() => {});
  }

  /**
   * A Megolm call event from the conversation (validated by chat-service). `fresh` is false for history that was
   * sent before this page loaded: old invites never ring.
   */
  async handleRoomEvent(
    signal: IncomingCallSignal & { conversation: Conversation; fresh: boolean },
  ): Promise<void> {
    const { event, senderId, senderDeviceId, conversation } = signal;
    const fromMe = senderId === this.userId;
    const mine = this.ownDeviceId();
    const call = this.call;

    if (event.type === 'm.call.invite') {
      if (fromMe || !signal.fresh) return;
      if (isBusy(this.snapshot.state)) {
        if (call?.callId !== event.call_id) {
          await this.chat
            .sendMessage({
              conversation,
              text: '',
              callEvent: { type: 'm.call.reject', v: 1, call_id: event.call_id, reason: 'busy' },
            })
            .catch(() => {});
        }
        return;
      }
      const peer = conversation.members.find((m) => m.user_id === senderId);
      this.call = {
        callId: event.call_id,
        conversation,
        peerUserId: senderId,
        pc: null,
        peerDeviceId: senderDeviceId,
        remoteOffer: event.sdp,
        pendingLocalCandidates: [],
        pendingRemoteCandidates: [],
        flushTimer: null,
        ringTimer: null,
        disconnectTimer: null,
        restarts: 0,
      };
      this.set({
        error: null,
        muted: false,
        cameraOff: event.media !== 'video',
        localStream: null,
        remoteStream: null,
        peer: {
          userId: senderId,
          name: peer?.user?.display_name ?? 'Người dùng Winkey',
          avatarUrl: peer?.user?.avatar_url ?? null,
        },
      });
      this.dispatch({
        type: 'INVITE_RECEIVED',
        callId: event.call_id,
        conversationId: conversation.id,
        media: event.media,
        callerDeviceId: senderDeviceId,
        now: this.now(),
      });
      const ringing = this.call;
      const elapsed = signal.sentAt
        ? Math.max(0, Date.now() - new Date(signal.sentAt).getTime())
        : 0;
      ringing.ringTimer = setTimeout(
        () => {
          if (this.call === ringing && this.snapshot.state.status === 'ringing') {
            this.dispatch({ type: 'TIMEOUT', callId: ringing.callId, now: this.now() });
            this.cleanup();
          }
        },
        Math.max(1000, event.lifetime_ms - elapsed),
      );
      return;
    }

    if (!call || call.callId !== event.call_id) return;

    if (event.type === 'm.call.answer') {
      if (fromMe) {
        // Another of my devices answered: stop ringing here.
        if (event.answerer_device_id !== mine) {
          this.dispatch({ type: 'ANSWERED_ELSEWHERE', callId: call.callId, now: this.now() });
          this.cleanup();
        }
        return;
      }
      if (this.snapshot.state.status !== 'calling' || !call.pc) return;
      if (call.ringTimer) clearTimeout(call.ringTimer);
      call.peerDeviceId = event.answerer_device_id;
      this.dispatch({
        type: 'ANSWER_RECEIVED',
        callId: call.callId,
        answererDeviceId: event.answerer_device_id,
        now: this.now(),
      });
      await call.pc.setRemoteDescription({ type: 'answer', sdp: event.sdp });
      for (const c of call.pendingRemoteCandidates.splice(0))
        await call.pc.addIceCandidate(c).catch(() => {});
      this.scheduleCandidateFlush(call);
      // Tell the callee's other devices to stop ringing.
      void this.sendDevice(
        call,
        {
          type: 'm.call.select_answer',
          v: 1,
          call_id: call.callId,
          device_id: event.answerer_device_id,
        },
        true,
      );
      return;
    }

    if (event.type === 'm.call.reject') {
      if (fromMe) {
        if (this.snapshot.state.status === 'ringing') {
          this.dispatch({ type: 'ANSWERED_ELSEWHERE', callId: call.callId, now: this.now() });
          this.cleanup();
        }
        return;
      }
      this.dispatch({
        type: 'REJECT_RECEIVED',
        callId: call.callId,
        reason: event.reason,
        now: this.now(),
      });
      this.cleanup();
      return;
    }

    if (event.type === 'm.call.hangup') {
      this.dispatch({
        type: 'REMOTE_HANGUP',
        callId: call.callId,
        reason: event.reason,
        now: this.now(),
      });
      this.cleanup();
    }
  }

  /** A to-device call event (candidates, select_answer, negotiate) from chat-service. */
  async handleDeviceEvent(signal: IncomingCallSignal): Promise<void> {
    const call = this.call;
    const event = signal.event;
    if (!call || event.call_id !== call.callId) return;
    if (event.type === 'm.call.select_answer') {
      if (this.snapshot.state.status === 'ringing' && event.device_id !== this.ownDeviceId()) {
        this.dispatch({ type: 'ANSWERED_ELSEWHERE', callId: call.callId, now: this.now() });
        this.cleanup();
      }
      return;
    }
    if (signal.senderId !== call.peerUserId) return;
    if (call.peerDeviceId && signal.senderDeviceId !== call.peerDeviceId) return;
    if (event.type === 'm.call.candidates') {
      for (const c of event.candidates) {
        if (!c.candidate) continue;
        const init: RTCIceCandidateInit = {
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
        };
        if (call.pc?.remoteDescription) await call.pc.addIceCandidate(init).catch(() => {});
        else call.pendingRemoteCandidates.push(init);
      }
      return;
    }
    if (event.type === 'm.call.negotiate' && call.pc) {
      if (event.kind === 'offer') {
        await call.pc.setRemoteDescription({ type: 'offer', sdp: event.sdp });
        const answer = await call.pc.createAnswer();
        await call.pc.setLocalDescription(answer);
        await this.sendDevice(call, {
          type: 'm.call.negotiate',
          v: 1,
          call_id: call.callId,
          kind: 'answer',
          sdp: answer.sdp!,
        });
      } else {
        await call.pc.setRemoteDescription({ type: 'answer', sdp: event.sdp });
      }
    }
  }

  // --- controls ---------------------------------------------------------------------------------------------------

  toggleMute(): void {
    const stream = this.snapshot.localStream;
    const muted = !this.snapshot.muted;
    stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
  }

  /** Camera on/off; turning it on in a voice call switches the call to video (no renegotiation). */
  async toggleCamera(): Promise<void> {
    const call = this.call;
    const stream = this.snapshot.localStream;
    if (!call?.pc || !stream) return;
    const current = stream.getVideoTracks()[0];
    if (current && !this.snapshot.cameraOff) {
      current.enabled = false;
      this.set({ cameraOff: true });
      return;
    }
    if (current) {
      current.enabled = true;
      this.set({ cameraOff: false });
      return;
    }
    try {
      const cam = await (this.deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c)))(
        { video: true },
      );
      const track = cam.getVideoTracks()[0]!;
      stream.addTrack(track);
      await call.pc.getTransceivers()[1]?.sender.replaceTrack(track);
      this.set({ cameraOff: false, localStream: stream, error: null });
      this.dispatch({ type: 'MEDIA', media: 'video' });
    } catch (err) {
      this.set({ error: mediaErrorMessage(err) });
    }
  }

  /** Switches the microphone or camera to `deviceId` by replacing the sent track. */
  async useDevice(kind: 'audioinput' | 'videoinput', deviceId: string): Promise<void> {
    const call = this.call;
    const stream = this.snapshot.localStream;
    if (!call?.pc || !stream) return;
    try {
      const gum = this.deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
      const fresh = await gum(
        kind === 'audioinput'
          ? { audio: { deviceId: { exact: deviceId } } }
          : { video: { deviceId: { exact: deviceId } } },
      );
      const track = kind === 'audioinput' ? fresh.getAudioTracks()[0]! : fresh.getVideoTracks()[0]!;
      const old = kind === 'audioinput' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      if (old) {
        stream.removeTrack(old);
        old.stop();
      }
      if (kind === 'audioinput') track.enabled = !this.snapshot.muted;
      stream.addTrack(track);
      await call.pc.getTransceivers()[kind === 'audioinput' ? 0 : 1]?.sender.replaceTrack(track);
      this.set({ localStream: stream });
    } catch (err) {
      this.set({ error: mediaErrorMessage(err) });
    }
  }

  dismiss(): void {
    if (this.snapshot.state.status === 'ended') {
      this.dispatch({ type: 'RESET' });
      this.set({ peer: null, error: null, localStream: null, remoteStream: null });
    }
  }

  private cleanup(): void {
    const call = this.call;
    if (call) {
      for (const t of [call.flushTimer, call.ringTimer, call.disconnectTimer])
        if (t) clearTimeout(t);
      call.pc?.close();
    }
    this.snapshot.localStream?.getTracks().forEach((t) => t.stop());
    this.call = null;
    this.set({ localStream: null, remoteStream: null });
  }
}
