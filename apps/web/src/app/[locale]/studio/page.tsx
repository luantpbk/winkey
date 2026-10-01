'use client';

import React, { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Link } from '../../../i18n/routing';
import { api } from '../../../lib/api-client';
import { formatDuration, formatRelativeTime } from '../../../lib/format';
import type { StudioVideo, StudioVideoPage } from '@winkey/api-client';
import {
  UploadCloud,
  Eye,
  Lock,
  Globe,
  Trash2,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  Clock,
  Subtitles,
} from 'lucide-react';

import { useRealtime } from '../../../lib/realtime/realtime-context';
import { VideoSubtitlesDialog } from '../../../components/studio/video-subtitles-dialog';
import { StudioNav } from '../../../components/studio/studio-nav';

export default function StudioPage() {
  const [selectedSubtitlesVideoId, setSelectedSubtitlesVideoId] = React.useState<string | null>(
    null,
  );
  const t = useTranslations('studio');
  const queryClient = useQueryClient();
  const { client, isConnected } = useRealtime();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['studio', 'videos'],
    queryFn: async () => {
      const { data: page, error: apiErr, response } = await api.video.GET('/v1/studio/videos');
      if (!response.ok || !page) {
        throw new Error(apiErr?.detail || 'Failed to fetch studio videos');
      }
      return page as StudioVideoPage;
    },
  });

  const videos = data?.items || [];

  const pendingIds = React.useMemo(() => {
    const items = data?.items || [];
    return items
      .filter((v) => v.status === 'UPLOADED' || v.status === 'PROCESSING')
      .map((v) => v.id)
      .sort()
      .join(',');
  }, [data?.items]);

  // Realtime subscription for pending videos (UPLOADED / PROCESSING)
  useEffect(() => {
    if (!pendingIds) return;
    const ids = pendingIds.split(',').filter(Boolean);

    const unsubs = ids.map((id) => {
      const room = `upload:${id}`;
      return client.subscribe(
        room,
        (event) => {
          if (event.event === 'video.progress') {
            queryClient.setQueryData<StudioVideoPage>(['studio', 'videos'], (old) => {
              if (!old) return old;
              return {
                ...old,
                items: old.items.map((item) =>
                  item.id === event.data.video_id
                    ? {
                        ...item,
                        status: 'PROCESSING',
                        progress: event.data.percent,
                      }
                    : item,
                ),
              };
            });
          } else if (event.event === 'video.ready') {
            queryClient.setQueryData<StudioVideoPage>(['studio', 'videos'], (old) => {
              if (!old) return old;
              return {
                ...old,
                items: old.items.map((item) =>
                  item.id === event.data.video_id
                    ? {
                        ...item,
                        status: 'READY',
                        progress: 100,
                      }
                    : item,
                ),
              };
            });
          } else if (event.event === 'video.failed') {
            queryClient.setQueryData<StudioVideoPage>(['studio', 'videos'], (old) => {
              if (!old) return old;
              return {
                ...old,
                items: old.items.map((item) =>
                  item.id === event.data.video_id
                    ? {
                        ...item,
                        status: 'FAILED',
                        error: event.data.message || event.data.reason,
                      }
                    : item,
                ),
              };
            });
          }
        },
        () => {
          // Re-fetch REST state after socket reconnects
          refetch();
        },
      );
    });

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [client, pendingIds, queryClient, refetch]);

  // Fallback slow poll (30 s) ONLY while the socket is disconnected
  useEffect(() => {
    if (isConnected || !pendingIds) return; // No polling when connected!

    const ids = pendingIds.split(',').filter(Boolean);
    if (ids.length === 0) return;

    const interval = setInterval(async () => {
      for (const id of ids) {
        try {
          const { data: statusData } = await api.upload.GET('/v1/uploads/{video_id}', {
            params: { path: { video_id: id } },
          });

          if (statusData) {
            queryClient.setQueryData<StudioVideoPage>(['studio', 'videos'], (old) => {
              if (!old) return old;
              return {
                ...old,
                items: old.items.map((item) =>
                  item.id === id
                    ? {
                        ...item,
                        status: statusData.status,
                        progress: statusData.progress,
                        error: statusData.error,
                      }
                    : item,
                ),
              };
            });
          }
        } catch (pollErr) {
          console.warn('Fallback polling upload status failed:', pollErr);
        }
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [isConnected, pendingIds, queryClient]);

  const handleDelete = async (videoId: string) => {
    if (!confirm('Bạn có chắc muốn xóa video này?')) return;
    try {
      await api.video.DELETE('/v1/videos/{video_id}', {
        params: { path: { video_id: videoId } },
      });
      refetch();
    } catch {
      alert('Không thể xóa video');
    }
  };

  const renderStatusBadge = (video: StudioVideo) => {
    if (video.moderation?.state === 'HIDDEN') {
      return (
        <div className="flex flex-col gap-1 max-w-xs">
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2.5 py-0.5 text-xs font-semibold text-red-400">
            <AlertCircle className="h-3 w-3" />
            {t('status.HIDDEN')}
          </span>
          {video.moderation.reason && (
            <span className="text-[11px] text-red-400/90 leading-tight">
              {t('hiddenByModerator', { reason: video.moderation.reason })}
            </span>
          )}
        </div>
      );
    }

    switch (video.status) {
      case 'READY':
        return (
          <span className="inline-flex items-center rounded-full bg-green-500/10 border border-green-500/30 px-2.5 py-0.5 text-xs font-semibold text-green-400">
            {t('status.READY')}
          </span>
        );
      case 'PROCESSING':
        return (
          <div className="flex flex-col gap-1 min-w-[120px]">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-500/10 border border-purple-500/30 px-2.5 py-0.5 text-xs font-semibold text-purple-400">
              <span className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-ping" />
              {t('status.PROCESSING')} ({Math.round(video.progress || 0)}%)
            </span>
            <div className="h-1.5 w-full rounded-full bg-gray-700 overflow-hidden">
              <div
                className="h-full bg-purple-500 transition-all duration-300"
                style={{ width: `${video.progress || 0}%` }}
              />
            </div>
          </div>
        );
      case 'UPLOADED':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 border border-yellow-500/30 px-2.5 py-0.5 text-xs font-semibold text-yellow-400">
            <Clock className="h-3 w-3" />
            {t('status.UPLOADED')}
          </span>
        );
      case 'UPLOADING':
        return (
          <span className="inline-flex items-center rounded-full bg-blue-500/10 border border-blue-500/30 px-2.5 py-0.5 text-xs font-semibold text-blue-400">
            {t('status.UPLOADING')}
          </span>
        );
      case 'FAILED':
        return (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2.5 py-0.5 text-xs font-semibold text-red-400 cursor-help"
            title={video.error || 'Lỗi mã hóa video'}
          >
            <AlertCircle className="h-3 w-3" />
            {t('status.FAILED')}
          </span>
        );
    }
  };

  const renderVisibilityIcon = (visibility: string) => {
    switch (visibility) {
      case 'PUBLIC':
        return (
          <span className="flex items-center gap-1 text-xs text-green-500">
            <Globe className="h-3.5 w-3.5" />
            <span>Công khai</span>
          </span>
        );
      case 'UNLISTED':
        return (
          <span className="flex items-center gap-1 text-xs text-yellow-500">
            <Eye className="h-3.5 w-3.5" />
            <span>Không công khai</span>
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1 text-xs text-gray-400">
            <Lock className="h-3.5 w-3.5" />
            <span>Riêng tư</span>
          </span>
        );
    }
  };

  return (
    <div className="w-full max-w-[1600px] mx-auto py-4">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Theo dõi trạng thái tải lên, xử lý transcoding và hiển thị video
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            className="rounded-xl border border-[#383838] dark:border-[#383838] border-gray-300 p-2.5 text-gray-400 hover:text-white transition"
            title="Làm mới danh sách"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <Link
            href="/upload"
            className="flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-red-700 transition"
          >
            <UploadCloud className="h-4 w-4" />
            <span>{t('uploadNew')}</span>
          </Link>
        </div>
      </div>

      {/* Studio Sub Navigation */}
      <StudioNav />

      {/* Videos Table */}
      <div className="overflow-x-auto rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white shadow-xl">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[#272727] dark:border-[#272727] border-gray-200 bg-[#1c1c1c] dark:bg-[#1c1c1c] bg-gray-50 text-xs font-semibold text-gray-500 uppercase">
            <tr>
              <th className="py-3.5 px-4">{t('tableTitle')}</th>
              <th className="py-3.5 px-4">{t('tableVisibility')}</th>
              <th className="py-3.5 px-4">{t('tableStatus')}</th>
              <th className="py-3.5 px-4">{t('tableDate')}</th>
              <th className="py-3.5 px-4 text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#242424] dark:divide-[#242424] divide-gray-100">
            {isLoading && (
              <tr>
                <td colSpan={5} className="py-12 text-center text-gray-500">
                  <div className="flex items-center justify-center gap-2">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
                    <span>Đang tải video Studio...</span>
                  </div>
                </td>
              </tr>
            )}

            {!isLoading && videos.length === 0 && (
              <tr>
                <td colSpan={5} className="py-16 text-center text-gray-500">
                  <p className="text-base">{t('noVideos')}</p>
                  <Link
                    href="/upload"
                    className="inline-flex items-center gap-1.5 mt-3 text-xs font-semibold text-red-500 hover:underline"
                  >
                    <span>Tải video đầu tiên ngay</span>
                  </Link>
                </td>
              </tr>
            )}

            {!isLoading &&
              videos.map((video) => (
                <tr
                  key={video.id}
                  className="hover:bg-[#1c1c1c]/60 dark:hover:bg-[#1c1c1c]/60 hover:bg-gray-50 transition"
                >
                  {/* Video Thumbnail & Title */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-gray-800">
                        {video.thumbnail_url ? (
                          <img
                            src={video.thumbnail_url}
                            alt={video.title}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-xs text-gray-500">
                            Chưa có ảnh
                          </div>
                        )}
                        {video.duration_ms && (
                          <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10px] font-semibold text-white">
                            {formatDuration(video.duration_ms)}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-col min-w-0 max-w-md">
                        <span className="font-semibold text-gray-900 dark:text-white line-clamp-1">
                          {video.title}
                        </span>
                        <span className="text-[11px] text-gray-500 truncate font-mono">
                          {video.id}
                        </span>
                      </div>
                    </div>
                  </td>

                  {/* Visibility */}
                  <td className="py-3 px-4">{renderVisibilityIcon(video.visibility)}</td>

                  {/* Status */}
                  <td className="py-3 px-4">{renderStatusBadge(video)}</td>

                  {/* Date */}
                  <td className="py-3 px-4 text-xs text-gray-500">
                    {formatRelativeTime(video.created_at)}
                  </td>

                  {/* Actions */}
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {video.status === 'READY' && video.moderation?.state !== 'HIDDEN' && (
                        <Link
                          href={`/watch/${video.id}`}
                          className="rounded-lg p-2 text-gray-400 hover:text-white hover:bg-gray-800 transition"
                          title="Xem video"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Link>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedSubtitlesVideoId(video.id)}
                        data-testid={`manage-subtitles-${video.id}`}
                        className="rounded-lg p-2 text-gray-400 hover:text-white hover:bg-gray-800 transition"
                        title="Phụ đề"
                      >
                        <Subtitles className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(video.id)}
                        className="rounded-lg p-2 text-gray-400 hover:text-red-500 hover:bg-red-500/10 transition"
                        title="Xóa video"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Subtitles Management Modal Dialog */}
      <VideoSubtitlesDialog
        videoId={selectedSubtitlesVideoId || ''}
        isOpen={!!selectedSubtitlesVideoId}
        onClose={() => setSelectedSubtitlesVideoId(null)}
      />
    </div>
  );
}
