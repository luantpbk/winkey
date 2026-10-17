'use client';

import React, { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  Headphones,
  UploadCloud,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Edit2,
  Check,
  X,
  RefreshCw,
  Star,
  Loader2,
} from 'lucide-react';
import type { AudioTrack, AudioTrackKind } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import {
  AudioTrackUploader,
  type AudioTrackUploadProgress,
} from '../../lib/uploader/audio-track-uploader';

export interface VideoAudioTracksSectionProps {
  videoId: string;
  initialTracks?: AudioTrack[];
  isVideoFailed?: boolean;
}

const COMMON_LANGUAGES = [
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'en', label: 'English' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
];

const AUDIO_KINDS: { kind: AudioTrackKind; labelKey: string }[] = [
  { kind: 'dub', labelKey: 'dub' },
  { kind: 'voiceover', labelKey: 'voiceover' },
  { kind: 'original', labelKey: 'original' },
  { kind: 'commentary', labelKey: 'commentary' },
];

const BCP47_REGEX = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export function VideoAudioTracksSection({
  videoId,
  initialTracks,
  isVideoFailed = false,
}: VideoAudioTracksSectionProps) {
  const t = useTranslations('studio.audioTracks');
  const queryClient = useQueryClient();

  // Query audio tracks list
  const { data: tracks = [], isLoading } = useQuery<AudioTrack[]>({
    queryKey: ['video-audio-tracks', videoId],
    queryFn: async (): Promise<AudioTrack[]> => {
      const res = await api.video.GET('/v1/videos/{video_id}/audio-tracks', {
        params: { path: { video_id: videoId } },
      });
      if (!res?.response?.ok) {
        if (res?.response?.status === 404) return [];
        throw new Error('Failed to load audio tracks');
      }
      return ((res.data as any)?.items ||
        (Array.isArray(res.data) ? res.data : [])) as AudioTrack[];
    },
    initialData: initialTracks,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || !Array.isArray(data)) return false;
      const hasPending = data.some(
        (t) => t.status === 'UPLOADING' || t.status === 'UPLOADED' || t.status === 'PROCESSING',
      );
      return hasPending ? 3000 : false;
    },
  });

  // State for Add Track Form
  const [selectedLang, setSelectedLang] = useState<string>('vi');
  const [customLang, setCustomLang] = useState<string>('');
  const [selectedKind, setSelectedKind] = useState<AudioTrackKind>('dub');
  const [trackLabel, setTrackLabel] = useState<string>('Tiếng Việt (Lồng tiếng)');
  const [isDefaultTrack, setIsDefaultTrack] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Upload progress state
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadPercent, setUploadPercent] = useState<number>(0);
  const [uploadStatusText, setUploadStatusText] = useState<string>('');
  const currentUploaderRef = useRef<AudioTrackUploader | null>(null);

  // Notification state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Rename inline state
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string>('');
  const [isUpdating, setIsUpdating] = useState<boolean>(false);

  // File input ref
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Helper to clear notifications
  const clearNotifications = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  // Helper to auto-generate default label when lang or kind changes
  const updateDefaultLabel = (langCode: string, kind: AudioTrackKind) => {
    const langObj = COMMON_LANGUAGES.find((l) => l.code === langCode);
    const langName = langObj ? langObj.label : langCode;
    const kindName =
      kind === 'original'
        ? 'Gốc'
        : kind === 'dub'
          ? 'Lồng tiếng'
          : kind === 'voiceover'
            ? 'Thuyết minh'
            : 'Bình luận';
    setTrackLabel(`${langName} (${kindName})`);
  };

  const handleLangChange = (val: string) => {
    setSelectedLang(val);
    clearNotifications();
    if (val !== 'custom') {
      updateDefaultLabel(val, selectedKind);
    } else {
      setTrackLabel('');
    }
  };

  const handleKindChange = (val: AudioTrackKind) => {
    setSelectedKind(val);
    clearNotifications();
    const effectiveLang = selectedLang === 'custom' ? customLang : selectedLang;
    if (effectiveLang) {
      updateDefaultLabel(effectiveLang, val);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    clearNotifications();
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  // Upload handler
  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearNotifications();

    if (isVideoFailed) {
      setErrorMessage(t('errors.videoFailed'));
      return;
    }

    if (tracks.length >= 8) {
      setErrorMessage(t('errors.tooManyTracks'));
      return;
    }

    if (!selectedFile) {
      setErrorMessage(t('errors.fileRequired'));
      return;
    }

    const effectiveLang = selectedLang === 'custom' ? customLang.trim() : selectedLang;
    if (!effectiveLang || !BCP47_REGEX.test(effectiveLang)) {
      setErrorMessage(t('errors.invalidLang'));
      return;
    }

    const effectiveLabel = trackLabel.trim() || effectiveLang;

    // Check duplicate lang + kind locally before calling API
    const exists = tracks.some((tr) => tr.lang === effectiveLang && tr.kind === selectedKind);
    if (exists) {
      setErrorMessage(t('errors.trackExists'));
      return;
    }

    setIsUploading(true);
    setUploadPercent(0);
    setUploadStatusText('Chuẩn bị tải lên...');

    const uploader = new AudioTrackUploader({
      videoId,
      file: selectedFile,
      lang: effectiveLang,
      label: effectiveLabel,
      kind: selectedKind,
      isDefault: isDefaultTrack,
      onProgress: (p: AudioTrackUploadProgress) => {
        setUploadPercent(p.percent);
        if (p.status === 'presigning') {
          setUploadStatusText('Đang lấy link tải lên...');
        } else if (p.status === 'uploading') {
          setUploadStatusText(`Đang tải lên: ${p.percent}%`);
        } else if (p.status === 'completing') {
          setUploadStatusText('Đang hoàn tất...');
        }
      },
    });

    currentUploaderRef.current = uploader;

    try {
      await uploader.start();
      setSuccessMessage(t('successUpload'));
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      queryClient.invalidateQueries({ queryKey: ['video-audio-tracks', videoId] });
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('AUDIO_TRACK_EXISTS')) {
        setErrorMessage(t('errors.trackExists'));
      } else if (msg.includes('TOO_MANY_AUDIO_TRACKS')) {
        setErrorMessage(t('errors.tooManyTracks'));
      } else if (msg.includes('UPLOAD_QUOTA_EXCEEDED')) {
        setErrorMessage(
          err?.retryAfterSeconds
            ? `Vượt quá giới hạn tải lên. Vui lòng thử lại sau ${err.retryAfterSeconds} giây.`
            : t('errors.quotaExceeded'),
        );
      } else {
        setErrorMessage(msg || 'Lỗi tải lên track âm thanh');
      }
    } finally {
      setIsUploading(false);
      currentUploaderRef.current = null;
    }
  };

  const handleCancelUpload = () => {
    if (currentUploaderRef.current) {
      currentUploaderRef.current.cancel();
      setIsUploading(false);
      setUploadPercent(0);
      setErrorMessage('Đã hủy tải lên track âm thanh.');
    }
  };

  // Toggle default handler
  const [updatingDefaultTrackId, setUpdatingDefaultTrackId] = useState<string | null>(null);

  const handleToggleDefault = async (track: AudioTrack, isDefault: boolean) => {
    clearNotifications();
    setUpdatingDefaultTrackId(track.id);
    try {
      const res = await api.video.PATCH('/v1/videos/{video_id}/audio-tracks/{track_id}', {
        params: { path: { video_id: videoId, track_id: track.id } },
        body: { is_default: isDefault },
      });
      if (!res?.response?.ok) {
        throw new Error((res?.error as any)?.detail || 'Lỗi đặt track mặc định');
      }
      setSuccessMessage(t('successUpdate'));
      queryClient.invalidateQueries({ queryKey: ['video-audio-tracks', videoId] });
    } catch (err: any) {
      setErrorMessage(err.message || 'Lỗi khi cập nhật track');
    } finally {
      setUpdatingDefaultTrackId(null);
    }
  };

  // Start renaming
  const handleStartRename = (track: AudioTrack) => {
    clearNotifications();
    setEditingTrackId(track.id);
    setEditingLabel(track.label);
  };

  // Save rename
  const handleSaveRename = async (trackId: string) => {
    if (!editingLabel.trim()) return;
    setIsUpdating(true);
    clearNotifications();
    try {
      const res = await api.video.PATCH('/v1/videos/{video_id}/audio-tracks/{track_id}', {
        params: { path: { video_id: videoId, track_id: trackId } },
        body: { label: editingLabel.trim() },
      });
      if (!res?.response?.ok) {
        throw new Error((res?.error as any)?.detail || 'Lỗi đổi tên track');
      }
      setSuccessMessage(t('successUpdate'));
      setEditingTrackId(null);
      queryClient.invalidateQueries({ queryKey: ['video-audio-tracks', videoId] });
    } catch (err: any) {
      setErrorMessage(err.message || 'Lỗi khi đổi tên track');
    } finally {
      setIsUpdating(false);
    }
  };

  // Delete track handler
  const handleDeleteTrack = async (track: AudioTrack) => {
    clearNotifications();
    const isUploadingTrack = track.status === 'UPLOADING';
    const confirmText = isUploadingTrack ? t('abortConfirm') : t('deleteConfirm');

    if (!window.confirm(confirmText)) {
      return;
    }

    try {
      if (isUploadingTrack) {
        const res = await api.upload.DELETE('/v1/uploads/{video_id}/audio-tracks/{track_id}', {
          params: { path: { video_id: videoId, track_id: track.id } },
        });
        if (!res?.response?.ok) {
          throw new Error('Lỗi hủy tải lên track');
        }
      } else {
        const res = await api.video.DELETE('/v1/videos/{video_id}/audio-tracks/{track_id}', {
          params: { path: { video_id: videoId, track_id: track.id } },
        });
        if (!res?.response?.ok) {
          throw new Error('Lỗi xóa track âm thanh');
        }
      }

      setSuccessMessage(t('successDelete'));
      queryClient.invalidateQueries({ queryKey: ['video-audio-tracks', videoId] });
    } catch (err: any) {
      setErrorMessage(err.message || 'Lỗi khi xóa track');
    }
  };

  // Replace track handler: selects a file, deletes the existing track, and uploads the new file with same lang & kind
  const [replaceTrackTarget, setReplaceTrackTarget] = useState<AudioTrack | null>(null);
  const replaceFileInputRef = useRef<HTMLInputElement>(null);

  const handleTriggerReplace = (track: AudioTrack) => {
    clearNotifications();
    setReplaceTrackTarget(track);
    if (replaceFileInputRef.current) {
      replaceFileInputRef.current.value = '';
      replaceFileInputRef.current.click();
    }
  };

  const handleReplaceFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0] || !replaceTrackTarget) return;
    const file = e.target.files[0];
    const target = replaceTrackTarget;
    setReplaceTrackTarget(null);

    clearNotifications();
    setIsUploading(true);
    setUploadPercent(0);
    setUploadStatusText(`Thay thế track ${target.label}...`);

    try {
      // 1. Delete/abort existing track first to avoid 409 AUDIO_TRACK_EXISTS
      if (target.status === 'UPLOADING') {
        await api.upload.DELETE('/v1/uploads/{video_id}/audio-tracks/{track_id}', {
          params: { path: { video_id: videoId, track_id: target.id } },
        });
      } else {
        await api.video.DELETE('/v1/videos/{video_id}/audio-tracks/{track_id}', {
          params: { path: { video_id: videoId, track_id: target.id } },
        });
      }

      // 2. Upload replacement track
      const uploader = new AudioTrackUploader({
        videoId,
        file,
        lang: target.lang,
        label: target.label,
        kind: target.kind,
        isDefault: target.is_default,
        onProgress: (p: AudioTrackUploadProgress) => {
          setUploadPercent(p.percent);
          setUploadStatusText(`Đang tải lên thay thế: ${p.percent}%`);
        },
      });

      currentUploaderRef.current = uploader;
      await uploader.start();

      setSuccessMessage('Thay thế track âm thanh thành công!');
      queryClient.invalidateQueries({ queryKey: ['video-audio-tracks', videoId] });
    } catch (err: any) {
      setErrorMessage(err?.message || 'Lỗi khi thay thế track âm thanh');
    } finally {
      setIsUploading(false);
      currentUploaderRef.current = null;
    }
  };

  const getStatusBadge = (track: AudioTrack) => {
    switch (track.status) {
      case 'READY':
        return (
          <span
            data-testid={`audio-track-status-${track.id}`}
            className="rounded px-2 py-0.5 text-[11px] font-semibold bg-green-500/10 text-green-400 border border-green-500/20"
          >
            Sẵn sàng
          </span>
        );
      case 'PROCESSING':
        return (
          <span
            data-testid={`audio-track-status-${track.id}`}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Đang xử lý
          </span>
        );
      case 'UPLOADED':
        return (
          <span
            data-testid={`audio-track-status-${track.id}`}
            className="rounded px-2 py-0.5 text-[11px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20"
          >
            Đã tải lên
          </span>
        );
      case 'UPLOADING':
        return (
          <span
            data-testid={`audio-track-status-${track.id}`}
            className="rounded px-2 py-0.5 text-[11px] font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/20"
          >
            Đang tải lên
          </span>
        );
      case 'FAILED':
        return (
          <div className="flex flex-col items-end">
            <span
              data-testid={`audio-track-status-${track.id}`}
              className="rounded px-2 py-0.5 text-[11px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20"
            >
              Lỗi xử lý
            </span>
            {track.error && (
              <span
                data-testid={`audio-track-error-${track.id}`}
                className="text-[10px] text-red-400 font-mono mt-0.5"
                title={track.error}
              >
                {track.error === 'AUDIO_DURATION_MISMATCH'
                  ? 'Lệch thời lượng (> 100ms)'
                  : track.error}
              </span>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  const getKindLabel = (kind: AudioTrackKind) => {
    switch (kind) {
      case 'original':
        return 'Gốc';
      case 'dub':
        return 'Lồng tiếng';
      case 'voiceover':
        return 'Thuyết minh';
      case 'commentary':
        return 'Bình luận';
      default:
        return kind;
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="studio-audio-tracks-section">
      {/* Hidden input for replace track file selection */}
      <input
        type="file"
        ref={replaceFileInputRef}
        onChange={handleReplaceFileSelected}
        accept="audio/*,.wav,.flac,.aac,.m4a,.mp3,.ogg,.webm"
        className="hidden"
        data-testid="audio-replace-file-input"
      />

      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <Headphones className="h-5 w-5 text-red-500" />
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">{t('title')}</h2>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('description')}</p>
      </div>

      {/* Notifications */}
      {errorMessage && (
        <div
          role="alert"
          data-testid="audio-tracks-error-alert"
          className="flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          data-testid="audio-tracks-success-alert"
          className="flex items-center gap-2 rounded-xl bg-green-500/10 border border-green-500/30 p-3 text-xs text-green-400"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Tracks List */}
      <div className="rounded-xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#161616] dark:bg-[#161616] bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            {t('trackList')} ({tracks.length}/8)
          </h3>
        </div>

        {isLoading ? (
          <div className="py-6 text-center text-xs text-gray-500">
            Đang tải danh sách track âm thanh...
          </div>
        ) : tracks.length === 0 ? (
          <div
            data-testid="no-audio-tracks-notice"
            className="py-6 text-center text-xs text-gray-500 dark:text-gray-400"
          >
            {t('noTracks')}
          </div>
        ) : (
          <div className="divide-y divide-[#262626] dark:divide-[#262626] divide-gray-100">
            {tracks.map((track) => (
              <div
                key={track.id}
                data-testid={`audio-track-row-${track.id}`}
                className="flex flex-col sm:flex-row sm:items-center justify-between py-3 px-1 gap-3"
              >
                {/* Track Info */}
                <div className="flex items-center gap-3 min-w-0">
                  <span className="rounded-md bg-blue-600/20 px-2 py-0.5 text-xs font-mono font-bold text-blue-400 shrink-0">
                    {track.lang}
                  </span>
                  <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-gray-300 shrink-0">
                    {getKindLabel(track.kind)}
                  </span>

                  {track.is_default && (
                    <span
                      data-testid={`audio-track-default-badge-${track.id}`}
                      className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 shrink-0"
                    >
                      <Star className="h-3 w-3 fill-amber-300 text-amber-300" />
                      {t('isDefaultBadge')}
                    </span>
                  )}

                  {/* Editable or display label */}
                  {editingTrackId === track.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editingLabel}
                        onChange={(e) => setEditingLabel(e.target.value)}
                        data-testid={`rename-input-${track.id}`}
                        className="rounded bg-[#202020] border border-gray-600 px-2 py-1 text-xs text-white focus:outline-none focus:border-red-500"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveRename(track.id)}
                        disabled={isUpdating}
                        data-testid={`save-rename-${track.id}`}
                        className="p-1 text-green-400 hover:bg-green-500/20 rounded"
                        aria-label="Lưu đổi tên"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingTrackId(null)}
                        data-testid={`cancel-rename-${track.id}`}
                        className="p-1 text-gray-400 hover:bg-gray-500/20 rounded"
                        aria-label="Hủy đổi tên"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs font-medium text-gray-900 dark:text-gray-200 truncate">
                      {track.label}
                    </span>
                  )}
                </div>

                {/* Track Status & Actions */}
                <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
                  {getStatusBadge(track)}

                  {/* Actions */}
                  <div className="flex items-center gap-1">
                    <label className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-gray-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={track.is_default}
                        onChange={(e) => handleToggleDefault(track, e.target.checked)}
                        disabled={track.status === 'FAILED' || updatingDefaultTrackId !== null}
                        data-testid={`make-default-track-${track.id}`}
                        aria-label={`Mặc định ${track.label}`}
                        className="h-4 w-4 rounded bg-[#202020] border-gray-600 text-red-600 focus:ring-red-500 cursor-pointer disabled:opacity-40"
                      />
                      <span className="text-xs">{t('isDefaultBadge')}</span>
                    </label>

                    <button
                      type="button"
                      onClick={() => handleStartRename(track)}
                      data-testid={`rename-track-${track.id}`}
                      title={t('rename')}
                      className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10 rounded transition"
                      aria-label={`Đổi tên ${track.label}`}
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleTriggerReplace(track)}
                      data-testid={`replace-track-${track.id}`}
                      title={t('replace')}
                      className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10 rounded transition"
                      aria-label={`Thay thế ${track.label}`}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDeleteTrack(track)}
                      data-testid={`delete-track-${track.id}`}
                      title={t('delete')}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-500/10 rounded transition"
                      aria-label={`Xóa track ${track.label}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload New Track Form */}
      <form
        onSubmit={handleUploadSubmit}
        data-testid="upload-audio-track-form"
        className="rounded-xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#161616] dark:bg-[#161616] bg-white p-4 space-y-4"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          {t('uploadTitle')}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* File Picker */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-300">
              {t('file')} <span className="text-red-500">*</span>
            </label>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept="audio/*,.wav,.flac,.aac,.m4a,.mp3,.ogg,.webm"
              data-testid="audio-file-input"
              className="w-full text-xs text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-zinc-800 file:text-white hover:file:bg-zinc-700 cursor-pointer"
            />
            <p className="text-[11px] text-gray-500">{t('fileHint')}</p>
          </div>

          {/* Language Selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-300">
              {t('lang')} <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <select
                value={selectedLang}
                onChange={(e) => handleLangChange(e.target.value)}
                data-testid="audio-lang-select"
                className="w-full rounded-lg bg-[#202020] border border-[#333] px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
              >
                {COMMON_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label} ({l.code})
                  </option>
                ))}
                <option value="custom">Ngôn ngữ khác (nhập BCP-47)...</option>
              </select>

              {selectedLang === 'custom' && (
                <input
                  type="text"
                  placeholder="vi, en-US, ja"
                  value={customLang}
                  onChange={(e) => {
                    setCustomLang(e.target.value);
                    if (e.target.value) {
                      updateDefaultLabel(e.target.value, selectedKind);
                    }
                  }}
                  data-testid="audio-custom-lang-input"
                  className="w-36 rounded-lg bg-[#202020] border border-[#333] px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
                />
              )}
            </div>
          </div>

          {/* Kind Selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-300">
              {t('kind')} <span className="text-red-500">*</span>
            </label>
            <select
              value={selectedKind}
              onChange={(e) => handleKindChange(e.target.value as AudioTrackKind)}
              data-testid="audio-kind-select"
              className="w-full rounded-lg bg-[#202020] border border-[#333] px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
            >
              {AUDIO_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {t(`kinds.${k.labelKey}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Label Input */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-300">{t('label')}</label>
            <input
              type="text"
              placeholder={t('labelPlaceholder')}
              value={trackLabel}
              onChange={(e) => setTrackLabel(e.target.value)}
              data-testid="audio-label-input"
              className="w-full rounded-lg bg-[#202020] border border-[#333] px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
            />
          </div>
        </div>

        {/* Checkbox: Is Default */}
        <div className="flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            id="audio-is-default-checkbox"
            checked={isDefaultTrack}
            onChange={(e) => setIsDefaultTrack(e.target.checked)}
            data-testid="audio-is-default-checkbox"
            className="h-4 w-4 rounded bg-[#202020] border-gray-600 text-red-600 focus:ring-red-500"
          />
          <label
            htmlFor="audio-is-default-checkbox"
            className="text-xs text-gray-300 cursor-pointer select-none"
          >
            {t('isDefault')}
          </label>
        </div>

        {/* Progress bar during upload */}
        {isUploading && (
          <div className="space-y-2 pt-2" data-testid="audio-upload-progress">
            <div className="flex items-center justify-between text-xs text-gray-300">
              <span>{uploadStatusText}</span>
              <span className="font-mono font-semibold">{uploadPercent}%</span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
              <div
                className="bg-red-600 h-2 transition-all duration-200"
                style={{ width: `${uploadPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Submit / Cancel Buttons */}
        <div className="flex items-center justify-end gap-3 pt-2">
          {isUploading ? (
            <button
              type="button"
              onClick={handleCancelUpload}
              data-testid="cancel-audio-upload-button"
              className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-gray-300 transition"
            >
              Hủy
            </button>
          ) : (
            <button
              type="submit"
              disabled={tracks.length >= 8 || isVideoFailed}
              data-testid="upload-audio-track-button"
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-40 text-xs font-semibold text-white transition shadow-sm cursor-pointer disabled:cursor-not-allowed"
            >
              <UploadCloud className="h-4 w-4" />
              <span>{t('uploadButton')}</span>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
