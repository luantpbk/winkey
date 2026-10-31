/**
 * SOC-4a call signaling events (ADR-049 SOC-4a addendum). They travel end-to-end encrypted: invite, answer,
 * reject and hangup as Megolm messages in the DIRECT conversation; candidates, select_answer and negotiate as Olm
 * to-device messages to the one device in the call. chat-svc never sees SDP, DTLS fingerprints or candidates.
 *
 * Every event carries `v: 1`. Incoming events are validated here and anything unknown or malformed is ignored.
 */

export const CALL_EVENT_VERSION = 1;
/** An unanswered invite rings for 45 s, then it is a missed call. */
export const CALL_LIFETIME_MS = 45_000;
const MAX_SDP = 32_000;
const MAX_CANDIDATES = 50;

export type CallMedia = 'audio' | 'video';
export type HangupReason = 'user_hangup' | 'invite_timeout' | 'ice_failed' | 'user_media_failed';
export type RejectReason = 'declined' | 'busy';

export interface CallInvite {
  type: 'm.call.invite';
  v: 1;
  call_id: string;
  media: CallMedia;
  sdp: string;
  lifetime_ms: number;
}
export interface CallAnswer {
  type: 'm.call.answer';
  v: 1;
  call_id: string;
  sdp: string;
  answerer_device_id: string;
}
export interface CallReject {
  type: 'm.call.reject';
  v: 1;
  call_id: string;
  reason?: RejectReason;
}
export interface CallHangup {
  type: 'm.call.hangup';
  v: 1;
  call_id: string;
  reason: HangupReason;
  duration_ms: number;
}
export type CallRoomEvent = CallInvite | CallAnswer | CallReject | CallHangup;

export interface CallCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}
export interface CallCandidates {
  type: 'm.call.candidates';
  v: 1;
  call_id: string;
  candidates: CallCandidate[];
}
export interface CallSelectAnswer {
  type: 'm.call.select_answer';
  v: 1;
  call_id: string;
  device_id: string;
}
/** ICE restart after a network change: a new offer or answer inside the same call (to-device). */
export interface CallNegotiate {
  type: 'm.call.negotiate';
  v: 1;
  call_id: string;
  kind: 'offer' | 'answer';
  sdp: string;
}
export type CallDeviceEvent = CallCandidates | CallSelectAnswer | CallNegotiate;
export type CallEvent = CallRoomEvent | CallDeviceEvent;

const ID = /^[A-Za-z0-9-]{8,64}$/;
const isStr = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function parseCandidate(value: unknown): CallCandidate | null {
  if (typeof value !== 'object' || value === null) return null;
  const c = value as Record<string, unknown>;
  // An empty candidate string is the end-of-candidates marker.
  if (typeof c.candidate !== 'string' || c.candidate.length > 1024) return null;
  if (c.sdpMid !== null && !isStr(c.sdpMid, 64)) return null;
  if (c.sdpMLineIndex !== null && !isInt(c.sdpMLineIndex, 0, 64)) return null;
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid as string | null,
    sdpMLineIndex: c.sdpMLineIndex as number | null,
  };
}

/** Validates any call event (room or device). Returns null for anything this client does not understand. */
export function parseCallEvent(value: unknown): CallEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (e.v !== CALL_EVENT_VERSION || !isStr(e.call_id, 64) || !ID.test(e.call_id)) return null;
  const base = { v: 1 as const, call_id: e.call_id };
  switch (e.type) {
    case 'm.call.invite':
      if ((e.media !== 'audio' && e.media !== 'video') || !isStr(e.sdp, MAX_SDP)) return null;
      if (!isInt(e.lifetime_ms, 5_000, 120_000)) return null;
      return { type: e.type, ...base, media: e.media, sdp: e.sdp, lifetime_ms: e.lifetime_ms };
    case 'm.call.answer':
      if (!isStr(e.sdp, MAX_SDP) || !isStr(e.answerer_device_id, 64)) return null;
      return { type: e.type, ...base, sdp: e.sdp, answerer_device_id: e.answerer_device_id };
    case 'm.call.reject':
      if (e.reason !== undefined && e.reason !== 'declined' && e.reason !== 'busy') return null;
      return { type: e.type, ...base, ...(e.reason ? { reason: e.reason as RejectReason } : {}) };
    case 'm.call.hangup': {
      const reasons: HangupReason[] = [
        'user_hangup',
        'invite_timeout',
        'ice_failed',
        'user_media_failed',
      ];
      if (!reasons.includes(e.reason as HangupReason) || !isInt(e.duration_ms, 0, 86_400_000))
        return null;
      return {
        type: e.type,
        ...base,
        reason: e.reason as HangupReason,
        duration_ms: e.duration_ms,
      };
    }
    case 'm.call.candidates': {
      if (
        !Array.isArray(e.candidates) ||
        e.candidates.length === 0 ||
        e.candidates.length > MAX_CANDIDATES
      ) {
        return null;
      }
      const candidates = e.candidates.map(parseCandidate);
      if (candidates.some((c) => c === null)) return null;
      return { type: e.type, ...base, candidates: candidates as CallCandidate[] };
    }
    case 'm.call.select_answer':
      if (!isStr(e.device_id, 64)) return null;
      return { type: e.type, ...base, device_id: e.device_id };
    case 'm.call.negotiate':
      if ((e.kind !== 'offer' && e.kind !== 'answer') || !isStr(e.sdp, MAX_SDP)) return null;
      return { type: e.type, ...base, kind: e.kind, sdp: e.sdp };
    default:
      return null;
  }
}

export function isRoomEvent(e: CallEvent): e is CallRoomEvent {
  return (
    e.type === 'm.call.invite' ||
    e.type === 'm.call.answer' ||
    e.type === 'm.call.reject' ||
    e.type === 'm.call.hangup'
  );
}

/** History line for the chat ("Cuộc gọi thoại · 3 phút", "Cuộc gọi video nhỡ", …); null hides the event. */
export function describeCallEvent(
  event: CallRoomEvent,
  media: CallMedia | null,
  ownEvent: boolean,
): string | null {
  const kind =
    media === 'video' ? 'Cuộc gọi video' : media === 'audio' ? 'Cuộc gọi thoại' : 'Cuộc gọi';
  if (event.type === 'm.call.hangup') {
    if (event.reason === 'invite_timeout')
      return ownEvent ? `${kind} không được trả lời` : `${kind} nhỡ`;
    if (event.duration_ms <= 0) return `${kind} đã kết thúc`;
    const minutes = Math.max(1, Math.round(event.duration_ms / 60_000));
    return event.duration_ms < 60_000
      ? `${kind} · ${Math.round(event.duration_ms / 1000)} giây`
      : `${kind} · ${minutes} phút`;
  }
  if (event.type === 'm.call.reject') {
    return event.reason === 'busy' ? `${kind} · người nhận đang bận` : `${kind} bị từ chối`;
  }
  return null; // invite and answer are part of a call, shown once it ends
}
