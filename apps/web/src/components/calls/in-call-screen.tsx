'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, Video, VideoOff, Settings2, X } from 'lucide-react';
import type { CallManager, CallSnapshot } from '../../lib/calls/call-manager';
import type { CallOutcome } from '../../lib/calls/state-machine';

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const OUTCOME: Record<CallOutcome, string> = {
  completed: 'Cuộc gọi đã kết thúc',
  missed: 'Không có người trả lời',
  rejected: 'Cuộc gọi bị từ chối',
  busy: 'Người nhận đang bận',
  answered_elsewhere: 'Đã trả lời trên thiết bị khác',
  failed: 'Cuộc gọi bị gián đoạn',
  cancelled: 'Đã huỷ cuộc gọi',
};

function MediaVideo({
  stream,
  muted,
  className,
  label,
}: {
  stream: MediaStream | null;
  muted: boolean;
  className: string;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} className={className} />
  );
}

function DevicePicker({ manager, onClose }: { manager: CallManager; onClose: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);
  const group = (kind: MediaDeviceKind) => devices.filter((d) => d.kind === kind && d.deviceId);
  const sinkSupported =
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  return (
    <div
      role="dialog"
      aria-label="Chọn thiết bị"
      className="absolute bottom-24 left-1/2 z-10 w-[min(22rem,calc(100%-2rem))] -translate-x-1/2 space-y-3 rounded-2xl bg-zinc-900/95 p-4 text-xs text-white shadow-2xl"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">Thiết bị</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng"
          className="rounded p-1 hover:bg-white/10"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {(['audioinput', 'videoinput'] as const).map((kind) => (
        <label key={kind} className="block space-y-1">
          <span>{kind === 'audioinput' ? 'Micro' : 'Camera'}</span>
          <select
            className="w-full rounded-lg bg-zinc-800 px-2 py-1.5"
            onChange={(e) => void manager.useDevice(kind, e.target.value)}
            defaultValue=""
          >
            <option value="" disabled>
              Chọn {kind === 'audioinput' ? 'micro' : 'camera'}
            </option>
            {group(kind).map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `${kind === 'audioinput' ? 'Micro' : 'Camera'} ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      ))}
      {sinkSupported && (
        <label className="block space-y-1">
          <span>Loa</span>
          <select
            className="w-full rounded-lg bg-zinc-800 px-2 py-1.5"
            defaultValue=""
            onChange={(e) => {
              document
                .querySelectorAll<HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }>(
                  '[data-call-remote]',
                )
                .forEach((el) => {
                  void el.setSinkId?.(e.target.value).catch(() => {});
                });
            }}
          >
            <option value="" disabled>
              Chọn loa
            </option>
            {group('audiooutput').map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Loa ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export function InCallScreen({
  manager,
  snapshot,
}: {
  manager: CallManager;
  snapshot: CallSnapshot;
}) {
  const state = snapshot.state;
  const [now, setNow] = useState(() => Date.now());
  const [showDevices, setShowDevices] = useState(false);
  const remoteAudio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (remoteAudio.current && remoteAudio.current.srcObject !== snapshot.remoteStream) {
      remoteAudio.current.srcObject = snapshot.remoteStream;
    }
  }, [snapshot.remoteStream]);
  // An ended call shows its outcome briefly, then closes.
  useEffect(() => {
    if (state.status !== 'ended') return;
    const t = setTimeout(() => manager.dismiss(), 4000);
    return () => clearTimeout(t);
  }, [state.status, manager]);

  if (state.status === 'idle' || state.status === 'ringing') return null;
  const name = snapshot.peer?.name ?? 'Người dùng Winkey';
  const remoteHasVideo = (snapshot.remoteStream?.getVideoTracks() ?? []).some(
    (t) => t.readyState === 'live' && !t.muted,
  );
  const showRemoteVideo = state.media === 'video' && state.status === 'connected' && remoteHasVideo;
  const localHasVideo =
    !snapshot.cameraOff && (snapshot.localStream?.getVideoTracks().length ?? 0) > 0;

  const status =
    state.status === 'calling'
      ? 'Đang gọi…'
      : state.status === 'connecting'
        ? 'Đang kết nối…'
        : state.status === 'connected'
          ? state.reconnecting
            ? 'Đang kết nối lại…'
            : formatDuration(now - state.connectedAt)
          : OUTCOME[state.outcome];

  const ctrl =
    'flex h-12 w-12 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Cuộc gọi với ${name}`}
      className="fixed inset-0 z-[70] flex flex-col bg-zinc-950 text-white"
    >
      <audio ref={remoteAudio} autoPlay data-call-remote />
      <div className="relative flex-1 overflow-hidden">
        {showRemoteVideo ? (
          <MediaVideo
            stream={snapshot.remoteStream}
            muted
            className="h-full w-full object-cover"
            label={`Video của ${name}`}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            {snapshot.peer?.avatarUrl ? (
              <img
                src={snapshot.peer.avatarUrl}
                alt=""
                className="h-28 w-28 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-28 w-28 items-center justify-center rounded-full bg-red-600 text-4xl font-bold"
              >
                {name.charAt(0).toUpperCase()}
              </span>
            )}
            <p className="text-xl font-semibold">{name}</p>
          </div>
        )}
        <p
          data-testid="call-status"
          aria-live="polite"
          className="absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-sm"
        >
          {status}
        </p>
        {localHasVideo && state.status !== 'ended' && (
          <MediaVideo
            stream={snapshot.localStream}
            muted
            label="Camera của bạn"
            className="absolute bottom-4 right-4 h-36 w-24 rounded-xl border border-white/20 object-cover shadow-lg sm:h-40 sm:w-60"
          />
        )}
        {snapshot.error && (
          <p
            role="alert"
            className="absolute inset-x-4 bottom-4 rounded-xl bg-red-600/90 p-3 text-center text-xs"
          >
            {snapshot.error}
          </p>
        )}
        {showDevices && <DevicePicker manager={manager} onClose={() => setShowDevices(false)} />}
      </div>
      {state.status !== 'ended' ? (
        <div className="flex items-center justify-center gap-4 bg-black/60 px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => manager.toggleMute()}
            aria-pressed={snapshot.muted}
            aria-label={snapshot.muted ? 'Bật micro' : 'Tắt micro'}
            className={`${ctrl} ${snapshot.muted ? 'bg-white text-zinc-900' : 'bg-white/15'}`}
          >
            {snapshot.muted ? (
              <MicOff className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Mic className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void manager.toggleCamera()}
            aria-pressed={!snapshot.cameraOff}
            aria-label={
              snapshot.cameraOff
                ? state.media === 'video'
                  ? 'Bật camera'
                  : 'Chuyển sang gọi video'
                : 'Tắt camera'
            }
            className={`${ctrl} ${snapshot.cameraOff ? 'bg-white/15' : 'bg-white text-zinc-900'}`}
          >
            {snapshot.cameraOff ? (
              <VideoOff className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Video className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setShowDevices((v) => !v)}
            aria-label="Chọn micro, camera, loa"
            aria-expanded={showDevices}
            className={`${ctrl} bg-white/15`}
          >
            <Settings2 className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void manager.hangup()}
            aria-label="Kết thúc cuộc gọi"
            className={`${ctrl} h-14 w-14 bg-red-600 hover:bg-red-500`}
          >
            <PhoneOff className="h-6 w-6" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="flex justify-center bg-black/60 px-4 py-5">
          <button
            type="button"
            onClick={() => manager.dismiss()}
            className="rounded-full bg-white/15 px-5 py-2 text-sm"
          >
            Đóng
          </button>
        </div>
      )}
    </div>
  );
}
