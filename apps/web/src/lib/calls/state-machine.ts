import type { CallMedia, HangupReason, RejectReason } from './events';

/**
 * The call lifecycle on one device (SOC-4a), as a pure reducer so it is testable without WebRTC.
 *
 *   outgoing: idle → calling → connecting → connected → ended
 *   incoming: idle → ringing → connecting → connected → ended
 *
 * `ended.outcome` is what the history and the UI show: completed, missed (45 s without answer), rejected, busy,
 * answered_elsewhere (another of my devices took it), failed (media or ICE).
 */
export type CallDirection = 'outgoing' | 'incoming';
export type CallOutcome =
  'completed' | 'missed' | 'rejected' | 'busy' | 'answered_elsewhere' | 'failed' | 'cancelled';

export type CallState =
  | { status: 'idle' }
  | {
      status: 'calling';
      callId: string;
      conversationId: string;
      media: CallMedia;
      startedAt: number;
    }
  | {
      status: 'ringing';
      callId: string;
      conversationId: string;
      media: CallMedia;
      startedAt: number;
      callerDeviceId: string;
    }
  | {
      status: 'connecting';
      callId: string;
      conversationId: string;
      media: CallMedia;
      direction: CallDirection;
      startedAt: number;
      peerDeviceId: string;
    }
  | {
      status: 'connected';
      callId: string;
      conversationId: string;
      media: CallMedia;
      direction: CallDirection;
      startedAt: number;
      connectedAt: number;
      peerDeviceId: string;
      reconnecting: boolean;
    }
  | {
      status: 'ended';
      callId: string;
      conversationId: string;
      media: CallMedia;
      direction: CallDirection;
      outcome: CallOutcome;
      durationMs: number;
      endedAt: number;
    };

export type CallAction =
  | { type: 'START'; callId: string; conversationId: string; media: CallMedia; now: number }
  | {
      type: 'INVITE_RECEIVED';
      callId: string;
      conversationId: string;
      media: CallMedia;
      callerDeviceId: string;
      now: number;
    }
  | { type: 'ACCEPT'; now: number; callerDeviceId: string }
  | { type: 'ANSWER_RECEIVED'; callId: string; answererDeviceId: string; now: number }
  | { type: 'ANSWERED_ELSEWHERE'; callId: string; now: number }
  | { type: 'ICE_CONNECTED'; now: number }
  | { type: 'ICE_DISCONNECTED' }
  | { type: 'REJECT_RECEIVED'; callId: string; reason?: RejectReason; now: number }
  | { type: 'DECLINE'; now: number }
  | { type: 'HANGUP'; now: number; reason?: HangupReason }
  | { type: 'REMOTE_HANGUP'; callId: string; reason: HangupReason; now: number }
  | { type: 'TIMEOUT'; callId: string; now: number }
  | { type: 'FAILED'; now: number }
  | { type: 'MEDIA'; media: CallMedia }
  | { type: 'RESET' };

export const IDLE: CallState = { status: 'idle' };

function end(
  s: Exclude<CallState, { status: 'idle' } | { status: 'ended' }>,
  outcome: CallOutcome,
  now: number,
): CallState {
  return {
    status: 'ended',
    callId: s.callId,
    conversationId: s.conversationId,
    media: s.media,
    direction:
      s.status === 'calling' ? 'outgoing' : s.status === 'ringing' ? 'incoming' : s.direction,
    outcome,
    durationMs: s.status === 'connected' ? Math.max(0, now - s.connectedAt) : 0,
    endedAt: now,
  };
}

/** True when an incoming invite must be answered `busy` instead of ringing. */
export function isBusy(state: CallState): boolean {
  return state.status !== 'idle' && state.status !== 'ended';
}

export function callReducer(state: CallState, action: CallAction): CallState {
  switch (action.type) {
    case 'START':
      if (isBusy(state)) return state;
      return {
        status: 'calling',
        callId: action.callId,
        conversationId: action.conversationId,
        media: action.media,
        startedAt: action.now,
      };
    case 'INVITE_RECEIVED':
      if (isBusy(state)) return state; // the manager answers `busy`
      return {
        status: 'ringing',
        callId: action.callId,
        conversationId: action.conversationId,
        media: action.media,
        startedAt: action.now,
        callerDeviceId: action.callerDeviceId,
      };
    case 'ACCEPT':
      if (state.status !== 'ringing') return state;
      return {
        status: 'connecting',
        callId: state.callId,
        conversationId: state.conversationId,
        media: state.media,
        direction: 'incoming',
        startedAt: state.startedAt,
        peerDeviceId: action.callerDeviceId,
      };
    case 'ANSWER_RECEIVED':
      if (state.status !== 'calling' || state.callId !== action.callId) return state;
      return {
        status: 'connecting',
        callId: state.callId,
        conversationId: state.conversationId,
        media: state.media,
        direction: 'outgoing',
        startedAt: state.startedAt,
        peerDeviceId: action.answererDeviceId,
      };
    case 'ANSWERED_ELSEWHERE':
      if (state.status !== 'ringing' || state.callId !== action.callId) return state;
      return end(state, 'answered_elsewhere', action.now);
    case 'ICE_CONNECTED':
      if (state.status === 'connecting') {
        return { ...state, status: 'connected', connectedAt: action.now, reconnecting: false };
      }
      if (state.status === 'connected' && state.reconnecting)
        return { ...state, reconnecting: false };
      return state;
    case 'ICE_DISCONNECTED':
      if (state.status === 'connected' && !state.reconnecting)
        return { ...state, reconnecting: true };
      return state;
    case 'REJECT_RECEIVED':
      if (state.status !== 'calling' || state.callId !== action.callId) return state;
      return end(state, action.reason === 'busy' ? 'busy' : 'rejected', action.now);
    case 'DECLINE':
      if (state.status !== 'ringing') return state;
      return end(state, 'rejected', action.now);
    case 'HANGUP':
      if (state.status === 'idle' || state.status === 'ended' || state.status === 'ringing')
        return state;
      return end(
        state,
        state.status === 'calling'
          ? 'cancelled'
          : action.reason === 'ice_failed'
            ? 'failed'
            : 'completed',
        action.now,
      );
    case 'REMOTE_HANGUP':
      if (state.status === 'idle' || state.status === 'ended' || state.callId !== action.callId)
        return state;
      if (state.status === 'ringing') return end(state, 'missed', action.now);
      return end(state, action.reason === 'ice_failed' ? 'failed' : 'completed', action.now);
    case 'TIMEOUT':
      if (
        (state.status !== 'calling' && state.status !== 'ringing') ||
        state.callId !== action.callId
      )
        return state;
      return end(state, 'missed', action.now);
    case 'FAILED':
      if (state.status === 'idle' || state.status === 'ended') return state;
      return end(state, 'failed', action.now);
    case 'MEDIA':
      if (state.status === 'idle') return state;
      return { ...state, media: action.media };
    case 'RESET':
      return IDLE;
  }
}
