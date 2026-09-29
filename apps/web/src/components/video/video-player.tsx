'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { AlertCircle, RotateCcw } from 'lucide-react';
import type { Rendition } from '@winkey/api-client';
import { QualityMenu, type QualityLevel } from './quality-menu';
import { useViewCounter } from './use-view-counter';

export interface VideoPlayerProps {
  videoId?: string;
  durationMs?: number | null;
  src?: string;
  poster?: string;
  title?: string;
  renditions?: Rendition[];
  onRecordView?: (playbackId: string, watchedMs: number) => Promise<void> | void;
}

export function VideoPlayer({
  videoId,
  durationMs,
  src,
  poster,
  title,
  renditions,
  onRecordView,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [hasError, setHasError] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [qualityLevels, setQualityLevels] = useState<QualityLevel[]>([
    { index: -1, label: 'Tự động' },
  ]);
  const [currentLevel, setCurrentLevel] = useState<number>(-1);
  const [currentHeight, setCurrentHeight] = useState<number | undefined>(undefined);

  // QoE metrics tracking
  const loadStartTimeRef = useRef<number>(performance.now());
  const hasFirstFrameRef = useRef<boolean>(false);
  const rebufferCountRef = useRef<number>(0);
  const rebufferStartTimeRef = useRef<number | null>(null);
  const totalRebufferDurationRef = useRef<number>(0);

  // View counter hook
  const { onPlay, onTimeUpdate, onSeeking, onSeeked, onEnded } = useViewCounter({
    videoId: videoId || '',
    durationMs,
    onRecordView,
  });

  // LocalStorage progress helper
  const getStorageKey = useCallback(() => {
    return videoId ? `winkey_playback_pos_${videoId}` : null;
  }, [videoId]);

  const savePlaybackPosition = useCallback(
    (currentTime: number) => {
      const key = getStorageKey();
      if (!key || currentTime <= 0) return;
      try {
        localStorage.setItem(key, currentTime.toString());
      } catch {
        // Ignore storage exceptions (quota, private mode)
      }
    },
    [getStorageKey],
  );

  const clearPlaybackPosition = useCallback(() => {
    const key = getStorageKey();
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage exceptions
    }
  }, [getStorageKey]);

  const resumePlaybackPosition = useCallback(() => {
    const key = getStorageKey();
    const video = videoRef.current;
    if (!key || !video) return;

    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const time = parseFloat(saved);
        if (!isNaN(time) && time > 2) {
          // Only resume if not already at the end
          const maxResume = video.duration > 5 ? video.duration - 5 : video.duration;
          if (time < maxResume) {
            video.currentTime = time;
          }
        }
      }
    } catch {
      // Ignore storage errors
    }
  }, [getStorageKey]);

  // Setup HLS / Video playback
  const setupMedia = useCallback(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    setHasError(false);
    setErrorMessage('');
    loadStartTimeRef.current = performance.now();
    hasFirstFrameRef.current = false;
    rebufferCountRef.current = 0;
    rebufferStartTimeRef.current = null;
    totalRebufferDurationRef.current = 0;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });
      hlsRef.current = hls;

      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        const levels: QualityLevel[] = [{ index: -1, label: 'Tự động' }];
        data.levels.forEach((lvl, idx) => {
          levels.push({
            index: idx,
            label: lvl.name || (lvl.height ? `${lvl.height}p` : `Level ${idx + 1}`),
            height: lvl.height,
            bitrate: lvl.bitrate,
          });
        });
        setQualityLevels(levels);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const lvl = hls.levels[data.level];
        if (lvl) {
          setCurrentHeight(lvl.height);
          console.debug('[QoE] Rendition switched:', {
            level: data.level,
            height: lvl.height,
            bitrate: lvl.bitrate,
          });
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.warn('[HLS] Fatal network error encountered, attempting recovery...');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.warn('[HLS] Fatal media error encountered, attempting recovery...');
              hls.recoverMediaError();
              break;
            default:
              console.error('[HLS] Unrecoverable fatal error:', data);
              hls.destroy();
              setHasError(true);
              setErrorMessage('Không thể phát video do sự cố media. Vui lòng thử lại.');
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS for Safari/iOS
      video.src = src;

      // Provide renditions from props if available
      if (renditions && renditions.length > 0) {
        const levels: QualityLevel[] = [{ index: -1, label: 'Tự động' }];
        renditions.forEach((r, idx) => {
          levels.push({
            index: idx,
            label: r.name,
            height: r.height,
            bitrate: r.bitrate_kbps * 1000,
          });
        });
        setQualityLevels(levels);
      }
    } else {
      setHasError(true);
      setErrorMessage('Trình duyệt của bạn không hỗ trợ phát HLS stream.');
    }
  }, [src, renditions]);

  useEffect(() => {
    setupMedia();
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [setupMedia]);

  // Quality switch handler
  const handleSelectLevel = useCallback((levelIndex: number) => {
    setCurrentLevel(levelIndex);
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex;
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          (activeEl as HTMLElement).isContentEditable)
      ) {
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      switch (e.code) {
        case 'Space':
        case 'KeyK':
          e.preventDefault();
          if (video.paused) {
            void video.play();
          } else {
            video.pause();
          }
          break;
        case 'KeyJ':
          // Seek -10s
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case 'KeyL':
          // Seek +10s
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          break;
        case 'ArrowLeft':
          // Seek -5s
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case 'ArrowRight':
          // Seek +5s
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
          break;
        case 'KeyM':
          // Toggle mute
          video.muted = !video.muted;
          break;
        case 'KeyF':
          // Toggle fullscreen
          if (document.fullscreenElement) {
            void document.exitFullscreen();
          } else if (containerRef.current?.requestFullscreen) {
            void containerRef.current.requestFullscreen();
          }
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Video event handlers
  const handlePlayEvent = () => {
    const video = videoRef.current;
    if (!video) return;

    if (!hasFirstFrameRef.current) {
      hasFirstFrameRef.current = true;
      const startupTime = performance.now() - loadStartTimeRef.current;
      console.debug('[QoE] Startup time to first frame:', Math.round(startupTime), 'ms');
    }

    if (rebufferStartTimeRef.current !== null) {
      const rebuffDuration = performance.now() - rebufferStartTimeRef.current;
      totalRebufferDurationRef.current += rebuffDuration;
      rebufferStartTimeRef.current = null;
      console.debug('[QoE] Rebuffer stats:', {
        count: rebufferCountRef.current,
        totalDurationMs: Math.round(totalRebufferDurationRef.current),
      });
    }

    onPlay(video.currentTime);
  };

  const handleTimeUpdateEvent = () => {
    const video = videoRef.current;
    if (!video) return;

    savePlaybackPosition(video.currentTime);
    onTimeUpdate(video.currentTime);
  };

  const handleSeekingEvent = () => {
    onSeeking();
  };

  const handleSeekedEvent = () => {
    const video = videoRef.current;
    if (!video) return;
    onSeeked(video.currentTime);
  };

  const handleWaitingEvent = () => {
    if (hasFirstFrameRef.current && rebufferStartTimeRef.current === null) {
      rebufferCountRef.current += 1;
      rebufferStartTimeRef.current = performance.now();
    }
  };

  const handleEndedEvent = () => {
    clearPlaybackPosition();
    onEnded();
  };

  const handleVideoError = () => {
    setHasError(true);
    setErrorMessage('Lỗi tải video. Vui lòng kiểm tra kết nối mạng và thử lại.');
  };

  return (
    <div
      ref={containerRef}
      className="group relative aspect-video w-full overflow-hidden rounded-2xl bg-black shadow-2xl flex items-center justify-center"
    >
      <video
        ref={videoRef}
        poster={poster}
        controls
        playsInline
        aria-label={title || 'Video Player'}
        onLoadedMetadata={resumePlaybackPosition}
        onPlay={handlePlayEvent}
        onTimeUpdate={handleTimeUpdateEvent}
        onSeeking={handleSeekingEvent}
        onSeeked={handleSeekedEvent}
        onWaiting={handleWaitingEvent}
        onEnded={handleEndedEvent}
        onError={handleVideoError}
        className="h-full w-full object-contain"
      />

      {/* Quality Menu Overlay (positioned at top right when video is hover/controls visible) */}
      {!hasError && qualityLevels.length > 1 && (
        <div className="absolute top-3 right-3 z-30 transition-opacity duration-200">
          <QualityMenu
            levels={qualityLevels}
            currentLevel={currentLevel}
            currentHeight={currentHeight}
            onSelectLevel={handleSelectLevel}
          />
        </div>
      )}

      {/* Error Overlay with Retry Button */}
      {hasError && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-gray-950/90 p-6 text-center text-white backdrop-blur-sm">
          <AlertCircle className="h-12 w-12 text-red-500 mb-3" />
          <h3 className="text-base font-semibold mb-1">Không thể phát video</h3>
          <p className="text-xs text-gray-300 max-w-md mb-4">{errorMessage}</p>
          <button
            type="button"
            onClick={setupMedia}
            className="flex items-center gap-2 rounded-xl bg-red-600 hover:bg-red-700 px-4 py-2 text-xs font-semibold text-white shadow-lg transition active:scale-95 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            <RotateCcw className="h-4 w-4" />
            <span>Thử lại</span>
          </button>
        </div>
      )}
    </div>
  );
}
