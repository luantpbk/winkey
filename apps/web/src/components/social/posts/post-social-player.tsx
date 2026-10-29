'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { Volume2, VolumeX, Play, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../../../lib/api-client';
import type { VideoSummary } from '@winkey/api-client';
import type { HydratedPostVideo } from '../../../lib/video/hydrate-posts-videos';

export interface PostSocialVideoPlayerProps {
  videoId: string;
  initialVideo?: HydratedPostVideo | null;
  className?: string;
}

export function PostSocialVideoPlayer({
  videoId,
  initialVideo,
  className = '',
}: PostSocialVideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [hlsUrl, setHlsUrl] = useState<string | null>(initialVideo?.playback?.hls_url || null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string>(
    initialVideo?.thumbnail_url || initialVideo?.playback?.thumbnail_url || '',
  );
  const [width, setWidth] = useState<number>(initialVideo?.width || 720);
  const [height, setHeight] = useState<number>(initialVideo?.height || 1280);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userPaused, setUserPaused] = useState(false);

  // Fetch full video details if hls_url is missing
  useEffect(() => {
    let active = true;

    if (!hlsUrl) {
      setIsLoading(true);
      api.video
        .GET('/v1/videos/{video_id}', {
          params: { path: { video_id: videoId } },
        })
        .then(({ data, response }) => {
          if (!active) return;
          if (response.ok && data) {
            if (data.playback?.hls_url) {
              setHlsUrl(data.playback.hls_url);
            }
            if (data.playback?.thumbnail_url) {
              setThumbnailUrl(data.playback.thumbnail_url);
            }
            if (data.width && data.height) {
              setWidth(data.width);
              setHeight(data.height);
            }
          } else {
            setLoadError('Không thể tải video bài đăng.');
          }
        })
        .catch(() => {
          if (active) setLoadError('Lỗi kết nối khi nạp video.');
        })
        .finally(() => {
          if (active) setIsLoading(false);
        });
    }

    return () => {
      active = false;
    };
  }, [videoId, hlsUrl]);

  // Setup HLS instance
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !hlsUrl) return;

    videoEl.muted = isMuted;

    if (Hls.isSupported()) {
      const hls = new Hls({
        autoStartLoad: true,
        maxBufferLength: 10,
      });
      hlsRef.current = hls;

      hls.loadSource(hlsUrl);
      hls.attachMedia(videoEl);

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              break;
          }
        }
      });
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = hlsUrl;
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [hlsUrl]);

  // Play / Pause handlers
  const handlePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    setUserPaused(false);
    video
      .play()
      .then(() => setIsPlaying(true))
      .catch(() => {});
  }, []);

  const handlePause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    setUserPaused(true);
    video.pause();
    setIsPlaying(false);
  }, []);

  const togglePlayPause = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isPlaying) {
        handlePause();
      } else {
        handlePlay();
      }
    },
    [isPlaying, handlePlay, handlePause],
  );

  const toggleMute = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setIsMuted(nextMuted);
  }, []);

  // IntersectionObserver for Autoplay when >= 50% visible
  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video) return;

    // Check prefers-reduced-motion
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // If reduced motion is requested, do not autoplay
    if (prefersReducedMotion) {
      return;
    }

    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            // >= 50% visible: autoplay if user has not explicitly paused
            if (!userPaused) {
              video
                .play()
                .then(() => setIsPlaying(true))
                .catch(() => {});
            }
          } else {
            // Left viewport or < 50% visible: pause
            video.pause();
            setIsPlaying(false);
          }
        }
      },
      {
        threshold: 0.5,
      },
    );

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [userPaused]);

  // Sync play / pause DOM events
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      video.currentTime = 0;
      video.play().catch(() => {}); // Loop playback for social reels
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
    };
  }, []);

  const aspectRatio = width > 0 && height > 0 ? `${width} / ${height}` : '9 / 16';

  return (
    <div
      ref={containerRef}
      data-testid="post-social-player"
      className={`relative mt-3 mx-auto overflow-hidden rounded-2xl bg-black flex items-center justify-center border border-zinc-200 dark:border-zinc-800 ${className}`}
      style={{
        maxHeight: '80vh',
        aspectRatio,
        maxWidth: '100%',
      }}
      onClick={togglePlayPause}
    >
      {loadError ? (
        <div className="flex flex-col items-center justify-center p-6 text-zinc-400 text-xs text-center space-y-2">
          <AlertCircle className="w-8 h-8 text-red-500" />
          <span>{loadError}</span>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            data-testid="social-video-element"
            muted={isMuted}
            playsInline
            poster={thumbnailUrl}
            className="w-full h-full object-contain max-h-[80vh] rounded-2xl cursor-pointer"
            aria-label="Video bài viết"
          />

          {isLoading && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none">
              <Loader2 className="w-8 h-8 text-white animate-spin" />
            </div>
          )}

          {/* Center Play Overlay when paused */}
          {!isPlaying && !isLoading && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/20">
              <div className="w-14 h-14 rounded-full bg-black/60 text-white flex items-center justify-center backdrop-blur-sm shadow-xl">
                <Play className="w-7 h-7 fill-current translate-x-0.5" />
              </div>
            </div>
          )}

          {/* Volume / Mute Toggle Button */}
          <div className="absolute bottom-3 right-3 z-10">
            <button
              type="button"
              data-testid="social-video-mute-btn"
              onClick={toggleMute}
              className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white backdrop-blur-sm transition-colors shadow-lg"
              title={isMuted ? 'Bật âm thanh' : 'Tắt âm thanh'}
              aria-label={isMuted ? 'Bật âm thanh' : 'Tắt âm thanh'}
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
