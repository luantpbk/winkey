'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { User, UpdateMeRequest, Problem } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { UserCheck, AlertCircle, CheckCircle, Camera, Trash2, Plus, Lock } from 'lucide-react';
import { ImageCropModal } from '../media/image-crop-modal';
import { validateImageFile, uploadImage } from '../../lib/media/upload-image';

interface ProfileSettingsProps {
  user: User;
}

interface LinkItem {
  label: string;
  url: string;
}

export function ProfileSettings({ user }: ProfileSettingsProps) {
  const t = useTranslations('settings.account');
  const { updateUser, refresh } = useAuth();
  const { showToast } = useToast();

  const [displayName, setDisplayName] = useState(user.display_name);
  const [handle, setHandle] = useState(user.handle);
  const [bio, setBio] = useState(user.bio || '');
  const [links, setLinks] = useState<LinkItem[]>(
    ((user.links as any[]) || []).map((l) => ({ label: l.label || '', url: l.url })),
  );
  const [isPrivate, setIsPrivate] = useState<boolean>(Boolean(user.is_private));

  // Avatar & Banner state
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user.avatar_url);
  const [bannerUrl, setBannerUrl] = useState<string | null>(user.banner_url || null);
  const [avatarImageId, setAvatarImageId] = useState<string | null | undefined>(undefined);
  const [bannerImageId, setBannerImageId] = useState<string | null | undefined>(undefined);

  // Upload modal state
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropPurpose, setCropPurpose] = useState<'AVATAR' | 'BANNER'>('AVATAR');
  const [isCropOpen, setIsCropOpen] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDisplayName(user.display_name);
    setHandle(user.handle);
    setBio(user.bio || '');
    setLinks(((user.links as any[]) || []).map((l) => ({ label: l.label || '', url: l.url })));
    setIsPrivate(Boolean(user.is_private));
    setAvatarUrl(user.avatar_url);
    setBannerUrl(user.banner_url || null);
    setAvatarImageId(undefined);
    setBannerImageId(undefined);
  }, [
    user.display_name,
    user.handle,
    user.bio,
    user.links,
    user.is_private,
    user.avatar_url,
    user.banner_url,
  ]);

  const isDirty =
    displayName.trim() !== user.display_name ||
    handle.trim() !== user.handle ||
    bio.trim() !== (user.bio || '') ||
    isPrivate !== Boolean(user.is_private) ||
    avatarImageId !== undefined ||
    bannerImageId !== undefined ||
    JSON.stringify(links) !==
      JSON.stringify(
        ((user.links as any[]) || []).map((l) => ({ label: l.label || '', url: l.url })),
      );

  const handleFileSelect = (file: File | undefined, purpose: 'AVATAR' | 'BANNER') => {
    if (!file) return;
    setFieldErrors({});
    const validation = validateImageFile(file);
    if (!validation.valid) {
      setFieldErrors({ [purpose === 'AVATAR' ? 'avatar' : 'banner']: validation.error! });
      return;
    }
    setCropFile(file);
    setCropPurpose(purpose);
    setIsCropOpen(true);
  };

  const handleCropComplete = async (croppedBlob: Blob) => {
    setUploadProgress('Đang tải ảnh...');
    try {
      const res = await uploadImage({
        blob: croppedBlob,
        purpose: cropPurpose,
        onProgress: (p) => setUploadProgress(p),
      });

      if (cropPurpose === 'AVATAR') {
        setAvatarImageId(res.id);
        setAvatarUrl(res.url || URL.createObjectURL(croppedBlob));
        showToast({ title: 'Đã tải ảnh đại diện thành công', type: 'success' });
      } else {
        setBannerImageId(res.id);
        setBannerUrl(res.url || URL.createObjectURL(croppedBlob));
        showToast({ title: 'Đã tải ảnh bìa thành công', type: 'success' });
      }
    } catch (err: any) {
      const fieldKey = cropPurpose === 'AVATAR' ? 'avatar' : 'banner';
      setFieldErrors((prev) => ({
        ...prev,
        [fieldKey]: err?.message || 'Không thể tải ảnh lên.',
      }));
    } finally {
      setUploadProgress(null);
    }
  };

  const handleRemoveAvatar = () => {
    setAvatarImageId(null);
    setAvatarUrl(null);
  };

  const handleRemoveBanner = () => {
    setBannerImageId(null);
    setBannerUrl(null);
  };

  const handleAddLink = () => {
    if (links.length >= 5) return;
    setLinks([...links, { label: '', url: 'https://' }]);
  };

  const handleRemoveLink = (index: number) => {
    setLinks(links.filter((_, i) => i !== index));
  };

  const handleUpdateLink = (index: number, field: 'label' | 'url', value: string) => {
    const next = [...links];
    next[index] = { ...next[index], [field]: value };
    setLinks(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setGeneralError(null);

    const trimmedDisplayName = displayName.trim();
    const trimmedHandle = handle.trim();
    const trimmedBio = bio.trim();

    if (!trimmedDisplayName || trimmedDisplayName.length > 50) {
      setFieldErrors({ displayName: t('errors.displayNameRequired') });
      return;
    }

    const handleRegex = /^[A-Za-z0-9_.]{3,30}$/;
    if (!handleRegex.test(trimmedHandle)) {
      setFieldErrors({ handle: t('errors.invalidHandle') });
      return;
    }

    if (trimmedBio.length > 300) {
      setFieldErrors({ bio: 'Tiểu sử không được vượt quá 300 ký tự.' });
      return;
    }

    // Validate links: must start with https://
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      if (!l.url.trim().startsWith('https://')) {
        setFieldErrors({
          [`links_${i}`]: 'Đường dẫn liên kết phải bắt đầu bằng https://',
        });
        return;
      }
    }

    const payload: UpdateMeRequest = {};
    if (trimmedDisplayName !== user.display_name) {
      payload.display_name = trimmedDisplayName;
    }
    if (trimmedHandle !== user.handle) {
      payload.handle = trimmedHandle;
    }
    if (trimmedBio !== (user.bio || '')) {
      payload.bio = trimmedBio || null;
    }
    if (isPrivate !== Boolean(user.is_private)) {
      payload.is_private = isPrivate;
    }
    if (avatarImageId !== undefined) {
      payload.avatar_image_id = avatarImageId;
    }
    if (bannerImageId !== undefined) {
      payload.banner_image_id = bannerImageId;
    }

    // Cleaned links
    const cleanLinks = links
      .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
      .filter((l) => l.url.length > 0);

    const currentCleanLinks = ((user.links as any[]) || []).map((l) => ({
      label: l.label || '',
      url: l.url,
    }));

    if (JSON.stringify(cleanLinks) !== JSON.stringify(currentCleanLinks)) {
      payload.links = cleanLinks;
    }

    if (Object.keys(payload).length === 0) {
      showToast({ title: t('profile.noChanges'), type: 'info' });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await api.auth.PATCH('/v1/auth/me', {
        body: payload,
      });

      if (res.response.ok && res.data) {
        updateUser(res.data);
        showToast({ title: t('profile.success'), type: 'success' });
        setAvatarImageId(undefined);
        setBannerImageId(undefined);
      } else {
        const error = res.error as Problem | undefined;
        if (res.response.status === 409 || error?.code === 'HANDLE_TAKEN') {
          setFieldErrors({ handle: t('errors.handleTaken') });
        } else if (error?.code === 'LINK_INVALID') {
          setFieldErrors({
            links: 'Liên kết không hợp lệ. Vui lòng kiểm tra lại URL (chỉ chấp nhận https://).',
          });
        } else if (error?.code === 'IMAGE_INVALID') {
          setFieldErrors({ avatar: 'Ảnh không hợp lệ hoặc chưa hoàn tất xử lý.' });
        } else if (res.response.status === 429) {
          setGeneralError(t('errors.tooManyChanges'));
        } else if (error?.errors && error.errors.length > 0) {
          const map: Record<string, string> = {};
          for (const fe of error.errors) {
            map[fe.field] = fe.message;
          }
          setFieldErrors(map);
        } else {
          setGeneralError(error?.detail || error?.title || t('errors.generic'));
        }
      }
    } catch {
      setGeneralError(t('errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResendVerification = async () => {
    setIsResending(true);
    try {
      const res = await api.auth.POST('/v1/auth/email/verification');
      if (res.response.status === 202) {
        showToast({ title: t('profile.resendSuccess'), type: 'success' });
      } else if (res.response.status === 409) {
        await refresh();
        showToast({ title: t('profile.alreadyVerified'), type: 'info' });
      } else if (res.response.status === 429) {
        showToast({ title: t('profile.rateLimited'), type: 'error' });
      } else {
        showToast({ title: t('errors.generic'), type: 'error' });
      }
    } catch {
      showToast({ title: t('errors.generic'), type: 'error' });
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-[#272727] bg-white dark:bg-[#141414] p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-6 pb-4 border-b border-zinc-100 dark:border-[#202020]">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-100 dark:bg-[#1f1f1f] text-zinc-700 dark:text-zinc-200">
          <UserCheck className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white">{t('profile.title')}</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('profile.description')}</p>
        </div>
      </div>

      {generalError && (
        <div
          role="alert"
          aria-live="polite"
          className="mb-6 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{generalError}</span>
        </div>
      )}

      {uploadProgress && (
        <div className="mb-6 flex items-center gap-2 rounded-xl bg-blue-500/10 border border-blue-500/30 p-3 text-xs text-blue-400">
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
          <span>{uploadProgress}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-6 max-w-2xl">
        {/* Banner Upload */}
        <div>
          <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
            Ảnh bìa (tỷ lệ 3:1)
          </label>
          <div className="relative w-full h-36 sm:h-44 rounded-2xl overflow-hidden bg-zinc-100 dark:bg-[#1f1f1f] border border-zinc-200 dark:border-[#2f2f2f] flex items-center justify-center group">
            {bannerUrl ? (
              <img src={bannerUrl} alt="Banner" className="w-full h-full object-cover" />
            ) : (
              <div className="text-xs text-zinc-400">Chưa có ảnh bìa</div>
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => bannerInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/70 hover:bg-black text-white text-xs font-medium transition"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>{bannerUrl ? 'Đổi ảnh bìa' : 'Tải ảnh bìa'}</span>
              </button>
              {bannerUrl && (
                <button
                  type="button"
                  onClick={handleRemoveBanner}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600/80 hover:bg-red-600 text-white text-xs font-medium transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Xoá</span>
                </button>
              )}
            </div>
          </div>
          <input
            ref={bannerInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            className="hidden"
            onChange={(e) => {
              handleFileSelect(e.target.files?.[0], 'BANNER');
              e.target.value = '';
            }}
          />
          {fieldErrors.banner && (
            <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.banner}</p>
          )}
        </div>

        {/* Avatar Upload */}
        <div className="flex items-center gap-4">
          <div className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-full overflow-hidden bg-zinc-100 dark:bg-[#1f1f1f] border-2 border-zinc-200 dark:border-[#2f2f2f] shrink-0 group">
            {avatarUrl ? (
              <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-red-600 font-bold text-white text-2xl">
                {displayName.charAt(0) || '?'}
              </div>
            )}
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white"
            >
              <Camera className="w-5 h-5" />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              Ảnh đại diện (vuông 1:1)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-[#383838] bg-zinc-50 dark:bg-[#1e1e1e] text-xs font-semibold text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-[#282828] transition"
              >
                Đổi ảnh đại diện
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  onClick={handleRemoveAvatar}
                  className="px-3 py-1.5 rounded-lg border border-red-500/30 text-xs font-semibold text-red-500 hover:bg-red-500/10 transition"
                >
                  Xoá ảnh
                </button>
              )}
            </div>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Chấp nhận JPEG, PNG, WebP, AVIF (tối đa 20 MiB).
            </p>
            {fieldErrors.avatar && (
              <p className="text-xs text-red-500 font-medium">{fieldErrors.avatar}</p>
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            className="hidden"
            onChange={(e) => {
              handleFileSelect(e.target.files?.[0], 'AVATAR');
              e.target.value = '';
            }}
          />
        </div>

        {/* Display Name */}
        <div>
          <label
            htmlFor="displayName"
            className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
          >
            {t('profile.displayName')}
          </label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            required
            maxLength={50}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('profile.displayNamePlaceholder')}
            className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-2 ${
              fieldErrors.displayName
                ? 'border-red-500 focus:ring-red-500'
                : 'border-zinc-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
            }`}
          />
          {fieldErrors.displayName && (
            <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.displayName}</p>
          )}
        </div>

        {/* Handle */}
        <div>
          <label
            htmlFor="handle"
            className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
          >
            {t('profile.handle')}
          </label>
          <div className="relative">
            <span className="absolute left-3.5 top-2.5 text-sm text-zinc-400 select-none">@</span>
            <input
              id="handle"
              name="handle"
              type="text"
              required
              minLength={3}
              maxLength={30}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder={t('profile.handlePlaceholder')}
              className={`w-full h-10 rounded-xl border pl-8 pr-3.5 text-sm bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.handle
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-zinc-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
              }`}
            />
          </div>
          {fieldErrors.handle ? (
            <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.handle}</p>
          ) : (
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {t('profile.handleHelp')}
            </p>
          )}
        </div>

        {/* Bio with 300 character counter */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label
              htmlFor="bio"
              className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300"
            >
              Tiểu sử (giới thiệu)
            </label>
            <span
              className={`text-[11px] ${
                bio.length > 300 ? 'text-red-500 font-bold' : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {bio.length}/300
            </span>
          </div>
          <textarea
            id="bio"
            name="bio"
            rows={3}
            maxLength={300}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Giới thiệu đôi nét về bản thân hoặc kênh của bạn..."
            className={`w-full rounded-xl border p-3 text-sm bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-2 ${
              fieldErrors.bio
                ? 'border-red-500 focus:ring-red-500'
                : 'border-zinc-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
            }`}
          />
          {fieldErrors.bio && (
            <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.bio}</p>
          )}
        </div>

        {/* Links (max 5) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                Liên kết (tối đa 5 liên kết)
              </label>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Hiển thị trên trang hồ sơ công khai của bạn (chỉ hỗ trợ https://).
              </p>
            </div>
            {links.length < 5 && (
              <button
                type="button"
                onClick={handleAddLink}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Thêm liên kết</span>
              </button>
            )}
          </div>

          {links.length === 0 ? (
            <div className="p-4 rounded-xl border border-dashed border-zinc-300 dark:border-[#2f2f2f] text-center text-xs text-zinc-400">
              Chưa có liên kết nào. Nhấn &quot;Thêm liên kết&quot; để gắn liên kết mạng xã hội hoặc
              trang cá nhân.
            </div>
          ) : (
            <div className="space-y-2.5">
              {links.map((link, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={link.label}
                    onChange={(e) => handleUpdateLink(idx, 'label', e.target.value)}
                    placeholder="Tên nhãn (ví dụ: Website, Facebook)"
                    className="w-1/3 h-9 rounded-xl border border-zinc-300 dark:border-[#383838] px-3 text-xs bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-red-500"
                  />
                  <input
                    type="url"
                    value={link.url}
                    onChange={(e) => handleUpdateLink(idx, 'url', e.target.value)}
                    placeholder="https://..."
                    className="flex-1 h-9 rounded-xl border border-zinc-300 dark:border-[#383838] px-3 text-xs bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-red-500"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveLink(idx)}
                    className="p-2 text-zinc-400 hover:text-red-500 rounded-lg transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {fieldErrors.links && (
            <p className="mt-1.5 text-xs text-red-500 font-medium">{fieldErrors.links}</p>
          )}
        </div>

        {/* Private Account Toggle */}
        <div className="p-4 rounded-2xl bg-zinc-50 dark:bg-[#1b1b1e] border border-zinc-200 dark:border-[#2a2a2e] flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 shrink-0 mt-0.5">
              <Lock className="w-4 h-4" />
            </div>
            <div>
              <span className="text-sm font-semibold text-zinc-900 dark:text-white">
                Tài khoản riêng tư
              </span>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Khi bật, chỉ những người bạn phê duyệt mới có thể theo dõi bạn và xem danh sách
                người theo dõi / đang theo dõi của bạn.
              </p>
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-zinc-300 peer-focus:outline-none rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-red-600" />
          </label>
        </div>

        {/* Email read-only */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label
              htmlFor="email"
              className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300"
            >
              {t('profile.email')}
            </label>
            {user.email_verified ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                <CheckCircle className="h-3 w-3" />
                {t('profile.emailVerified')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                <AlertCircle className="h-3 w-3" />
                {t('profile.emailUnverified')}
              </span>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="email"
              type="email"
              disabled
              value={user.email}
              className="flex-1 h-10 rounded-xl border border-zinc-200 dark:border-[#2a2a2a] bg-zinc-100 dark:bg-[#181818] px-3.5 text-sm text-zinc-500 dark:text-zinc-400 cursor-not-allowed"
            />
            {!user.email_verified && (
              <button
                type="button"
                onClick={handleResendVerification}
                disabled={isResending}
                className="h-10 px-3.5 rounded-xl border border-zinc-300 dark:border-[#383838] bg-zinc-50 dark:bg-[#1e1e1e] text-xs font-semibold text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-[#282828] transition disabled:opacity-50 shrink-0"
              >
                {isResending ? '...' : t('profile.resendVerification')}
              </button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            {t('profile.emailHelp')}
          </p>
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={!isDirty || isSubmitting}
            className="flex h-10 px-5 items-center justify-center rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
          >
            {isSubmitting ? t('profile.saving') : t('profile.save')}
          </button>
        </div>
      </form>

      {/* Crop Modal */}
      <ImageCropModal
        isOpen={isCropOpen}
        file={cropFile}
        purpose={cropPurpose}
        onClose={() => setIsCropOpen(false)}
        onCropComplete={handleCropComplete}
      />
    </div>
  );
}
