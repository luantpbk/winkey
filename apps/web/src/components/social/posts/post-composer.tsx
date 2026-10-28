'use client';

import React, { useState, useRef, useEffect } from 'react';
import type { Post, PostVisibility, PostImage, VideoSummary } from '@winkey/api-client';
import { api } from '../../../lib/api-client';
import { compressPostImageFile, uploadImage } from '../../../lib/media/upload-image';
import {
  Image as ImageIcon,
  Video as VideoIcon,
  X,
  AlertCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Send,
  Lock,
} from 'lucide-react';
import { useAuth } from '../../../lib/auth/auth-context';

export interface PostComposerProps {
  onPostCreated?: (post: Post) => void;
  reshareOf?: Post | null;
  onCancelReshare?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

interface UploadingImage {
  id: string; // temporary client id
  file: File;
  previewUrl: string;
  status: 'compressing' | 'uploading' | 'ready' | 'error';
  progressMsg?: string;
  postImage?: PostImage;
  error?: string;
}

export function PostComposer({
  onPostCreated,
  reshareOf = null,
  onCancelReshare,
  placeholder = 'Bạn đang nghĩ gì?',
  autoFocus = false,
}: PostComposerProps) {
  const { user } = useAuth();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<PostVisibility>('PUBLIC');
  const [uploadingImages, setUploadingImages] = useState<UploadingImage[]>([]);
  const [attachedVideoId, setAttachedVideoId] = useState<string | null>(null);
  const [attachedVideo, setAttachedVideo] = useState<VideoSummary | null>(null);
  const [showVideoInput, setShowVideoInput] = useState(false);
  const [videoUrlInput, setVideoUrlInput] = useState('');
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isPrivateAccount = (user as any)?.is_private ?? false;
  const effectiveVisibility: PostVisibility = isPrivateAccount ? 'FOLLOWERS' : visibility;

  // Auto-focus if requested
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const charCount = body.length;
  const isOverLimit = charCount > 2000;
  const hasImages = uploadingImages.some((img) => img.status === 'ready');
  const hasUploading = uploadingImages.some(
    (img) => img.status === 'compressing' || img.status === 'uploading',
  );
  const hasVideo = !!attachedVideoId;
  const hasReshare = !!reshareOf;
  const hasAttachment = hasImages || hasVideo || hasReshare;
  const isValid = !isOverLimit && !hasUploading && (body.trim().length > 0 || hasAttachment);

  // Handle Video URL attach
  const handleAttachVideo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!videoUrlInput.trim()) return;

    setVideoError(null);
    setIsLoadingVideo(true);

    try {
      // Extract video ID from URL or bare ID
      let vid = videoUrlInput.trim();
      const match = vid.match(/[?&]v=([a-zA-Z0-9_-]+)/) || vid.match(/\/watch\/([a-zA-Z0-9_-]+)/);
      if (match) {
        vid = match[1];
      }

      const { data, response } = await api.video.GET('/v1/videos/{video_id}', {
        params: { path: { video_id: vid } },
      });

      if (response.ok && data) {
        const summary: VideoSummary = {
          id: data.id,
          title: data.title,
          owner: data.owner,
          duration_ms: data.duration_ms ?? 0,
          view_count: data.view_count ?? 0,
          published_at: data.published_at || data.created_at,
          thumbnail_url: data.playback?.thumbnail_url || '',
        };
        setAttachedVideoId(data.id);
        setAttachedVideo(summary);
        setShowVideoInput(false);
        setVideoUrlInput('');
      } else {
        setVideoError('Không tìm thấy video hoặc bạn không có quyền xem video này.');
      }
    } catch {
      setVideoError('Lỗi kết nối khi tìm nạp thông tin video.');
    } finally {
      setIsLoadingVideo(false);
    }
  };

  // Handle Image Selection
  const handleSelectFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const remainingSlots = 10 - uploadingImages.length;
    if (remainingSlots <= 0) {
      setErrorMessage('Bạn chỉ có thể đính kèm tối đa 10 ảnh trong một bài viết.');
      return;
    }

    const selectedFiles = Array.from(files).slice(0, remainingSlots);
    e.target.value = ''; // Reset input

    for (const file of selectedFiles) {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const previewUrl = URL.createObjectURL(file);

      const newItem: UploadingImage = {
        id: tempId,
        file,
        previewUrl,
        status: 'compressing',
        progressMsg: 'Đang nén...',
      };

      setUploadingImages((prev) => [...prev, newItem]);

      // Execute upload pipeline
      (async () => {
        try {
          // 1. Compress in browser (max 1600px edge, WebP/JPEG ~0.8)
          const compressedBlob = await compressPostImageFile(file);

          setUploadingImages((prev) =>
            prev.map((it) =>
              it.id === tempId
                ? { ...it, status: 'uploading', progressMsg: 'Đang tải lên...' }
                : it,
            ),
          );

          // 2. Upload to S3 & complete & poll READY
          const result = await uploadImage({
            blob: compressedBlob,
            purpose: 'POST',
            onProgress: (msg) => {
              setUploadingImages((prev) =>
                prev.map((it) => (it.id === tempId ? { ...it, progressMsg: msg } : it)),
              );
            },
          });

          if (result.status === 'READY') {
            const postImg: PostImage = {
              id: result.id,
              url: result.url || previewUrl,
              thumb_url: result.thumb_url || previewUrl,
              width: result.width || 1200,
              height: result.height || 800,
            };

            setUploadingImages((prev) =>
              prev.map((it) =>
                it.id === tempId
                  ? {
                      ...it,
                      status: 'ready',
                      progressMsg: undefined,
                      postImage: postImg,
                    }
                  : it,
              ),
            );
          } else {
            throw new Error(result.error || 'Ảnh không thể xử lý.');
          }
        } catch (err: any) {
          const errMsg = err?.message || 'Tải ảnh thất bại.';
          setUploadingImages((prev) =>
            prev.map((it) =>
              it.id === tempId
                ? { ...it, status: 'error', progressMsg: undefined, error: errMsg }
                : it,
            ),
          );
        }
      })();
    }
  };

  const handleRemoveImage = (index: number) => {
    setUploadingImages((prev) => {
      const next = [...prev];
      const removed = next.splice(index, 1)[0];
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return next;
    });
  };

  const handleMoveImage = (from: number, to: number) => {
    setUploadingImages((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const item = next.splice(from, 1)[0];
      next.splice(to, 0, item);
      return next;
    });
  };

  // Submit Post
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const readyImageIds = uploadingImages
        .filter((it) => it.status === 'ready' && it.postImage?.id)
        .map((it) => it.postImage!.id);

      const requestBody: any = {
        body: body.trim(),
        visibility: effectiveVisibility,
      };

      if (readyImageIds.length > 0) {
        requestBody.image_ids = readyImageIds;
      } else if (attachedVideoId) {
        requestBody.video_id = attachedVideoId;
      } else if (reshareOf) {
        requestBody.reshare_of = reshareOf.id;
      }

      const { data, response, error } = await api.social.POST('/v1/posts', {
        body: requestBody,
      });

      if (response.ok && data) {
        // Reset composer
        setBody('');
        setUploadingImages([]);
        setAttachedVideoId(null);
        setAttachedVideo(null);
        onPostCreated?.(data);
      } else {
        if (response.status === 429) {
          setErrorMessage(
            'Bạn đã vượt quá giới hạn đăng bài (tối đa 30 bài/giờ). Vui lòng thử lại sau.',
          );
        } else if (error?.code === 'IMAGE_INVALID') {
          setErrorMessage(
            'Một hoặc nhiều ảnh không hợp lệ hoặc đã được sử dụng trong bài viết khác.',
          );
        } else {
          setErrorMessage(
            error?.detail || error?.title || 'Không thể đăng bài viết. Vui lòng thử lại.',
          );
        }
      }
    } catch {
      setErrorMessage('Lỗi kết nối máy chủ. Vui lòng kiểm tra lại mạng.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm space-y-4">
      {/* Reshare Notice if quoting */}
      {reshareOf && (
        <div className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs">
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">
            Đang trích dẫn bài viết của @{reshareOf.author?.handle || 'người dùng'}
          </span>
          {onCancelReshare && (
            <button
              type="button"
              onClick={onCancelReshare}
              className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* Main Form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Text Area */}
        <div className="relative">
          <textarea
            ref={textareaRef}
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={placeholder}
            className="w-full bg-transparent text-sm sm:text-base text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 resize-none focus:outline-none"
          />

          {/* Character counter */}
          <div className="flex justify-end text-xs">
            <span
              data-testid="post-char-counter"
              className={`font-mono ${
                isOverLimit
                  ? 'text-red-500 font-bold'
                  : charCount > 1800
                    ? 'text-amber-500'
                    : 'text-zinc-400'
              }`}
            >
              {2000 - charCount}
            </span>
          </div>
        </div>

        {/* Reshare Preview Card */}
        {reshareOf && (
          <div className="p-3 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50 dark:bg-zinc-950/50 space-y-2">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="font-bold text-zinc-900 dark:text-zinc-200">
                {reshareOf.author?.display_name}
              </span>
              <span>@{reshareOf.author?.handle}</span>
            </div>
            <p className="text-xs text-zinc-700 dark:text-zinc-300 line-clamp-3">
              {reshareOf.body}
            </p>
          </div>
        )}

        {/* Uploading & Attached Images Grid */}
        {uploadingImages.length > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {uploadingImages.map((item, idx) => (
                <div
                  key={item.id}
                  className="relative aspect-square rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-zinc-950 group"
                >
                  <img
                    src={item.previewUrl}
                    alt={`Ảnh đính kèm ${idx + 1}`}
                    className={`w-full h-full object-cover transition-opacity ${
                      item.status !== 'ready' ? 'opacity-40' : 'opacity-100'
                    }`}
                  />

                  {/* Status overlay */}
                  {item.status !== 'ready' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-2 text-center text-[11px] text-white bg-black/50">
                      {item.status === 'error' ? (
                        <>
                          <AlertCircle className="w-5 h-5 text-red-400 mb-1" />
                          <span className="text-red-300 line-clamp-2">{item.error}</span>
                        </>
                      ) : (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin text-red-500 mb-1" />
                          <span>{item.progressMsg || 'Đang xử lý...'}</span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Actions overlay */}
                  <div className="absolute top-1 right-1 flex items-center gap-1 opacity-90 group-hover:opacity-100">
                    {idx > 0 && (
                      <button
                        type="button"
                        onClick={() => handleMoveImage(idx, idx - 1)}
                        className="p-1 bg-black/60 hover:bg-black/90 text-white rounded-md transition-colors"
                        title="Di chuyển sang trái"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {idx < uploadingImages.length - 1 && (
                      <button
                        type="button"
                        onClick={() => handleMoveImage(idx, idx + 1)}
                        className="p-1 bg-black/60 hover:bg-black/90 text-white rounded-md transition-colors"
                        title="Di chuyển sang phải"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemoveImage(idx)}
                      className="p-1 bg-red-600/80 hover:bg-red-600 text-white rounded-md transition-colors"
                      title="Gỡ ảnh"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <span className="text-[11px] text-zinc-400">
              Đã đính kèm {uploadingImages.length} / 10 ảnh (nhấn mũi tên để sắp xếp lại thứ tự
              ảnh).
            </span>
          </div>
        )}

        {/* Video Embed Preview */}
        {attachedVideo && (
          <div className="relative p-3 bg-zinc-950 border border-zinc-800 rounded-xl flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-16 h-10 bg-zinc-900 rounded overflow-hidden shrink-0 relative">
                {attachedVideo.thumbnail_url && (
                  <img
                    src={attachedVideo.thumbnail_url}
                    alt={attachedVideo.title}
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
              <div className="min-w-0">
                <span className="text-xs font-bold text-white truncate block">
                  {attachedVideo.title}
                </span>
                <span className="text-[11px] text-zinc-400">
                  {attachedVideo.owner?.display_name || attachedVideo.owner?.handle}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setAttachedVideoId(null);
                setAttachedVideo(null);
              }}
              className="p-1 text-zinc-400 hover:text-white rounded"
              title="Gỡ video"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Video input form */}
        {showVideoInput && !attachedVideoId && (
          <div className="p-3 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={videoUrlInput}
                onChange={(e) => setVideoUrlInput(e.target.value)}
                placeholder="Dán liên kết video Winkey (vd: /watch?v=... hoặc video ID)..."
                className="flex-1 px-3 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-white focus:outline-none focus:border-red-500"
              />
              <button
                type="button"
                onClick={handleAttachVideo}
                disabled={isLoadingVideo || !videoUrlInput.trim()}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold"
              >
                {isLoadingVideo ? 'Đang nạp...' : 'Gắn'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowVideoInput(false);
                  setVideoError(null);
                }}
                className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {videoError && <p className="text-xs text-red-500">{videoError}</p>}
          </div>
        )}

        {/* Error message */}
        {errorMessage && (
          <div
            role="alert"
            className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2.5 text-xs text-red-500"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Actions Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-zinc-100 dark:border-zinc-800/80">
          {/* Left: Attachments & Visibility */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Image attach button */}
            <input
              type="file"
              ref={fileInputRef}
              accept="image/jpeg,image/png,image/webp,image/avif"
              multiple
              onChange={handleSelectFiles}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isSubmitting || hasVideo || hasReshare || uploadingImages.length >= 10}
              className="p-2 text-zinc-500 hover:text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 text-xs"
              title="Đính kèm ảnh (tối đa 10 ảnh)"
              aria-label="Đính kèm ảnh"
            >
              <ImageIcon className="w-4 h-4 text-emerald-500" />
              <span className="hidden sm:inline">Ảnh</span>
            </button>

            {/* Video attach button */}
            <button
              type="button"
              onClick={() => setShowVideoInput((prev) => !prev)}
              disabled={isSubmitting || hasImages || hasReshare || !!attachedVideoId}
              className="p-2 text-zinc-500 hover:text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 text-xs"
              title="Gắn video Winkey"
              aria-label="Gắn video Winkey"
            >
              <VideoIcon className="w-4 h-4 text-red-500" />
              <span className="hidden sm:inline">Video</span>
            </button>

            {/* Visibility Selector */}
            <div className="h-4 w-[1px] bg-zinc-200 dark:bg-zinc-800 mx-1 hidden sm:block" />

            {isPrivateAccount ? (
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-xs text-zinc-500 dark:text-zinc-400"
                title="Tài khoản riêng tư: bài viết chỉ hiển thị với người theo dõi"
              >
                <Lock className="w-3.5 h-3.5 text-amber-500" />
                <span>Chỉ người theo dõi (Tài khoản riêng tư)</span>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as PostVisibility)}
                  disabled={isSubmitting}
                  className="px-2.5 py-1 text-xs bg-zinc-100 dark:bg-zinc-800 border-none rounded-lg text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-red-500 font-medium cursor-pointer"
                  aria-label="Chọn quyền hiển thị bài viết"
                >
                  <option value="PUBLIC">Công khai</option>
                  <option value="FOLLOWERS">Người theo dõi</option>
                </select>
              </div>
            )}
          </div>

          {/* Right: Submit Button */}
          <button
            type="submit"
            disabled={!isValid || isSubmitting}
            className="w-full sm:w-auto px-5 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs sm:text-sm font-semibold rounded-xl shadow-lg shadow-red-600/20 flex items-center justify-center gap-2 transition-all"
            aria-label="Đăng bài viết"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Đang đăng...</span>
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                <span>Đăng</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
