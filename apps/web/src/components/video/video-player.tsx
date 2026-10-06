'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import {
  AlertCircle,
  RotateCcw,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
} from 'lucide-react';
import type { Rendition, SubtitleTrack } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { QualityMenu, type QualityLevel } from './quality-menu';
import { CcMenu } from './cc-menu';
import { SeekBar, formatTime } from './seek-bar';
import { useViewCounter } from './use-view-counter';
import { PlaybackTracker } from '../../lib/video/playback-tracker';
import { type WatchSurface, stripWatchSurfaceFromAddressBar } from '../../lib/video/watch-url';

export interface VideoPlayerProps {
  videoId?: string;
  durationMs?: number | null;
  src?: string;
  poster?: string;
  title?: string;
  renditions?: Rendition[];
  subtitles?: SubtitleTrack[];
  storyboardUrl?: string | null;
  expiresAt?: string | null;
  surface?: WatchSurface;
  onRecordView?: (playbackId: string, watchedMs: number) => Promise<void> | void;
}

export function VideoPlayer({
  videoId,
  durationMs,
  src,
  poster,
  title,
  renditions,
  subtitles,
  storyboardUrl,
  expiresAt,
  surface,
  onRecordView,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  // Playback overrides populated after a signed-URL auto-refresh
  const [refreshedPlayback, setRefreshedPlayback] = useState<{
    hls_url?: string;
    subtitles?: SubtitleTrack[];
    storyboard_url?: string | null;
    expires_at?: string | null;
  } | null>(null);

  // Reset refreshed playback if videoId or src changes
  useEffect(() => {
    setRefreshedPlayback(null);
  }, [videoId, src]);

  const activeSrc = refreshedPlayback?.hls_url ?? src;
  const activeSubtitles = useMemo(
    () => refreshedPlayback?.subtitles ?? subtitles ?? [],
    [refreshedPlayback?.subtitles, subtitles],
  );
  const activeStoryboardUrl = refreshedPlayback?.storyboard_url ?? storyboardUrl ?? null;
  const activeExpiresAt = refreshedPlayback?.expires_at ?? expiresAt ?? null;

  const [hasError, setHasError] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isUsingHls, setIsUsingHls] = useState<boolean>(false);
  const [qualityLevels, setQualityLevels] = useState<QualityLevel[]>([
    { index: -1, label: 'Tự động' },
  ]);
  const [currentLevel, setCurrentLevel] = useState<number>(-1);
  const [currentHeight, setCurrentHeight] = useState<number | undefined>(undefined);

  // Playback & UI state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(durationMs ? durationMs / 1000 : 0);
  const [bufferedTime, setBufferedTime] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [showControls, setShowControls] = useState<boolean>(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Subtitle state
  const [selectedSubtitleLang, setSelectedSubtitleLang] = useState<string | null>(null);

  // Signed URL auto-refresh tracking
  const hasRefreshedOnAuthErrorRef = useRef<boolean>(false);
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

  // QoE metrics tracking
  const loadStartTimeRef = useRef<number>(performance.now());
  const hasFirstFrameRef = useRef<boolean>(false);
  const rebufferCountRef = useRef<number>(0);
  const rebufferStartTimeRef = useRef<number | null>(null);
  const totalRebufferDurationRef = useRef<number>(0);
  const recoverAttemptsRef = useRef<number>(0);
  const lastSavedTimeRef = useRef<number>(0);

  // View counter hook
  const { onPlay, onTimeUpdate, onSeeking, onSeeked, onEnded, playbackIdRef } = useViewCounter({
    videoId: videoId || '',
    durationMs,
    onRecordView,
  });

  // Playback tracker for QoE / analytics (R1)
  const trackerRef = useRef<PlaybackTracker | null>(null);

  useEffect(() => {
    if (!videoId) {
      if (trackerRef.current) {
        trackerRef.current.destroy();
        trackerRef.current = null;
      }
      return;
    }

    if (trackerRef.current) {
      trackerRef.current.destroy();
    }

    // Resolve surface for THIS playback:
    // 1. Read src from address bar once on load (or use explicit prop)
    // 2. If it is one of the contract values use it, else 'other'
    // 3. Remove src from address bar with history.replaceState (keep other params)
    const strippedSurface = stripWatchSurfaceFromAddressBar();
    const playbackSurface = surface ?? strippedSurface;

    const tracker = new PlaybackTracker({
      videoId,
      playbackId: playbackIdRef.current,
      surface: playbackSurface,
    });
    trackerRef.current = tracker;

    return () => {
      tracker.destroy();
      trackerRef.current = null;
    };
  }, [videoId, playbackIdRef, surface]);

  // LocalStorage progress helper
  const getStorageKey = useCallback(() => {
    return videoId ? `winkey_playback_pos_${videoId}` : null;
  }, [videoId]);

  const savePlaybackPosition = useCallback(
    (time: number, force = false) => {
      const key = getStorageKey();
      if (!key || time <= 0) return;
      if (!force && Math.abs(time - lastSavedTimeRef.current) < 5) {
        return;
      }
      lastSavedTimeRef.current = time;
      try {
        localStorage.setItem(key, time.toString());
      } catch {
        // Ignore storage exceptions
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

  // Subtitle track selection and mode switching
  const applySubtitleMode = useCallback((lang: string | null) => {
    const video = videoRef.current;
    if (!video || !video.textTracks) return;

    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      if (lang && (track.language === lang || track.label === lang)) {
        track.mode = 'showing';
      } else {
        track.mode = 'disabled';
      }
    }
  }, []);

  const handleSelectSubtitle = useCallback(
    (lang: string | null) => {
      setSelectedSubtitleLang(lang);
      applySubtitleMode(lang);

      try {
        if (lang) {
          localStorage.setItem('winkey.subtitle_lang', lang);
        } else {
          localStorage.setItem('winkey.subtitle_lang', 'off');
        }
      } catch {
        // Ignore storage errors
      }
    },
    [applySubtitleMode],
  );

  // Initialize subtitle language from localStorage preference when subtitles change
  const subtitleLangsKey = activeSubtitles.map((s) => s.lang).join(',');
  useEffect(() => {
    if (!activeSubtitles || activeSubtitles.length === 0) {
      setSelectedSubtitleLang(null);
      return;
    }

    try {
      const savedPref = localStorage.getItem('winkey.subtitle_lang');
      if (savedPref && savedPref !== 'off') {
        const hasTrack = activeSubtitles.some((t) => t.lang === savedPref);
        if (hasTrack) {
          setSelectedSubtitleLang(savedPref);
          applySubtitleMode(savedPref);
          return;
        }
      }
    } catch {
      // Ignore localStorage exceptions
    }

    setSelectedSubtitleLang(null);
    applySubtitleMode(null);
  }, [subtitleLangsKey, activeSubtitles, applySubtitleMode]);

  // Signed URL auto-refresh logic
  const refreshSignedUrls = useCallback(async () => {
    if (!videoId) return;

    try {
      const { data: updatedVideo, response } = await api.video.GET('/v1/videos/{video_id}', {
        params: { path: { video_id: videoId } },
      });

      if (!response.ok || !updatedVideo || !updatedVideo.playback) return;

      const newPlayback = updatedVideo.playback;
      const video = videoRef.current;
      if (!video) return;

      const savedTime = video.currentTime;
      const wasPlaying = !video.paused;

      setRefreshedPlayback({
        hls_url: newPlayback.hls_url,
        subtitles: newPlayback.subtitles,
        storyboard_url: newPlayback.storyboard_url,
        expires_at: newPlayback.expires_at,
      });

      if (hlsRef.current) {
        hlsRef.current.loadSource(newPlayback.hls_url);
        video.currentTime = savedTime;
        if (wasPlaying) {
          void video.play().catch(() => {});
        }
      } else {
        video.src = newPlayback.hls_url;
        video.currentTime = savedTime;
        if (wasPlaying) {
          void video.play().catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[VideoPlayer] Failed to refresh signed URLs:', err);
    }
  }, [videoId]);

  // Schedule timer to refresh ~5 minutes before expires_at
  useEffect(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    if (!activeExpiresAt) return;

    const expiresTime = new Date(activeExpiresAt).getTime();
    if (isNaN(expiresTime)) return;

    // Refresh 5 minutes before expires_at (300_000 ms)
    const refreshTime = expiresTime - 5 * 60 * 1000;
    const delay = Math.max(0, refreshTime - Date.now());

    refreshTimerRef.current = setTimeout(() => {
      void refreshSignedUrls();
    }, delay);

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [activeExpiresAt, refreshSignedUrls]);

  // Setup HLS / Video playback
  const setupMedia = useCallback(() => {
    const video = videoRef.current;
    if (!video || !activeSrc) return;

    setHasError(false);
    setErrorMessage('');
    loadStartTimeRef.current = performance.now();
    hasFirstFrameRef.current = false;
    rebufferCountRef.current = 0;
    rebufferStartTimeRef.current = null;
    totalRebufferDurationRef.current = 0;
    recoverAttemptsRef.current = 0;
    hasRefreshedOnAuthErrorRef.current = false;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      setIsUsingHls(true);
      const hls = new Hls({
        enableWorker: true,
      });
      hlsRef.current = hls;

      hls.loadSource(activeSrc);
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
        if (data.levels && data.levels.length > 0) {
          const first = data.levels[0];
          const renditionName = first.height ? `${first.height}p` : first.name || null;
          const bitrateKbps = first.bitrate ? Math.round(first.bitrate / 1000) : null;
          trackerRef.current?.setRendition(renditionName, bitrateKbps);
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const lvl = hls.levels[data.level];
        if (lvl) {
          setCurrentHeight(lvl.height);
          const renditionName = lvl.height ? `${lvl.height}p` : lvl.name || null;
          const bitrateKbps = lvl.bitrate ? Math.round(lvl.bitrate / 1000) : null;
          trackerRef.current?.setRendition(renditionName, bitrateKbps);
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        // Check for 403/410 signed URL expiration
        const statusCode = (data as unknown as { response?: { code?: number } }).response?.code;
        if (
          activeExpiresAt &&
          !hasRefreshedOnAuthErrorRef.current &&
          (statusCode === 403 || statusCode === 410)
        ) {
          hasRefreshedOnAuthErrorRef.current = true;
          void refreshSignedUrls();
          return;
        }

        if (data.fatal) {
          if (recoverAttemptsRef.current >= 3 || data.type === Hls.ErrorTypes.OTHER_ERROR) {
            const errCode =
              (data as unknown as { details?: string }).details || data.type || 'fatalError';
            trackerRef.current?.recordError(errCode, videoRef.current?.currentTime);
            hls.destroy();
            hlsRef.current = null;
            setHasError(true);
            setErrorMessage('Không thể phát video. Vui lòng thử lại.');
            return;
          }
          recoverAttemptsRef.current += 1;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            console.warn(
              `[HLS] Fatal network error (attempt ${recoverAttemptsRef.current}/3), attempting recovery...`,
            );
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.warn(
              `[HLS] Fatal media error (attempt ${recoverAttemptsRef.current}/3), attempting recovery...`,
            );
            hls.recoverMediaError();
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS for Safari/iOS
      setIsUsingHls(false);
      video.src = activeSrc;

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
        const first = renditions[0];
        trackerRef.current?.setRendition(`${first.height}p`, first.bitrate_kbps);
      }
    } else {
      setIsUsingHls(false);
      setHasError(true);
      setErrorMessage('Trình duyệt của bạn không hỗ trợ phát HLS stream.');
    }
  }, [activeSrc, renditions, activeExpiresAt, refreshSignedUrls]);

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
  const handleSelectLevel = useCallback(
    (levelIndex: number) => {
      setCurrentLevel(levelIndex);
      if (hlsRef.current) {
        hlsRef.current.currentLevel = levelIndex;
        if (levelIndex >= 0 && hlsRef.current.levels[levelIndex]) {
          const lvl = hlsRef.current.levels[levelIndex];
          const renditionName = lvl.height ? `${lvl.height}p` : lvl.name || null;
          const bitrateKbps = lvl.bitrate ? Math.round(lvl.bitrate / 1000) : null;
          trackerRef.current?.setRendition(renditionName, bitrateKbps);
        }
      } else if (renditions && renditions[levelIndex]) {
        const r = renditions[levelIndex];
        trackerRef.current?.setRendition(`${r.height}p`, r.bitrate_kbps);
      }
    },
    [renditions],
  );

  // Controls auto-hide
  const scheduleControlsHide = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 2500);
  }, [isPlaying]);

  const handleMouseMove = () => {
    setShowControls(true);
    scheduleControlsHide();
  };

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          ((e.code === 'Space' || e.code === 'Enter') &&
            (activeEl.tagName === 'BUTTON' || activeEl.tagName === 'A')) ||
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
            trackerRef.current?.recordPlayRequest();
            void video.play();
          } else {
            video.pause();
          }
          break;
        case 'KeyJ':
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case 'KeyL':
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
          break;
        case 'KeyM':
          video.muted = !video.muted;
          setIsMuted(video.muted);
          break;
        case 'KeyF':
          if (document.fullscreenElement) {
            void document.exitFullscreen();
          } else if (containerRef.current?.requestFullscreen) {
            void containerRef.current.requestFullscreen();
          }
          break;
        case 'KeyC':
          // Toggle Closed Captions
          if (selectedSubtitleLang) {
            handleSelectSubtitle(null);
          } else if (activeSubtitles.length > 0) {
            let chosen = activeSubtitles[0].lang;
            try {
              const pref = localStorage.getItem('winkey.subtitle_lang');
              if (pref && pref !== 'off' && activeSubtitles.some((t) => t.lang === pref)) {
                chosen = pref;
              }
            } catch {
              // ignore
            }
            handleSelectSubtitle(chosen);
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
  }, [selectedSubtitleLang, activeSubtitles, handleSelectSubtitle]);

  // Video event handlers
  const handlePlayEvent = () => {
    const video = videoRef.current;
    if (!video) return;
    setIsPlaying(true);
    trackerRef.current?.recordPlayRequest();
    onPlay(video.currentTime);
  };

  const handleLoadedDataEvent = () => {
    trackerRef.current?.recordLoadedData();
  };

  const handlePlayingEvent = () => {
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
    }

    trackerRef.current?.recordPlaying(video.currentTime);
  };

  const handleTimeUpdateEvent = () => {
    const video = videoRef.current;
    if (!video) return;

    setCurrentTime(video.currentTime);
    if (video.duration && !isNaN(video.duration) && video.duration > 0) {
      setDuration(video.duration);
    }
    if (video.buffered && video.buffered.length > 0) {
      setBufferedTime(video.buffered.end(video.buffered.length - 1));
    }

    savePlaybackPosition(video.currentTime, false);
    onTimeUpdate(video.currentTime);
    trackerRef.current?.recordTimeUpdate(video.currentTime);
  };

  const handlePauseEvent = () => {
    const video = videoRef.current;
    if (!video) return;
    setIsPlaying(false);
    setShowControls(true);
    savePlaybackPosition(video.currentTime, true);
    if (rebufferStartTimeRef.current !== null) {
      const rebuffDuration = performance.now() - rebufferStartTimeRef.current;
      totalRebufferDurationRef.current += rebuffDuration;
      rebufferStartTimeRef.current = null;
    }
    trackerRef.current?.recordPause();
  };

  const handleSeekingEvent = () => {
    if (rebufferStartTimeRef.current !== null) {
      const rebuffDuration = performance.now() - rebufferStartTimeRef.current;
      totalRebufferDurationRef.current += rebuffDuration;
      rebufferStartTimeRef.current = null;
    }
    onSeeking();
    trackerRef.current?.recordSeeking();
  };

  const handleSeekedEvent = () => {
    const video = videoRef.current;
    if (!video) return;
    onSeeked(video.currentTime);
    trackerRef.current?.recordSeeked(video.currentTime);
  };

  const handleWaitingEvent = () => {
    const video = videoRef.current;
    if (
      video?.paused ||
      (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    ) {
      return;
    }
    if (hasFirstFrameRef.current && rebufferStartTimeRef.current === null) {
      rebufferCountRef.current += 1;
      rebufferStartTimeRef.current = performance.now();
    }
    trackerRef.current?.recordWaiting();
  };

  const handleEndedEvent = () => {
    setIsPlaying(false);
    setShowControls(true);
    clearPlaybackPosition();
    onEnded();
    const video = videoRef.current;
    trackerRef.current?.recordEnded(video?.currentTime);
  };

  const handleVideoError = () => {
    if (activeExpiresAt && !hasRefreshedOnAuthErrorRef.current) {
      hasRefreshedOnAuthErrorRef.current = true;
      void refreshSignedUrls();
      return;
    }
    const video = videoRef.current;
    const mediaError = video?.error;
    const errCode = mediaError ? `media_error_${mediaError.code}` : 'video_error';
    trackerRef.current?.recordError(errCode, video?.currentTime);
    setHasError(true);
    setErrorMessage('Lỗi tải video. Vui lòng kiểm tra kết nối mạng và thử lại.');
  };

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      trackerRef.current?.recordPlayRequest();
      void video.play();
    } else {
      video.pause();
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      setIsFullscreen(false);
    } else if (containerRef.current?.requestFullscreen) {
      void containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      className="group relative aspect-video w-full overflow-hidden rounded-2xl bg-black shadow-2xl flex items-center justify-center select-none"
    >
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        crossOrigin="anonymous"
        aria-label={title || 'Video Player'}
        onLoadedMetadata={() => {
          resumePlaybackPosition();
          applySubtitleMode(selectedSubtitleLang);
        }}
        onLoadedData={handleLoadedDataEvent}
        onPlay={handlePlayEvent}
        onPlaying={handlePlayingEvent}
        onPause={handlePauseEvent}
        onTimeUpdate={handleTimeUpdateEvent}
        onSeeking={handleSeekingEvent}
        onSeeked={handleSeekedEvent}
        onWaiting={handleWaitingEvent}
        onEnded={handleEndedEvent}
        onError={handleVideoError}
        onClick={togglePlayPause}
        className="h-full w-full object-contain cursor-pointer"
      >
        {/* Native WebVTT Text Tracks - Rendered only by browser engine, NEVER innerHTML (ADR-018) */}
        {activeSubtitles.map((track) => (
          <track
            key={track.lang}
            kind="subtitles"
            srcLang={track.lang}
            label={track.label}
            src={track.url}
            default={selectedSubtitleLang === track.lang}
          />
        ))}
      </video>

      {/* Custom Control Bar Overlay */}
      {!hasError && (
        <div
          data-testid="player-controls"
          className={`absolute inset-x-0 bottom-0 z-30 flex flex-col justify-end bg-gradient-to-t from-black/85 via-black/40 to-transparent px-4 pb-3 pt-8 transition-opacity duration-300 ${
            showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* Seek Bar with Storyboard Scrub Previews */}
          <div className="mb-2">
            <SeekBar
              currentTime={currentTime}
              duration={duration}
              buffered={bufferedTime}
              storyboardUrl={activeStoryboardUrl}
              onSeek={(time) => {
                if (videoRef.current) {
                  videoRef.current.currentTime = time;
                }
              }}
            />
          </div>

          {/* Action Buttons Row */}
          <div className="flex items-center justify-between gap-3 text-white">
            {/* Left Controls: Play/Pause, Volume, Time */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={togglePlayPause}
                aria-label={isPlaying ? 'Tạm dừng (k)' : 'Phát (k)'}
                data-testid="play-pause-button"
                className="rounded-lg p-1.5 hover:bg-white/10 transition focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </button>

              <button
                type="button"
                onClick={toggleMute}
                aria-label={isMuted ? 'Bật âm thanh (m)' : 'Tắt tiếng (m)'}
                data-testid="volume-mute-button"
                className="rounded-lg p-1.5 hover:bg-white/10 transition focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
              </button>

              <div
                data-testid="time-display"
                className="text-xs font-mono font-medium text-gray-200"
              >
                <span>{formatTime(currentTime)}</span>
                <span className="mx-1 text-gray-500">/</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Right Controls: CC Menu, Quality Menu, Fullscreen */}
            <div className="flex items-center gap-2">
              {/* CC Menu */}
              {activeSubtitles.length > 0 && (
                <CcMenu
                  tracks={activeSubtitles}
                  selectedLang={selectedSubtitleLang}
                  onSelectTrack={handleSelectSubtitle}
                />
              )}

              {/* Quality Menu */}
              {isUsingHls && qualityLevels.length > 1 && (
                <QualityMenu
                  levels={qualityLevels}
                  currentLevel={currentLevel}
                  currentHeight={currentHeight}
                  onSelectLevel={handleSelectLevel}
                />
              )}

              {/* Fullscreen Button */}
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? 'Thoát toàn màn hình (f)' : 'Toàn màn hình (f)'}
                data-testid="fullscreen-button"
                className="rounded-lg p-1.5 hover:bg-white/10 transition focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
              </button>
            </div>
          </div>
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
