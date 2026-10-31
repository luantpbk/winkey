'use client';

import React, { useEffect } from 'react';
import { Phone, PhoneOff, Video } from 'lucide-react';
import type { CallManager, CallSnapshot } from '../../lib/calls/call-manager';

/** A short two-tone ring generated with WebAudio (no audio file, nothing for the CSP to allow). */
function useRingtone(active: boolean) {
  useEffect(() => {
    if (!active || typeof window === 'undefined' || !('AudioContext' in window)) return;
    const ctx = new AudioContext();
    let stopped = false;
    const ring = () => {
      if (stopped) return;
      for (const [i, freq] of [440, 480].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.05;
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.02);
        osc.stop(ctx.currentTime + 1.2);
      }
    };
    ring();
    const timer = setInterval(ring, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
      void ctx.close();
    };
  }, [active]);
}

export function IncomingCallOverlay({
  manager,
  snapshot,
}: {
  manager: CallManager;
  snapshot: CallSnapshot;
}) {
  const state = snapshot.state;
  useRingtone(state.status === 'ringing');
  if (state.status !== 'ringing') return null;
  const video = state.media === 'video';
  const name = snapshot.peer?.name ?? 'Người dùng Winkey';

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="incoming-call-title"
      aria-describedby="incoming-call-desc"
      className="fixed right-4 top-16 z-[60] w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-[#1c1c1c]"
    >
      <div className="flex items-center gap-3">
        {snapshot.peer?.avatarUrl ? (
          <img
            src={snapshot.peer.avatarUrl}
            alt=""
            className="h-12 w-12 rounded-full object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-lg font-bold text-white"
          >
            {name.charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p
            id="incoming-call-title"
            className="truncate text-sm font-semibold text-zinc-900 dark:text-white"
          >
            {name}
          </p>
          <p id="incoming-call-desc" className="text-xs text-zinc-600 dark:text-zinc-400">
            {video ? 'Cuộc gọi video đến…' : 'Cuộc gọi thoại đến…'} · mã hoá đầu cuối
          </p>
        </div>
      </div>
      {snapshot.error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {snapshot.error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => void manager.declineCall()}
          className="inline-flex items-center gap-1.5 rounded-full bg-zinc-200 px-4 py-2 text-xs font-semibold text-zinc-900 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-white dark:hover:bg-zinc-700"
        >
          <PhoneOff className="h-4 w-4" aria-hidden="true" />
          Từ chối
        </button>
        <button
          type="button"
          onClick={() => void manager.acceptCall()}
          autoFocus
          className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
        >
          {video ? (
            <Video className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Phone className="h-4 w-4" aria-hidden="true" />
          )}
          Trả lời
        </button>
      </div>
    </div>
  );
}
