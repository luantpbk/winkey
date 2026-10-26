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
  Settings,
} from 'lucide-react';
import type { Rendition, SubtitleTrack, PlaybackAudioTrack } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { QualityMenu, type QualityLevel } from './quality-menu';
import { CcMenu } from './cc-menu';
import { AudioMenu, type AudioTrackOption } from './audio-menu';
import { PlayerSettingsSheet } from './player-settings-sheet';
import { SeekBar, formatTime } from './seek-bar';
import { useViewCounter } from './use-view-counter';
import { PlaybackTracker } from '../../lib/video/playback-tracker';
import { type WatchSurface, stripWatchSurfaceFromAddressBar } from '../../lib/video/watch-url';
import { saveContinueWatching, removeContinueWatching } from '../../lib/video/continue-watching';

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>;
  unlock?: () => void;
};

type IosVideoElement = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

export interface VideoPlayerProps {
  videoId?: string;
  durationMs?: number | null;
  src?: string;
  hlsAv1Url?: string | null;
  poster?: string;
  title?: string;
  renditions?: Rendition[];
  subtitles?: SubtitleTrack[];
  audioTracks?: PlaybackAudioTrack[];
  storyboardUrl?: string | null;
  expiresAt?: string | null;
  surface?: WatchSurface;
  onRecordView?: (playbackId: string, watchedMs: number) => Promise<void> | void;
  onEnded?: () => void;
  className?: string;
}

export const AV1_MEDIA_CAPABILITIES_CONFIG: MediaDecodingConfiguration = {
  type: 'media-source',
  video: {
    contentType: 'video/mp4; codecs="av01.0.08M.08"',
    width: 1920,
    height: 1080,
    bitrate: 3000000,
    framerate: 30,
  },
};

export async function isAv1Supported(): Promise<boolean> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaCapabilities ||
    typeof navigator.mediaCapabilities.decodingInfo !== 'function'
  ) {
    return false;
  }
  try {
    const info = await navigator.mediaCapabilities.decodingInfo(AV1_MEDIA_CAPABILITIES_CONFIG);
    return Boolean(info && info.supported && info.smooth && info.powerEfficient);
  } catch {
    return false;
  }
}

export function getLoadedCodec(
  url: string | undefined | null,
  av1Url: string | undefined | null,
): 'av1' | 'h264' {
  if (!url) return 'h264';
  if (av1Url && url === av1Url) return 'av1';
  return 'h264';
}

function findPreferredAudioTrackIndex(tracks: AudioTrackOption[]): number {
  if (tracks.length === 0) return 0;
  try {
    const savedChoice = localStorage.getItem('winkey.audio_choice');
    const savedLang = localStorage.getItem('winkey.audio_lang');

    if (savedChoice && savedChoice.includes(':')) {
      const [lang, kind] = savedChoice.split(':');
      // 1. Try exact match on lang + kind
      const exactIdx = tracks.findIndex((t) => t.lang === lang && t.kind === kind);
      if (exactIdx !== -1) return exactIdx;
      // 2. Fall back to lang alone
      const langIdx = tracks.findIndex((t) => t.lang === lang);
      if (langIdx !== -1) return langIdx;
    } else if (savedChoice || savedLang) {
      const lang = savedChoice || savedLang;
      const langIdx = tracks.findIndex((t) => t.lang === lang);
      if (langIdx !== -1) return langIdx;
    }

    const defIdx = tracks.findIndex((t) => t.isDefault);
    if (defIdx !== -1) return defIdx;
  } catch {
    // ignore
  }
  return 0;
}

export function VideoPlayer({
  videoId,
  durationMs,
  src,
  hlsAv1Url,
  poster,
  title,
  renditions,
  subtitles,
  audioTracks,
  storyboardUrl,
  expiresAt,
  surface,
  onRecordView,
  onEnded: onEndedProp,
  className,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const rawAv1Url = hlsAv1Url ?? null;
  const av1CapableRef = useRef<boolean | undefined>(undefined);

  // Codec selection: defaults to 'h264' while query is pending or when API is missing
  const [activeCodec, setActiveCodec] = useState<'av1' | 'h264'>('h264');

  // Check AV1 decoding capabilities asynchronously (for activeCodec selection and telemetry)
  useEffect(() => {
    let cancelled = false;

    void isAv1Supported().then((supported) => {
      if (cancelled) return;
      av1CapableRef.current = supported;
      trackerRef.current?.setAv1Capable(supported);

      if (rawAv1Url && supported) {
        if (!hasFirstFrameRef.current) {
          setActiveCodec('av1');
        }
      } else {
        setActiveCodec('h264');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [videoId, src, rawAv1Url]);

  // Playback overrides populated after a signed-URL auto-refresh
  const [refreshedPlayback, setRefreshedPlayback] = useState<{
    hls_url?: string;
    hls_av1_url?: string | null;
    subtitles?: SubtitleTrack[];
    audio_tracks?: PlaybackAudioTrack[];
    storyboard_url?: string | null;
    expires_at?: string | null;
  } | null>(null);

  // Reset refreshed playback if videoId or src changes
  useEffect(() => {
    setRefreshedPlayback(null);
  }, [videoId, src, rawAv1Url]);

  const activeSrc =
    activeCodec === 'av1'
      ? refreshedPlayback
        ? (refreshedPlayback.hls_av1_url ?? refreshedPlayback.hls_url ?? src ?? '')
        : (rawAv1Url ?? src ?? '')
      : (refreshedPlayback?.hls_url ?? src ?? '');

  const activeRenditions = useMemo(() => {
    if (!renditions || renditions.length === 0) return [];
    return renditions.filter((r) => {
      const renditionCodec = r.codec || 'h264';
      return renditionCodec === activeCodec;
    });
  }, [renditions, activeCodec]);
  const activeSubtitles = useMemo(
    () => refreshedPlayback?.subtitles ?? subtitles ?? [],
    [refreshedPlayback?.subtitles, subtitles],
  );
  const activeAudioTracks = useMemo(
    () => refreshedPlayback?.audio_tracks ?? audioTracks ?? [],
    [refreshedPlayback?.audio_tracks, audioTracks],
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

  const isPlayingRef = useRef<boolean>(false);
  const isAnyMenuOpenRef = useRef<boolean>(false);
  const touchHandledRef = useRef<boolean>(false);
  const controlsVisibleAtTouchRef = useRef<boolean>(true);

  // Subtitle state
  const [selectedSubtitleLang, setSelectedSubtitleLang] = useState<string | null>(null);

  // Settings sheet state (Mobile < 640px)
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isQualityMenuOpen, setIsQualityMenuOpen] = useState<boolean>(false);
  const [isCcMenuOpen, setIsCcMenuOpen] = useState<boolean>(false);
  const [isAudioMenuOpen, setIsAudioMenuOpen] = useState<boolean>(false);

  const isAnyMenuOpen = isSettingsOpen || isQualityMenuOpen || isCcMenuOpen || isAudioMenuOpen;

  // Audio track state: prefill from activeAudioTracks before manifest loads
  const initialAudioOptions = useMemo<AudioTrackOption[]>(() => {
    if (!activeAudioTracks || activeAudioTracks.length === 0) return [];
    return activeAudioTracks.map((tr, idx) => ({
      index: idx,
      id: tr.id,
      lang: tr.lang,
      label: tr.label || (idx === 0 ? 'Âm thanh gốc' : `Track ${idx + 1}`),
      kind: tr.kind,
      isDefault: tr.is_default,
    }));
  }, [activeAudioTracks]);

  const [audioTracksList, setAudioTracksList] = useState<AudioTrackOption[]>(initialAudioOptions);
  const [currentAudioIndex, setCurrentAudioIndex] = useState<number>(0);

  // Sync initial audio options from props and restore preferred audio choice (lang+kind, fallback lang)
  useEffect(() => {
    setAudioTracksList(initialAudioOptions);
    if (initialAudioOptions.length > 0) {
      const preferredIdx = findPreferredAudioTrackIndex(initialAudioOptions);
      setCurrentAudioIndex(preferredIdx);
    } else {
      setCurrentAudioIndex(0);
    }
  }, [initialAudioOptions]);

  const handleSelectAudioTrack = useCallback((track: AudioTrackOption) => {
    setCurrentAudioIndex(track.index);
    if (hlsRef.current) {
      hlsRef.current.audioTrack = track.index;
    }
    try {
      const choice = track.kind ? `${track.lang}:${track.kind}` : track.lang;
      localStorage.setItem('winkey.audio_choice', choice);
      localStorage.setItem('winkey.audio_lang', track.lang);
    } catch {
      // ignore storage errors
    }
  }, []);

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

    const effectiveAv1 = refreshedPlayback ? refreshedPlayback.hls_av1_url : rawAv1Url;
    const initialCodec = getLoadedCodec(activeSrc, effectiveAv1);

    const tracker = new PlaybackTracker({
      videoId,
      playbackId: playbackIdRef.current,
      surface: playbackSurface,
      codec: initialCodec,
      av1Capable: av1CapableRef.current,
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

  const clearPlaybackPosition = useCallback(() => {
    if (videoId) {
      removeContinueWatching(videoId);
    }
    const key = getStorageKey();
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage exceptions
    }
  }, [getStorageKey, videoId]);

  const savePlaybackPosition = useCallback(
    (time: number, force = false) => {
      const key = getStorageKey();
      if (!key || time <= 0) return;

      const video = videoRef.current;
      const duration = video?.duration || (durationMs ? durationMs / 1000 : 0);
      if (duration > 0 && time / duration >= 0.95) {
        clearPlaybackPosition();
        return;
      }

      if (!force && Math.abs(time - lastSavedTimeRef.current) < 5) {
        return;
      }
      lastSavedTimeRef.current = time;
      try {
        localStorage.setItem(key, time.toString());
      } catch {
        // Ignore storage exceptions
      }

      if (duration > 0 && videoId) {
        saveContinueWatching(videoId, time, duration);
      }
    },
    [getStorageKey, durationMs, videoId, clearPlaybackPosition],
  );

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
      // DEF1: the viewer's stored choice wins ("off" included); a stored language this video does not have,
      // or no stored choice, falls back to the creator's default track, else no subtitles.
      const savedPref = localStorage.getItem('winkey.subtitle_lang');
      if (savedPref === 'off') {
        setSelectedSubtitleLang(null);
        applySubtitleMode(null);
        return;
      }
      const lang =
        activeSubtitles.find((t) => t.lang === savedPref)?.lang ??
        activeSubtitles.find((t) => t.is_default)?.lang;
      if (lang) {
        setSelectedSubtitleLang(lang);
        applySubtitleMode(lang);
        return;
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
        hls_av1_url: newPlayback.hls_av1_url,
        subtitles: newPlayback.subtitles,
        audio_tracks: newPlayback.audio_tracks,
        storyboard_url: newPlayback.storyboard_url,
        expires_at: newPlayback.expires_at,
      });

      const nextUrl =
        activeCodec === 'av1' && newPlayback.hls_av1_url
          ? newPlayback.hls_av1_url
          : newPlayback.hls_url;

      const nextCodec = getLoadedCodec(nextUrl, newPlayback.hls_av1_url);
      trackerRef.current?.setCodec(nextCodec);

      if (hlsRef.current) {
        hlsRef.current.loadSource(nextUrl);
        video.currentTime = savedTime;
        if (wasPlaying) {
          void video.play().catch(() => {});
        }
      } else {
        video.src = nextUrl;
        video.currentTime = savedTime;
        if (wasPlaying) {
          void video.play().catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[VideoPlayer] Failed to refresh signed URLs:', err);
    }
  }, [videoId, activeCodec]);

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

    const effectiveAv1 = refreshedPlayback ? refreshedPlayback.hls_av1_url : rawAv1Url;
    const loadedCodec = getLoadedCodec(activeSrc, effectiveAv1);
    trackerRef.current?.setCodec(loadedCodec);

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
        capLevelToPlayerSize: true,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
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
        syncAudioTracks();
      });

      const syncAudioTracks = () => {
        if (!hls.audioTracks || hls.audioTracks.length === 0) {
          if (activeAudioTracks.length === 0) {
            setAudioTracksList([]);
          }
          return;
        }

        const hlsTracks: AudioTrackOption[] = hls.audioTracks.map((ht, idx) => {
          const propTrack = activeAudioTracks[idx];
          return {
            index: idx,
            id: propTrack?.id || (ht.id !== undefined ? String(ht.id) : undefined),
            lang: propTrack?.lang || ht.lang || 'und',
            label: propTrack?.label || ht.name || (idx === 0 ? 'Âm thanh gốc' : `Track ${idx + 1}`),
            kind: propTrack?.kind || (idx === 0 ? 'original' : undefined),
            isDefault: propTrack?.is_default ?? (ht as any).default ?? false,
          };
        });

        setAudioTracksList(hlsTracks);

        const selectedIdx = findPreferredAudioTrackIndex(hlsTracks);
        setCurrentAudioIndex(selectedIdx);
        if (hls.audioTrack !== selectedIdx) {
          hls.audioTrack = selectedIdx;
        }
      };

      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        syncAudioTracks();
      });

      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
        setCurrentAudioIndex(data.id);
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

      if (activeRenditions && activeRenditions.length > 0) {
        const levels: QualityLevel[] = [{ index: -1, label: 'Tự động' }];
        activeRenditions.forEach((r, idx) => {
          levels.push({
            index: idx,
            label: r.name,
            height: r.height,
            bitrate: r.bitrate_kbps * 1000,
          });
        });
        setQualityLevels(levels);
        const first = activeRenditions[0];
        trackerRef.current?.setRendition(`${first.height}p`, first.bitrate_kbps);
      }
    } else {
      setIsUsingHls(false);
      setHasError(true);
      setErrorMessage('Trình duyệt của bạn không hỗ trợ phát HLS stream.');
    }
  }, [
    activeSrc,
    activeRenditions,
    activeExpiresAt,
    refreshSignedUrls,
    refreshedPlayback,
    rawAv1Url,
  ]);

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
      } else if (activeRenditions && activeRenditions[levelIndex]) {
        const r = activeRenditions[levelIndex];
        trackerRef.current?.setRendition(`${r.height}p`, r.bitrate_kbps);
      }
    },
    [activeRenditions],
  );

  // Controls auto-hide (3 seconds, ref-guarded, paused or menu open keeps controls visible)
  const scheduleControlsHide = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
    if (!isPlayingRef.current || isAnyMenuOpenRef.current) {
      return;
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlayingRef.current && !isAnyMenuOpenRef.current) {
        setShowControls(false);
      }
    }, 3000);
  }, []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
    if (!isPlaying) {
      setShowControls(true);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
    }
  }, [isPlaying]);

  useEffect(() => {
    isAnyMenuOpenRef.current = isAnyMenuOpen;
    if (isAnyMenuOpen) {
      setShowControls(true);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
    } else if (isPlayingRef.current) {
      scheduleControlsHide();
    }
  }, [isAnyMenuOpen, scheduleControlsHide]);

  const handleMouseMove = () => {
    setShowControls(true);
    scheduleControlsHide();
  };

  const handleTouchStart = () => {
    // Remember visibility before this touch reveals the controls, so a tap on the
    // video can toggle them (touchstart bubbles to the container before touchend).
    controlsVisibleAtTouchRef.current = showControls;
    setShowControls(true);
    scheduleControlsHide();
  };

  const handleVideoTouchEnd = () => {
    touchHandledRef.current = true;
    if (controlsVisibleAtTouchRef.current && isPlayingRef.current && !isAnyMenuOpenRef.current) {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
      setShowControls(false);
    } else {
      setShowControls(true);
      scheduleControlsHide();
    }
  };

  const handleVideoClick = () => {
    if (touchHandledRef.current) {
      touchHandledRef.current = false;
      return;
    }
    togglePlayPause();
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

      setShowControls(true);
      scheduleControlsHide();

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
    isPlayingRef.current = true;
    setShowControls(true);
    scheduleControlsHide();
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
    isPlayingRef.current = false;
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
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
    isPlayingRef.current = false;
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
    clearPlaybackPosition();
    onEnded();
    const video = videoRef.current;
    trackerRef.current?.recordEnded(video?.currentTime);
    onEndedProp?.();
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
      setShowControls(true);
      scheduleControlsHide();
    } else {
      video.pause();
      setShowControls(true);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  // Keep isFullscreen in sync with the browser (Esc, Android back gesture, KeyF)
  useEffect(() => {
    const handleFullscreenChange = () => {
      const active =
        containerRef.current !== null && document.fullscreenElement === containerRef.current;
      setIsFullscreen(active);
      if (active) {
        setShowControls(true);
        scheduleControlsHide();
      } else {
        try {
          (screen.orientation as LockableOrientation | undefined)?.unlock?.();
        } catch {
          // unlock is unsupported outside fullscreen-capable mobile browsers
        }
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [scheduleControlsHide]);

  const toggleFullscreen = () => {
    const container = containerRef.current;
    const video = videoRef.current as IosVideoElement | null;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (container?.requestFullscreen) {
      Promise.resolve(container.requestFullscreen())
        .then(() => {
          // Phones: rotate a landscape video to landscape (Android Chrome; no-op elsewhere)
          const orientation = screen.orientation as LockableOrientation | undefined;
          const landscapeVideo = !video || video.videoWidth >= video.videoHeight;
          if (
            orientation?.lock &&
            landscapeVideo &&
            window.matchMedia?.('(pointer: coarse)').matches
          ) {
            return orientation.lock('landscape').catch(() => undefined);
          }
          return undefined;
        })
        .catch(() => undefined);
    } else if (video?.webkitEnterFullscreen) {
      // iPhone Safari cannot fullscreen a <div>; only the <video> (native controls, auto-hide)
      video.webkitEnterFullscreen();
    }
  };

  return (
    <div
      ref={containerRef}
      data-spatial-nav="off"
      onMouseMove={handleMouseMove}
      onTouchStart={handleTouchStart}
      onMouseLeave={() =>
        isPlayingRef.current && !isAnyMenuOpenRef.current && setShowControls(false)
      }
      className={`group relative overflow-hidden bg-black flex items-center justify-center select-none ${
        isFullscreen && !showControls ? 'cursor-none' : ''
      } ${className ?? 'aspect-video w-full rounded-2xl shadow-2xl'}`}
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
        onClick={handleVideoClick}
        onTouchEnd={handleVideoTouchEnd}
        className={`h-full w-full object-contain ${
          isFullscreen && !showControls ? 'cursor-none' : 'cursor-pointer'
        }`}
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
          <div className="flex items-center justify-between gap-1 sm:gap-3 text-white">
            {/* Left Controls: Play/Pause, Volume, Time */}
            <div className="flex items-center gap-1 sm:gap-2">
              <button
                type="button"
                onClick={togglePlayPause}
                aria-label={isPlaying ? 'Tạm dừng (k)' : 'Phát (k)'}
                data-testid="play-pause-button"
                className="relative inline-flex items-center justify-center h-9 w-9 rounded-lg hover:bg-white/10 transition focus:outline-none focus:ring-2 focus:ring-red-500 before:absolute before:-inset-1 before:content-['']"
              >
                {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </button>

              <button
                type="button"
                onClick={toggleMute}
                aria-label={isMuted ? 'Bật âm thanh (m)' : 'Tắt tiếng (m)'}
                data-testid="volume-mute-button"
                className="relative inline-flex items-center justify-center h-9 w-9 rounded-lg hover:bg-white/10 transition focus:outline-none focus:ring-2 focus:ring-red-500 before:absolute before:-inset-1 before:content-['']"
              >
                {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
              </button>

              <div
                data-testid="time-display"
                className="text-[11px] sm:text-xs font-mono font-medium text-gray-200 select-none whitespace-nowrap shrink-0"
              >
                <span>{formatTime(currentTime)}</span>
                <span className="mx-1 text-gray-500">/</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Right Controls: CC Menu, Audio Menu, Quality Menu, Mobile Settings Button, Fullscreen */}
            <div className="flex items-center gap-1 sm:gap-2">
              {/* CC Menu (Desktop >= sm) */}
              {activeSubtitles.length > 0 && (
                <div className="hidden sm:inline-block">
                  <CcMenu
                    tracks={activeSubtitles}
                    selectedLang={selectedSubtitleLang}
                    onSelectTrack={handleSelectSubtitle}
                    onOpenChange={setIsCcMenuOpen}
                  />
                </div>
              )}

              {/* Audio Menu (only shown when there are 2 or more audio tracks) (Desktop >= sm) */}
              {audioTracksList.length >= 2 && (
                <div className="hidden sm:inline-block">
                  <AudioMenu
                    tracks={audioTracksList}
                    selectedIndex={currentAudioIndex}
                    onSelectTrack={handleSelectAudioTrack}
                    onOpenChange={setIsAudioMenuOpen}
                  />
                </div>
              )}

              {/* Quality Menu (Desktop >= sm) */}
              {isUsingHls && qualityLevels.length > 1 && (
                <div className="hidden sm:inline-block">
                  <QualityMenu
                    levels={qualityLevels}
                    currentLevel={currentLevel}
                    currentHeight={currentHeight}
                    onSelectLevel={handleSelectLevel}
                    onOpenChange={setIsQualityMenuOpen}
                  />
                </div>
              )}

              {/* Mobile Settings Button (opens sheet with Subtitles, Audio, Quality on < sm) */}
              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                aria-label="Cài đặt phát lại"
                data-testid="player-settings-button"
                className="relative inline-flex sm:hidden items-center justify-center h-9 w-9 rounded-lg hover:bg-white/10 transition focus:outline-none focus:ring-2 focus:ring-red-500 before:absolute before:-inset-1 before:content-['']"
              >
                <Settings className="h-4 w-4" />
              </button>

              {/* Fullscreen Button */}
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? 'Thoát toàn màn hình (f)' : 'Toàn màn hình (f)'}
                data-testid="fullscreen-button"
                className="relative inline-flex items-center justify-center h-9 w-9 rounded-lg hover:bg-white/10 transition focus:outline-none focus:ring-2 focus:ring-red-500 before:absolute before:-inset-1 before:content-['']"
              >
                {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Player Settings Sheet for mobile (< 640px) */}
      <PlayerSettingsSheet
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        subtitles={activeSubtitles}
        selectedSubtitleLang={selectedSubtitleLang}
        onSelectSubtitle={handleSelectSubtitle}
        audioTracks={audioTracksList}
        selectedAudioIndex={currentAudioIndex}
        onSelectAudio={handleSelectAudioTrack}
        qualityLevels={qualityLevels}
        currentLevel={currentLevel}
        currentHeight={currentHeight}
        onSelectQuality={handleSelectLevel}
      />

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
