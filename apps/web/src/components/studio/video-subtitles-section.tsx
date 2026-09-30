'use client';

import React, { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  Subtitles,
  UploadCloud,
  Trash2,
  AlertCircle,
  CheckCircle2,
  FileText,
  Clock,
} from 'lucide-react';
import type { Video, SubtitleTrack } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { formatRelativeTime } from '../../lib/format';

export interface VideoSubtitlesSectionProps {
  videoId: string;
  initialVideo?: Video;
  onSuccess?: () => void;
}

const COMMON_LANGUAGES = [
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'en', label: 'English' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
];

const BCP47_REGEX = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export function VideoSubtitlesSection({
  videoId,
  initialVideo,
  onSuccess,
}: VideoSubtitlesSectionProps) {
  const t = useTranslations('studio.subtitles');
  const queryClient = useQueryClient();

  // Query video details to get current tracks
  const { data: video, isLoading } = useQuery({
    queryKey: ['video', videoId],
    queryFn: async () => {
      const { data, response } = await api.video.GET('/v1/videos/{video_id}', {
        params: { path: { video_id: videoId } },
      });
      if (!response.ok || !data) {
        throw new Error('Failed to load video details');
      }
      return data as Video;
    },
    initialData: initialVideo,
  });

  const tracks: SubtitleTrack[] = video?.playback?.subtitles || [];
  const isVideoFailed = video?.status === 'FAILED';

  // Upload form state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedLanguageCode, setSelectedLanguageCode] = useState<string>('vi');
  const [customLanguageCode, setCustomLanguageCode] = useState<string>('');
  const [trackLabel, setTrackLabel] = useState<string>('Tiếng Việt');
  const [fileContent, setFileContent] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [deletingLang, setDeletingLang] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');

  const handleLanguageSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectedLanguageCode(val);

    if (val !== 'custom') {
      const found = COMMON_LANGUAGES.find((l) => l.code === val);
      if (found) {
        setTrackLabel(found.label);
      }
    } else {
      setTrackLabel('');
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMessage('');
    setSuccessMessage('');
    const file = e.target.files?.[0];
    if (!file) {
      setFileContent('');
      setFileName('');
      return;
    }

    // Client-side check 1: File size ≤ 512 KiB (524,288 bytes)
    if (file.size > 524288) {
      setErrorMessage(t('errors.tooLarge'));
      setFileContent('');
      setFileName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // Client-side check 2: File reader & starts with "WEBVTT"
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = (event.target?.result as string) || '';
      const cleanStart = text.replace(/^\uFEFF/, '').trim();
      if (!cleanStart.startsWith('WEBVTT')) {
        setErrorMessage(t('errors.invalidWebVtt'));
        setFileContent('');
        setFileName('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      setFileContent(text);
      setFileName(file.name);
    };
    reader.onerror = () => {
      setErrorMessage(t('errors.invalidWebVtt'));
      setFileContent('');
      setFileName('');
    };
    reader.readAsText(file);
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');

    if (isVideoFailed) {
      setErrorMessage(t('errors.videoFailed'));
      return;
    }

    const effectiveLang =
      selectedLanguageCode === 'custom' ? customLanguageCode.trim() : selectedLanguageCode;

    if (!BCP47_REGEX.test(effectiveLang)) {
      setErrorMessage(t('errors.invalidLang'));
      return;
    }

    if (!trackLabel.trim()) {
      setErrorMessage('Vui lòng nhập tên hiển thị cho phụ đề');
      return;
    }

    if (!fileContent) {
      setErrorMessage('Vui lòng chọn tập tin WebVTT (.vtt)');
      return;
    }

    setIsSubmitting(true);
    try {
      const { error: apiErr, response } = await api.video.PUT(
        '/v1/videos/{video_id}/subtitles/{lang}',
        {
          params: { path: { video_id: videoId, lang: effectiveLang } },
          body: {
            label: trackLabel.trim(),
            content: fileContent,
          },
        },
      );

      if (response.status === 200 || response.status === 201) {
        setSuccessMessage(t('successUpload'));
        setFileContent('');
        setFileName('');
        if (fileInputRef.current) fileInputRef.current.value = '';

        await queryClient.invalidateQueries({ queryKey: ['video', videoId] });
        await queryClient.invalidateQueries({ queryKey: ['studio', 'videos'] });
        onSuccess?.();
      } else if (response.status === 400) {
        if (apiErr?.code === 'SUBTITLE_TOO_LARGE') {
          setErrorMessage(t('errors.tooLarge'));
        } else if (apiErr?.code === 'INVALID_WEBVTT') {
          setErrorMessage(
            apiErr?.detail
              ? `${t('errors.invalidWebVtt')}: ${apiErr.detail}`
              : t('errors.invalidWebVtt'),
          );
        } else {
          setErrorMessage(apiErr?.detail || t('errors.invalidWebVtt'));
        }
      } else if (response.status === 409) {
        if (apiErr?.code === 'TOO_MANY_SUBTITLES') {
          setErrorMessage(t('errors.tooManySubtitles'));
        } else {
          setErrorMessage(t('errors.videoFailed'));
        }
      } else if (response.status === 403) {
        setErrorMessage(t('errors.forbidden'));
      } else if (response.status === 404) {
        setErrorMessage(t('errors.notFound'));
      } else {
        setErrorMessage(apiErr?.detail || 'Lỗi không xác định khi tải lên phụ đề');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Lỗi kết nối';
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (lang: string) => {
    if (!confirm(t('deleteConfirm'))) return;

    setDeletingLang(lang);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const { error: apiErr, response } = await api.video.DELETE(
        '/v1/videos/{video_id}/subtitles/{lang}',
        {
          params: { path: { video_id: videoId, lang } },
        },
      );

      if (response.status === 204) {
        setSuccessMessage(t('successDelete'));
        await queryClient.invalidateQueries({ queryKey: ['video', videoId] });
        await queryClient.invalidateQueries({ queryKey: ['studio', 'videos'] });
      } else if (response.status === 403) {
        setErrorMessage(t('errors.forbidden'));
      } else if (response.status === 404) {
        setErrorMessage(t('errors.notFound'));
      } else {
        setErrorMessage(apiErr?.detail || 'Lỗi khi xóa bản phụ đề');
      }
    } catch {
      setErrorMessage('Lỗi mạng khi xóa phụ đề');
    } finally {
      setDeletingLang(null);
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="studio-subtitles-section">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <Subtitles className="h-5 w-5 text-red-500" />
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">{t('title')}</h2>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('description')}</p>
      </div>

      {/* Video failed warning */}
      {isVideoFailed && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{t('errors.videoFailed')}</span>
        </div>
      )}

      {/* Status Notifications */}
      {errorMessage && (
        <div
          role="alert"
          data-testid="subtitles-error-alert"
          className="flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          data-testid="subtitles-success-alert"
          className="flex items-center gap-2 rounded-xl bg-green-500/10 border border-green-500/30 p-3 text-xs text-green-400"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Tracks List */}
      <div className="rounded-xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#161616] dark:bg-[#161616] bg-white p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
          {t('trackList')} ({tracks.length}/20)
        </h3>

        {isLoading ? (
          <div className="py-6 text-center text-xs text-gray-500">Đang tải phụ đề...</div>
        ) : tracks.length === 0 ? (
          <div
            data-testid="no-subtitles-notice"
            className="py-6 text-center text-xs text-gray-500 dark:text-gray-400"
          >
            {t('noTracks')}
          </div>
        ) : (
          <div className="divide-y divide-[#262626] dark:divide-[#262626] divide-gray-100">
            {tracks.map((track) => (
              <div
                key={track.lang}
                data-testid={`subtitle-row-${track.lang}`}
                className="flex items-center justify-between py-2.5 px-1"
              >
                <div className="flex items-center gap-3">
                  <span className="rounded-md bg-red-600/20 px-2 py-0.5 text-xs font-mono font-bold text-red-400">
                    {track.lang}
                  </span>
                  <div className="flex flex-col">
                    <span className="text-xs font-medium text-gray-900 dark:text-gray-200">
                      {track.label}
                    </span>
                    <span className="flex items-center gap-1 text-[11px] text-gray-500">
                      <Clock className="h-3 w-3" />
                      {formatRelativeTime(track.updated_at)}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  data-testid={`delete-subtitle-${track.lang}`}
                  disabled={deletingLang === track.lang}
                  onClick={() => handleDelete(track.lang)}
                  aria-label={`Xóa phụ đề ${track.label}`}
                  className="rounded-lg p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-500/10 transition disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload New Track Form */}
      <form
        onSubmit={handleUploadSubmit}
        data-testid="upload-subtitle-form"
        className="rounded-xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#161616] dark:bg-[#161616] bg-white p-4 flex flex-col gap-4"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          {t('uploadTitle')}
        </h3>

        {/* File input */}
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            {t('file')} <span className="text-red-500">*</span>
          </label>
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".vtt,text/vtt"
              disabled={isVideoFailed || isSubmitting}
              onChange={handleFileChange}
              data-testid="subtitle-file-input"
              className="text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-red-600 file:text-white hover:file:bg-red-700 cursor-pointer disabled:opacity-50"
            />
            {fileName && (
              <span className="flex items-center gap-1 text-xs text-green-400 truncate max-w-xs">
                <FileText className="h-3.5 w-3.5" />
                {fileName}
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">{t('fileHint')}</p>
        </div>

        {/* Language selector */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              {t('lang')} <span className="text-red-500">*</span>
            </label>
            <select
              value={selectedLanguageCode}
              disabled={isVideoFailed || isSubmitting}
              onChange={handleLanguageSelectChange}
              data-testid="subtitle-lang-select"
              className="w-full rounded-lg border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-gray-50 px-3 py-2 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              {COMMON_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label} ({l.code})
                </option>
              ))}
              <option value="custom">Khác (BCP-47)...</option>
            </select>
          </div>

          {selectedLanguageCode === 'custom' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t('customLang')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={customLanguageCode}
                disabled={isVideoFailed || isSubmitting}
                onChange={(e) => setCustomLanguageCode(e.target.value)}
                placeholder={t('customLangPlaceholder')}
                data-testid="subtitle-custom-lang-input"
                className="w-full rounded-lg border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-gray-50 px-3 py-2 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500 font-mono"
              />
            </div>
          )}
        </div>

        {/* Display label */}
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            {t('label')} <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={trackLabel}
            maxLength={50}
            disabled={isVideoFailed || isSubmitting}
            onChange={(e) => setTrackLabel(e.target.value)}
            placeholder={t('labelPlaceholder')}
            data-testid="subtitle-label-input"
            className="w-full rounded-lg border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-gray-50 px-3 py-2 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500"
          />
        </div>

        {/* Submit button */}
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={isVideoFailed || isSubmitting || !fileContent}
            data-testid="upload-subtitle-button"
            className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 transition disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <UploadCloud className="h-4 w-4" />
            <span>{isSubmitting ? t('uploading') : t('uploadButton')}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
