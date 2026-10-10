'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Link } from '../../i18n/routing';
import { api } from '../../lib/api-client';
import { useToast } from '../ui/toast';
import { formatDuration } from '../../lib/format';
import { buildWatchUrl } from '../../lib/video/watch-url';
import type { Video, Visibility, UpdateVideoRequest, Problem } from '@winkey/api-client';
import { VideoStudioHeader } from './video-studio-header';
import { VideoSubtitlesSection } from './video-subtitles-section';
import {
  X,
  Save,
  Loader2,
  ExternalLink,
  AlertTriangle,
  Globe,
  Eye,
  Lock,
  Tag as TagIcon,
  Clock,
  AlertCircle,
} from 'lucide-react';

export function VideoEditView() {
  const params = useParams();
  const id = params?.id as string;
  const t = useTranslations('studio.edit');
  const tStatus = useTranslations('studio.status');
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // Fetch video details
  const {
    data: video,
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: ['video', id],
    queryFn: async () => {
      const { data, response } = await api.video.GET('/v1/videos/{video_id}', {
        params: { path: { video_id: id } },
      });
      if (!response.ok || !data) {
        if (response.status === 403 || response.status === 404) {
          throw new Error('NO_PERMISSION');
        }
        throw new Error('FAILED_TO_LOAD');
      }
      return data as Video;
    },
    enabled: !!id,
    retry: false,
  });

  // Baseline state (from server)
  const [origTitle, setOrigTitle] = useState('');
  const [origDescription, setOrigDescription] = useState('');
  const [origVisibility, setOrigVisibility] = useState<Visibility>('PRIVATE');
  const [origTags, setOrigTags] = useState<string[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);

  // Form edit state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('PRIVATE');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');

  // Status & validation states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [permissionError, setPermissionError] = useState<string | null>(null);

  // Initialize form state when video is loaded
  useEffect(() => {
    if (video && !isInitialized) {
      const loadedTitle = video.title || '';
      const loadedDesc = video.description || '';
      const loadedVis = video.visibility || 'PRIVATE';
      const loadedTags = video.tags || [];

      setTitle(loadedTitle);
      setOrigTitle(loadedTitle);

      setDescription(loadedDesc);
      setOrigDescription(loadedDesc);

      setVisibility(loadedVis);
      setOrigVisibility(loadedVis);

      setTags(loadedTags);
      setOrigTags(loadedTags);

      setIsInitialized(true);
    }
  }, [video, isInitialized]);

  // Compute dirty state
  const titleChanged = isInitialized && title !== origTitle;
  const descChanged = isInitialized && description !== origDescription;
  const visChanged = isInitialized && visibility !== origVisibility;
  const tagsChanged =
    isInitialized &&
    (tags.length !== origTags.length || tags.some((tag, i) => tag !== origTags[i]));
  const isDirty = titleChanged || descChanged || visChanged || tagsChanged;

  // Unsaved changes warning: beforeunload
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Unsaved changes warning: in-app navigation
  useEffect(() => {
    if (!isDirty) return;
    const handleLinkClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('a');
      if (!target) return;
      const href = target.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      const confirmLeave = window.confirm(t('unsavedWarning'));
      if (!confirmLeave) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', handleLinkClick, true);
    return () => document.removeEventListener('click', handleLinkClick, true);
  }, [isDirty, t]);

  // Tag manipulation
  const addTag = useCallback(
    (raw: string) => {
      const cleaned = raw.trim().replace(/\s+/g, ' ');
      if (!cleaned) return;

      if ([...cleaned].length > 30) {
        setFieldErrors((prev) => ({ ...prev, tags: t('tagTooLong') }));
        return;
      }

      if (tags.length >= 10) {
        setFieldErrors((prev) => ({ ...prev, tags: t('tooManyTags') }));
        return;
      }

      // Check duplicates (case-insensitive / accent-insensitive)
      const fold = (s: string) =>
        s
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/đ/g, 'd')
          .replace(/Đ/g, 'd');
      const foldedNew = fold(cleaned);
      const isDuplicate = tags.some((existing) => fold(existing) === foldedNew);

      if (!isDuplicate) {
        setTags((prev) => [...prev, cleaned]);
      }
      setTagInput('');
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next.tags;
        return next;
      });
    },
    [tags, t],
  );

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      e.preventDefault();
      removeTag(tags.length - 1);
    }
  };

  const removeTag = (indexToRemove: number) => {
    setTags((prev) => prev.filter((_, idx) => idx !== indexToRemove));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next.tags;
      return next;
    });
  };

  // Form submit handler
  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!isDirty || isSubmitting) return;

    // Flush any pending tag in input if valid
    if (tagInput.trim()) {
      addTag(tagInput);
    }

    // Client-side validations
    const errors: Record<string, string> = {};
    if (!title.trim()) {
      errors.title = t('titleRequired');
    } else if (title.length > 100) {
      errors.title = t('titleTooLong');
    }
    if (description.length > 5000) {
      errors.description = t('descriptionTooLong');
    }
    if (tags.length > 10) {
      errors.tags = t('tooManyTags');
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    // Build PATCH body with ONLY changed fields
    const patchBody: UpdateVideoRequest = {};
    if (titleChanged) patchBody.title = title.trim();
    if (descChanged) patchBody.description = description;
    if (visChanged) patchBody.visibility = visibility;
    if (tagsChanged) patchBody.tags = tags;

    setIsSubmitting(true);
    setFieldErrors({});
    setPermissionError(null);

    try {
      const res = await api.video.PATCH('/v1/videos/{video_id}', {
        params: { path: { video_id: id } },
        body: patchBody,
      });

      if (res.response.status === 200 && res.data) {
        const updated = res.data as Video;

        // Sync baseline state with server returned normalized values
        setOrigTitle(updated.title);
        setTitle(updated.title);

        const newDesc = updated.description || '';
        setOrigDescription(newDesc);
        setDescription(newDesc);

        setOrigVisibility(updated.visibility);
        setVisibility(updated.visibility);

        const newTags = updated.tags || [];
        setOrigTags(newTags);
        setTags(newTags);

        // Update React Query cache
        queryClient.setQueryData(['video', id], updated);

        showToast({ title: t('saveSuccess'), type: 'success' });
      } else if (res.response.status === 400) {
        const problem = res.error as Problem | undefined;
        if (problem?.errors && problem.errors.length > 0) {
          const errMap: Record<string, string> = {};
          for (const err of problem.errors) {
            if (err.field) errMap[err.field] = err.message;
          }
          setFieldErrors(errMap);
        } else {
          showToast({
            title: problem?.detail || problem?.title || 'Dữ liệu không hợp lệ',
            type: 'error',
          });
        }
      } else if (res.response.status === 403 || res.response.status === 404) {
        const msg = t('noPermission');
        setPermissionError(msg);
        showToast({ title: msg, type: 'error' });
      } else {
        showToast({ title: 'Có lỗi xảy ra khi lưu thay đổi', type: 'error' });
      }
    } catch (err) {
      console.error('Failed to update video:', err);
      showToast({ title: 'Lỗi mạng khi lưu video', type: 'error' });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Status badge renderer
  const renderStatusBadge = (v: Video) => {
    switch (v.status) {
      case 'READY':
        return (
          <span className="inline-flex items-center rounded-full bg-green-500/10 border border-green-500/30 px-2.5 py-0.5 text-xs font-semibold text-green-400">
            {tStatus('READY')}
          </span>
        );
      case 'PROCESSING':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 border border-purple-500/30 px-2.5 py-0.5 text-xs font-semibold text-purple-400">
            <span className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-ping" />
            {tStatus('PROCESSING')}
          </span>
        );
      case 'UPLOADED':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/10 border border-yellow-500/30 px-2.5 py-0.5 text-xs font-semibold text-yellow-400">
            <Clock className="h-3 w-3" />
            {tStatus('UPLOADED')}
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2.5 py-0.5 text-xs font-semibold text-red-400">
            <AlertCircle className="h-3 w-3" />
            {tStatus('FAILED')}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center rounded-full bg-gray-500/10 border border-gray-500/30 px-2.5 py-0.5 text-xs font-semibold text-gray-400">
            {v.status}
          </span>
        );
    }
  };

  if (queryError || permissionError) {
    return (
      <div className="w-full max-w-5xl mx-auto py-8">
        <VideoStudioHeader videoId={id} video={video} isLoading={isLoading} />
        <div
          data-testid="permission-error-banner"
          className="mt-6 p-6 rounded-2xl bg-red-500/10 border border-red-500/30 text-red-400 flex items-center gap-3"
        >
          <AlertTriangle className="h-6 w-6 shrink-0" />
          <div className="flex flex-col">
            <h3 className="text-base font-bold">{t('noPermission')}</h3>
            <p className="text-sm opacity-80 mt-1">
              Bạn không phải là chủ sở hữu hoặc video không tồn tại.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto py-6 flex flex-col gap-6">
      {/* Studio Navigation & Sub-tabs */}
      <VideoStudioHeader videoId={id} video={video} isLoading={isLoading} />

      {/* Main Grid: Form (left) + Preview (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Form: Title, Description, Visibility, Tags */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          <form
            onSubmit={handleSave}
            className="p-6 rounded-2xl bg-[#141414] dark:bg-[#141414] bg-white border border-[#272727] dark:border-[#272727] border-gray-200 shadow-xl space-y-6"
          >
            <div className="flex items-center justify-between pb-4 border-b border-[#272727] dark:border-[#272727] border-gray-100">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">{t('pageTitle')}</h2>

              <button
                type="submit"
                disabled={!isDirty || isSubmitting}
                data-testid="save-video-changes-btn"
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:hover:bg-red-600 text-sm font-semibold text-white transition shadow-md cursor-pointer disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>{t('saving')}</span>
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    <span>{t('saveChanges')}</span>
                  </>
                )}
              </button>
            </div>

            {/* Title field */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="video-title"
                  className="text-xs font-semibold text-gray-700 dark:text-gray-300"
                >
                  {t('videoTitle')}
                </label>
                <span
                  data-testid="title-counter"
                  className={`text-xs ${
                    title.length > 100 ? 'text-red-500 font-bold' : 'text-gray-500'
                  }`}
                >
                  {title.length}/100
                </span>
              </div>
              <input
                id="video-title"
                type="text"
                required
                maxLength={100}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('videoTitlePlaceholder')}
                data-testid="video-title-input"
                className="w-full rounded-xl bg-[#1c1c1c] dark:bg-[#1c1c1c] bg-gray-50 border border-[#333] dark:border-[#333] border-gray-300 px-4 py-2.5 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 transition"
              />
              {fieldErrors.title && (
                <p data-testid="title-error" className="text-xs text-red-500 mt-1">
                  {fieldErrors.title}
                </p>
              )}
            </div>

            {/* Description field */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="video-description"
                  className="text-xs font-semibold text-gray-700 dark:text-gray-300"
                >
                  {t('description')}
                </label>
                <span
                  data-testid="description-counter"
                  className={`text-xs ${
                    description.length > 5000 ? 'text-red-500 font-bold' : 'text-gray-500'
                  }`}
                >
                  {description.length}/5000
                </span>
              </div>
              <textarea
                id="video-description"
                rows={6}
                maxLength={5000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('descriptionPlaceholder')}
                data-testid="video-description-input"
                className="w-full rounded-xl bg-[#1c1c1c] dark:bg-[#1c1c1c] bg-gray-50 border border-[#333] dark:border-[#333] border-gray-300 p-4 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 whitespace-pre-wrap transition"
              />
              {fieldErrors.description && (
                <p data-testid="description-error" className="text-xs text-red-500 mt-1">
                  {fieldErrors.description}
                </p>
              )}
            </div>

            {/* Visibility field (Radio Options with explanations) */}
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300">
                {t('visibility')}
              </label>
              <div className="grid grid-cols-1 gap-2.5">
                {/* PUBLIC */}
                <label
                  data-testid="visibility-option-PUBLIC"
                  className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition select-none ${
                    visibility === 'PUBLIC'
                      ? 'border-red-500 bg-red-500/5 text-white'
                      : 'border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-200 hover:border-gray-500'
                  }`}
                >
                  <input
                    type="radio"
                    name="video-visibility"
                    value="PUBLIC"
                    checked={visibility === 'PUBLIC'}
                    onChange={() => setVisibility('PUBLIC')}
                    data-testid="visibility-radio-PUBLIC"
                    className="h-4 w-4 mt-0.5 text-red-600 focus:ring-red-500"
                  />
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5 font-semibold text-sm text-gray-900 dark:text-white">
                      <Globe className="h-4 w-4 text-green-500" />
                      <span>{t('public')}</span>
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('publicDesc')}
                    </span>
                  </div>
                </label>

                {/* UNLISTED */}
                <label
                  data-testid="visibility-option-UNLISTED"
                  className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition select-none ${
                    visibility === 'UNLISTED'
                      ? 'border-red-500 bg-red-500/5 text-white'
                      : 'border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-200 hover:border-gray-500'
                  }`}
                >
                  <input
                    type="radio"
                    name="video-visibility"
                    value="UNLISTED"
                    checked={visibility === 'UNLISTED'}
                    onChange={() => setVisibility('UNLISTED')}
                    data-testid="visibility-radio-UNLISTED"
                    className="h-4 w-4 mt-0.5 text-red-600 focus:ring-red-500"
                  />
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5 font-semibold text-sm text-gray-900 dark:text-white">
                      <Eye className="h-4 w-4 text-yellow-500" />
                      <span>{t('unlisted')}</span>
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('unlistedDesc')}
                    </span>
                  </div>
                </label>

                {/* PRIVATE */}
                <label
                  data-testid="visibility-option-PRIVATE"
                  className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition select-none ${
                    visibility === 'PRIVATE'
                      ? 'border-red-500 bg-red-500/5 text-white'
                      : 'border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-200 hover:border-gray-500'
                  }`}
                >
                  <input
                    type="radio"
                    name="video-visibility"
                    value="PRIVATE"
                    checked={visibility === 'PRIVATE'}
                    onChange={() => setVisibility('PRIVATE')}
                    data-testid="visibility-radio-PRIVATE"
                    className="h-4 w-4 mt-0.5 text-red-600 focus:ring-red-500"
                  />
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5 font-semibold text-sm text-gray-900 dark:text-white">
                      <Lock className="h-4 w-4 text-gray-400" />
                      <span>{t('private')}</span>
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('privateDesc')}
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {/* Tags field (TAG1) */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="video-tags-input"
                  className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300"
                >
                  <TagIcon className="h-3.5 w-3.5 text-red-500" />
                  <span>{t('tags')}</span>
                </label>
                <span className="text-xs text-gray-500">{tags.length}/10</span>
              </div>

              {/* Tags Chip Container */}
              <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-[#1c1c1c] dark:bg-[#1c1c1c] bg-gray-50 border border-[#333] dark:border-[#333] border-gray-300 min-h-[46px] focus-within:border-red-500 transition">
                {tags.map((tag, idx) => (
                  <span
                    key={`${tag}-${idx}`}
                    data-testid={`tag-chip-${idx}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 text-xs font-medium text-zinc-200 border border-zinc-700"
                  >
                    <span>{tag}</span>
                    <button
                      type="button"
                      onClick={() => removeTag(idx)}
                      data-testid={`remove-tag-${idx}`}
                      aria-label={`Xóa thẻ ${tag}`}
                      className="p-0.5 hover:text-white hover:bg-zinc-700 rounded transition"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}

                {tags.length < 10 && (
                  <input
                    id="video-tags-input"
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                    placeholder={tags.length === 0 ? t('tagsPlaceholder') : ''}
                    data-testid="tag-input"
                    className="flex-1 min-w-[140px] bg-transparent text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none py-0.5"
                  />
                )}
              </div>

              <p data-testid="tags-helper-text" className="text-xs text-gray-500">
                {t('tagsHelper')}
              </p>
              {fieldErrors.tags && (
                <p data-testid="tags-error" className="text-xs text-red-500 mt-1">
                  {fieldErrors.tags}
                </p>
              )}
            </div>

            {/* Bottom Save Button (sticky or inline) */}
            <div className="pt-4 border-t border-[#272727] dark:border-[#272727] border-gray-100 flex items-center justify-end">
              <button
                type="submit"
                disabled={!isDirty || isSubmitting}
                data-testid="save-video-changes-btn-bottom"
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:hover:bg-red-600 text-sm font-semibold text-white transition shadow-md cursor-pointer disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>{t('saving')}</span>
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    <span>{t('saveChanges')}</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Right Column: Read-only Preview */}
        <div className="flex flex-col gap-6">
          <div
            data-testid="video-preview-card"
            className="p-5 rounded-2xl bg-[#141414] dark:bg-[#141414] bg-white border border-[#272727] dark:border-[#272727] border-gray-200 shadow-xl space-y-4"
          >
            <h3 className="text-sm font-bold text-gray-900 dark:text-white pb-3 border-b border-[#272727] dark:border-[#272727] border-gray-100">
              {t('preview')}
            </h3>

            {/* Thumbnail */}
            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-zinc-900 border border-zinc-800">
              {video?.playback?.thumbnail_url ? (
                <img
                  src={video.playback.thumbnail_url}
                  alt={video?.title || 'Thumbnail'}
                  data-testid="preview-thumbnail"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div
                  data-testid="preview-thumbnail-placeholder"
                  className="flex h-full w-full items-center justify-center text-xs text-gray-500"
                >
                  Chưa có ảnh đại diện
                </div>
              )}

              {video?.duration_ms && (
                <span
                  data-testid="preview-duration"
                  className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white"
                >
                  {formatDuration(video.duration_ms)}
                </span>
              )}
            </div>

            {/* Video metadata overview */}
            <div className="space-y-3 pt-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">{t('previewStatus')}</span>
                <div data-testid="preview-status">{video && renderStatusBadge(video)}</div>
              </div>

              {video?.duration_ms && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">{t('previewDuration')}</span>
                  <span className="text-xs font-medium text-gray-900 dark:text-white">
                    {formatDuration(video.duration_ms)}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">Video ID</span>
                <span className="text-[11px] font-mono text-gray-400 truncate max-w-[150px]">
                  {id}
                </span>
              </div>
            </div>

            {/* Link to watch page */}
            {video?.status === 'READY' && (
              <div className="pt-3 border-t border-[#272727] dark:border-[#272727] border-gray-100">
                <Link
                  href={buildWatchUrl(video.id, 'other')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white transition"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Xem trên Winkey</span>
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Embedded Subtitles Section */}
      <div className="p-6 rounded-2xl bg-[#141414] dark:bg-[#141414] bg-white border border-[#272727] dark:border-[#272727] border-gray-200 shadow-xl">
        <VideoSubtitlesSection videoId={id} initialVideo={video} />
      </div>
    </div>
  );
}
