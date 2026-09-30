'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  parseStoryboardVtt,
  findStoryboardCue,
  type StoryboardCue,
} from '../../lib/video/storyboard-parser';

export interface SeekBarProps {
  currentTime: number;
  duration: number;
  buffered?: number;
  storyboardUrl?: string | null;
  onSeek: (timeInSeconds: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function SeekBar({
  currentTime,
  duration,
  buffered = 0,
  storyboardUrl,
  onSeek,
  onScrubStart,
  onScrubEnd,
}: SeekBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverTime, setHoverTime] = useState(0);
  const [hoverX, setHoverX] = useState(0);
  const [barWidth, setBarWidth] = useState(0);

  const [storyboardCues, setStoryboardCues] = useState<StoryboardCue[]>([]);
  const hasFetchedStoryboardRef = useRef(false);

  // Lazy fetch storyboard .vtt once on first hover / scrub interaction
  const ensureStoryboardLoaded = useCallback(async () => {
    if (hasFetchedStoryboardRef.current || !storyboardUrl) return;
    hasFetchedStoryboardRef.current = true;

    try {
      const res = await fetch(storyboardUrl);
      if (!res.ok) return;
      const text = await res.text();
      const cues = parseStoryboardVtt(text, storyboardUrl);
      setStoryboardCues(cues);
    } catch {
      // Graceful fallback to plain time tooltip
    }
  }, [storyboardUrl]);

  // Reset storyboard cache if storyboardUrl changes (e.g. refreshed signed URL)
  useEffect(() => {
    hasFetchedStoryboardRef.current = false;
    setStoryboardCues([]);
  }, [storyboardUrl]);

  const calculateTimeFromClientX = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar) return { time: 0, x: 0 };
      const rect = bar.getBoundingClientRect();
      setBarWidth(rect.width);

      const offsetX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const ratio = rect.width > 0 ? offsetX / rect.width : 0;
      const validDuration = duration > 0 ? duration : 0;
      const time = ratio * validDuration;
      return { time, x: offsetX };
    },
    [duration],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    void ensureStoryboardLoaded();
    setIsDragging(true);
    onScrubStart?.();

    const { time, x } = calculateTimeFromClientX(e.clientX);
    setHoverTime(time);
    setHoverX(x);
    onSeek(time);
  };

  useEffect(() => {
    if (!isDragging) return;

    function handlePointerMove(e: PointerEvent) {
      const { time, x } = calculateTimeFromClientX(e.clientX);
      setHoverTime(time);
      setHoverX(x);
      onSeek(time);
    }

    function handlePointerUp() {
      setIsDragging(false);
      onScrubEnd?.();
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDragging, calculateTimeFromClientX, onSeek, onScrubEnd]);

  const handlePointerEnter = (e: React.PointerEvent<HTMLDivElement>) => {
    void ensureStoryboardLoaded();
    setIsHovered(true);
    const { time, x } = calculateTimeFromClientX(e.clientX);
    setHoverTime(time);
    setHoverX(x);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) return;
    const { time, x } = calculateTimeFromClientX(e.clientX);
    setHoverTime(time);
    setHoverX(x);
  };

  const handlePointerLeave = () => {
    if (!isDragging) {
      setIsHovered(false);
    }
  };

  const currentPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;
  const hoverPercent = duration > 0 ? (hoverTime / duration) * 100 : 0;

  // Find matching storyboard cue for preview
  const activeCue = storyboardCues.length > 0 ? findStoryboardCue(storyboardCues, hoverTime) : null;
  const showPreview = (isHovered || isDragging) && duration > 0;

  // Clamp preview box to stay within bounds
  const previewWidth = activeCue ? activeCue.w : 70;
  const halfWidth = previewWidth / 2;
  const clampedLeft = Math.max(
    halfWidth,
    Math.min(barWidth > 0 ? barWidth - halfWidth : hoverX, hoverX),
  );

  return (
    <div
      ref={barRef}
      role="slider"
      aria-label="Thanh thời gian video"
      aria-valuemin={0}
      aria-valuemax={duration || 100}
      aria-valuenow={currentTime}
      aria-valuetext={formatTime(currentTime)}
      tabIndex={0}
      data-testid="seek-bar"
      onPointerEnter={handlePointerEnter}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      className="group/seek relative w-full h-4 cursor-pointer flex items-center select-none touch-none focus:outline-none"
    >
      {/* Track Background */}
      <div className="relative w-full h-1 group-hover/seek:h-2 transition-all duration-150 rounded-full bg-white/20 overflow-hidden">
        {/* Buffered Progress */}
        <div
          data-testid="seek-bar-buffered"
          className="absolute top-0 left-0 h-full bg-white/40 transition-all duration-200"
          style={{ width: `${bufferedPercent}%` }}
        />

        {/* Hover ghost bar */}
        {isHovered && (
          <div
            data-testid="seek-bar-ghost"
            className="absolute top-0 left-0 h-full bg-white/30"
            style={{ width: `${hoverPercent}%` }}
          />
        )}

        {/* Played Progress */}
        <div
          data-testid="seek-bar-played"
          className="absolute top-0 left-0 h-full bg-red-600"
          style={{ width: `${currentPercent}%` }}
        />
      </div>

      {/* Scrub Scrubber Thumb */}
      <div
        data-testid="seek-thumb"
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3.5 w-3.5 rounded-full bg-red-600 shadow-md transition-transform scale-0 group-hover/seek:scale-100 group-active/seek:scale-125"
        style={{ left: `${currentPercent}%` }}
      />

      {/* Hover / Scrub Preview Overlay (Thumbnail + Timestamp) */}
      {showPreview && (
        <div
          data-testid="seek-preview-container"
          className="absolute bottom-full mb-3 -translate-x-1/2 flex flex-col items-center pointer-events-none z-50 transition-opacity duration-150"
          style={{ left: `${clampedLeft}px` }}
        >
          {activeCue ? (
            <div className="flex flex-col items-center gap-1.5 p-1 rounded-xl bg-gray-950/95 shadow-2xl border border-white/20 backdrop-blur-md">
              <div
                data-testid="storyboard-thumbnail"
                className="overflow-hidden rounded-lg bg-black"
                style={{
                  width: `${activeCue.w}px`,
                  height: `${activeCue.h}px`,
                  backgroundImage: `url(${activeCue.url})`,
                  backgroundPosition: `-${activeCue.x}px -${activeCue.y}px`,
                  backgroundRepeat: 'no-repeat',
                }}
              />
              <span
                data-testid="storyboard-timestamp"
                className="text-[11px] font-mono font-semibold text-gray-200"
              >
                {formatTime(hoverTime)}
              </span>
            </div>
          ) : (
            <div
              data-testid="time-tooltip"
              className="rounded-lg bg-gray-900/90 px-2 py-1 text-xs font-mono font-medium text-white shadow-xl border border-white/10 backdrop-blur-md"
            >
              {formatTime(hoverTime)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
