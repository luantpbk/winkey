'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from '../../i18n/routing';
import type { Playlist, Visibility } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { useTranslations } from 'next-intl';
import { X, Film, Loader2 } from 'lucide-react';

export interface CreatePlaylistDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (playlist: Playlist) => void;
  navigateOnSuccess?: boolean;
}

export function CreatePlaylistDialog({
  isOpen,
  onClose,
  onCreated,
  navigateOnSuccess = true,
}: CreatePlaylistDialogProps) {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const t = useTranslations('library');
  const tPl = useTranslations('playlist');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('PRIVATE');
  const [isSeries, setIsSeries] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleInputRef = useRef<HTMLInputElement>(null);

  // Focus input when dialog opens & reset form
  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDescription('');
      setVisibility('PRIVATE');
      setIsSeries(false);
      setError(null);
      setIsSubmitting(false);
      setTimeout(() => {
        titleInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('Tiêu đề không được để trống.');
      return;
    }
    if (trimmedTitle.length > 150) {
      setError('Tiêu đề không được vượt quá 150 ký tự.');
      return;
    }
    if (description.length > 5000) {
      setError('Mô tả không được vượt quá 5.000 ký tự.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await api.social.POST('/v1/playlists', {
        body: {
          title: trimmedTitle,
          description: description.trim(),
          visibility,
          is_series: isSeries,
        },
      });

      if (res.data) {
        showToast({ title: 'Đã tạo danh sách phát thành công', type: 'success' });
        onClose();
        if (onCreated) {
          onCreated(res.data);
        }
        if (navigateOnSuccess) {
          router.push(`/playlist/${res.data.id}`);
        }
      } else {
        const errData = res.error as { title?: string; code?: string } | undefined;
        const msg =
          errData?.code === 'PLAYLIST_LIMIT'
            ? 'Bạn đã đạt giới hạn tối đa 200 danh sách phát.'
            : errData?.title || 'Không thể tạo danh sách phát.';
        setError(msg);
        showToast({ title: msg, type: 'error' });
      }
    } catch {
      setError('Lỗi kết nối khi tạo danh sách phát.');
      showToast({ title: 'Lỗi mạng khi tạo danh sách phát', type: 'error' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-playlist-title"
      data-testid="create-playlist-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in"
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl flex flex-col gap-5 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <h2 id="create-playlist-title" className="text-lg font-bold text-white">
            {tPl('createNewPlaylist')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <div
              data-testid="create-playlist-error"
              className="p-3 rounded-xl bg-red-950/60 border border-red-800/80 text-xs text-red-300"
            >
              {error}
            </div>
          )}

          {/* Title */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="create-playlist-title-input"
              className="text-xs font-semibold text-zinc-300"
            >
              {tPl('playlistTitle')} <span className="text-red-500">*</span>
            </label>
            <input
              id="create-playlist-title-input"
              ref={titleInputRef}
              type="text"
              required
              maxLength={150}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (error) setError(null);
              }}
              data-testid="create-playlist-title-input"
              placeholder={tPl('playlistTitlePlaceholder')}
              className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-800/90 border border-zinc-700/80 text-white placeholder-zinc-500 text-sm focus:outline-none focus:border-red-500 transition"
            />
            <span className="text-[11px] text-zinc-500 self-end">{title.length}/150</span>
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="create-playlist-description-input"
              className="text-xs font-semibold text-zinc-300"
            >
              Mô tả (tùy chọn)
            </label>
            <textarea
              id="create-playlist-description-input"
              rows={3}
              maxLength={5000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="create-playlist-description-input"
              placeholder="Nhập mô tả danh sách phát..."
              className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-800/90 border border-zinc-700/80 text-white placeholder-zinc-500 text-sm focus:outline-none focus:border-red-500 transition resize-none"
            />
            <span className="text-[11px] text-zinc-500 self-end">{description.length}/5000</span>
          </div>

          {/* Visibility */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="create-playlist-visibility-select"
              className="text-xs font-semibold text-zinc-300"
            >
              {tPl('visibility')}
            </label>
            <div className="relative">
              <select
                id="create-playlist-visibility-select"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as Visibility)}
                data-testid="create-playlist-visibility-select"
                className="w-full appearance-none px-3.5 py-2.5 rounded-xl bg-zinc-800/90 border border-zinc-700/80 text-white text-sm focus:outline-none focus:border-red-500 transition cursor-pointer"
              >
                <option value="PRIVATE">{t('private')} (Chỉ bạn có thể xem)</option>
                <option value="UNLISTED">{t('unlisted')} (Bất kỳ ai có liên kết)</option>
                <option value="PUBLIC">{t('public')} (Mọi người có thể tìm và xem)</option>
              </select>
            </div>
          </div>

          {/* is_series checkbox & hint */}
          <div className="flex flex-col gap-1 p-3 rounded-xl bg-zinc-800/40 border border-zinc-700/40">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={isSeries}
                onChange={(e) => setIsSeries(e.target.checked)}
                data-testid="create-playlist-is-series-checkbox"
                className="mt-0.5 rounded border-zinc-600 bg-zinc-700 text-red-600 focus:ring-red-500 h-4 w-4 cursor-pointer"
              />
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-zinc-200 flex items-center gap-1.5">
                  <Film className="h-4 w-4 text-red-400" />
                  <span>{t('seriesCheckbox')}</span>
                </span>
              </div>
            </label>
            <p
              data-testid="create-playlist-series-hint"
              className="text-xs text-zinc-400 pl-6.5 mt-0.5"
            >
              {t('seriesHint')}
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              data-testid="cancel-create-playlist-btn"
              className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold transition"
            >
              {tPl('cancel')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !title.trim()}
              data-testid="submit-create-playlist-btn"
              className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:hover:bg-red-600 text-white text-xs font-semibold shadow-lg transition"
            >
              {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{isSubmitting ? tPl('creating') : tPl('create')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
