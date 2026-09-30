'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '../../../i18n/routing';
import { useAuth } from '../../../lib/auth/auth-context';
import {
  MultipartUploader,
  type UploadProgress,
  computeFileFingerprint,
} from '../../../lib/uploader/uploader';
import { getUploadSession } from '../../../lib/uploader/indexeddb';
import { formatBytes } from '../../../lib/format';
import { useRealtimeRoom } from '../../../lib/realtime/realtime-context';
import {
  UploadCloud,
  FileVideo,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  ArrowRight,
  RotateCcw,
} from 'lucide-react';

export default function UploadPage() {
  const t = useTranslations('upload');
  const { user, isLoading: authLoading, isCreator, isAuthenticated } = useAuth();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploaderRef = useRef<MultipartUploader | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'UNLISTED' | 'PRIVATE'>('PUBLIC');

  const [hasResumableSession, setHasResumableSession] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const [realtimeStage, setRealtimeStage] = useState<string | null>(null);
  const [realtimePercent, setRealtimePercent] = useState<number | null>(null);
  const [isTranscodeReady, setIsTranscodeReady] = useState(false);

  // Subscribe to upload room after upload completes to track processing in real time
  const completedVideoId = progress?.status === 'completed' ? progress.videoId : null;
  useRealtimeRoom(completedVideoId ? `upload:${completedVideoId}` : null, (event) => {
    if (event.event === 'video.progress') {
      setRealtimeStage(event.data.stage);
      setRealtimePercent(event.data.percent);
    } else if (event.event === 'video.ready') {
      setIsTranscodeReady(true);
    }
  });

  // Check if there is an unfinished upload session in IndexedDB when file selected
  useEffect(() => {
    if (!selectedFile) return;
    const fp = computeFileFingerprint(selectedFile);
    getUploadSession(fp).then((session) => {
      if (session && session.completed_parts.length > 0) {
        setHasResumableSession(true);
      } else {
        setHasResumableSession(false);
      }
    });
  }, [selectedFile]);

  const handleFileChange = (file: File) => {
    setSelectedFile(file);
    const defaultTitle = file.name.replace(/\.[^/.]+$/, '');
    setTitle(defaultTitle);
  };

  const handleStartUpload = async () => {
    if (!selectedFile || !title.trim()) return;

    setIsUploading(true);
    const uploader = new MultipartUploader({
      file: selectedFile,
      title: title.trim(),
      description: description.trim(),
      visibility,
      onProgress: (p) => {
        setProgress(p);
      },
    });

    uploaderRef.current = uploader;

    try {
      await uploader.start();
    } catch (err: any) {
      console.warn('Upload stopped or failed:', err);
    } finally {
      setIsUploading(false);
    }
  };

  const handleCancelUpload = async () => {
    if (uploaderRef.current) {
      await uploaderRef.current.cancel();
      uploaderRef.current = null;
      setIsUploading(false);
      setProgress((prev) => (prev ? { ...prev, status: 'cancelled' } : null));
    }
  };

  if (authLoading) {
    return (
      <div className="flex min-h-[500px] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-red-600 border-t-transparent" />
      </div>
    );
  }

  // Role validation: Requires creator role
  if (!isAuthenticated || !isCreator) {
    return (
      <div className="mx-auto max-w-xl py-12 px-4 text-center">
        <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-8">
          <AlertTriangle className="mx-auto h-12 w-12 text-yellow-500 mb-4" />
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
            Yêu cầu vai trò Creator
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">{t('onlyCreator')}</p>
          {!isAuthenticated ? (
            <Link
              href="/login"
              className="inline-flex rounded-xl bg-red-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-red-700 transition"
            >
              Đăng nhập tài khoản Creator
            </Link>
          ) : (
            <p className="text-xs text-gray-400">
              Tài khoản hiện tại: <span className="font-semibold">{user?.email}</span> (Vai trò:{' '}
              {user?.roles?.join(', ')})
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl py-6 px-4">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Đăng video chuẩn HLS CMAF đa độ phân giải
          </p>
        </div>
        <Link
          href="/studio"
          className="rounded-xl border border-[#383838] dark:border-[#383838] border-gray-300 px-4 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 hover:bg-[#272727] dark:hover:bg-[#272727] hover:bg-gray-100 transition"
        >
          {t('goToStudio')}
        </Link>
      </div>

      <div className="rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-6 sm:p-8 shadow-xl">
        {/* Step 1: Select / Drop File */}
        {!selectedFile && (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.[0]) {
                handleFileChange(e.dataTransfer.files[0]);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#383838] dark:border-[#383838] border-gray-300 p-12 text-center hover:border-red-500 hover:bg-[#1b1b1b] dark:hover:bg-[#1b1b1b] hover:bg-gray-50 cursor-pointer transition"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) handleFileChange(e.target.files[0]);
              }}
            />
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600/10 text-red-500 mb-4">
              <UploadCloud className="h-8 w-8" />
            </div>
            <p className="text-base font-semibold text-gray-900 dark:text-white">{t('dragDrop')}</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('browseFiles')} (MP4, MOV, WebM, MKV ≤ 20 GB)
            </p>
          </div>
        )}

        {/* Step 2 & 3: File details & Uploading progress */}
        {selectedFile && (
          <div className="flex flex-col gap-6">
            {/* File info card */}
            <div className="flex items-center justify-between rounded-xl bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 p-4 border border-[#2c2c2c] dark:border-[#2c2c2c] border-gray-200">
              <div className="flex items-center gap-3 min-w-0">
                <FileVideo className="h-8 w-8 text-red-500 shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="font-semibold text-sm text-gray-900 dark:text-white truncate">
                    {selectedFile.name}
                  </span>
                  <span className="text-xs text-gray-500">{formatBytes(selectedFile.size)}</span>
                </div>
              </div>

              {!isUploading && progress?.status !== 'completed' && (
                <button
                  onClick={() => {
                    setSelectedFile(null);
                    setProgress(null);
                  }}
                  className="text-xs font-semibold text-red-500 hover:underline"
                >
                  Đổi file
                </button>
              )}
            </div>

            {hasResumableSession && !isUploading && progress?.status !== 'completed' && (
              <div className="flex items-center gap-2 rounded-xl bg-blue-500/10 border border-blue-500/30 p-3 text-xs text-blue-400">
                <RotateCcw className="h-4 w-4 shrink-0" />
                <span>
                  Phát hiện phiên tải lên chưa hoàn tất trước đó trong trình duyệt. Bấm Bắt đầu tải
                  lên để tiếp tục ngay tại vị trí đã ngắt.
                </span>
              </div>
            )}

            {/* Upload Metadata Form */}
            {!isUploading && progress?.status !== 'completed' && (
              <div className="flex flex-col gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                    {t('videoTitle')} *
                  </label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Tiêu đề video..."
                    className="w-full h-10 rounded-xl border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                    {t('videoDescription')}
                  </label>
                  <textarea
                    rows={4}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Giới thiệu nội dung video của bạn..."
                    className="w-full rounded-xl border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 p-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                    {t('visibility')}
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['PUBLIC', 'UNLISTED', 'PRIVATE'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setVisibility(mode)}
                        className={`rounded-xl py-2 px-3 text-xs font-semibold border transition ${
                          visibility === mode
                            ? 'border-red-600 bg-red-600/10 text-red-500'
                            : 'border-[#383838] dark:border-[#383838] border-gray-200 text-gray-700 dark:text-gray-300 hover:bg-[#222222]'
                        }`}
                      >
                        {mode === 'PUBLIC'
                          ? t('public')
                          : mode === 'UNLISTED'
                            ? t('unlisted')
                            : t('private')}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleStartUpload}
                  disabled={!title.trim()}
                  className="mt-2 flex h-11 w-full items-center justify-center rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition disabled:opacity-50"
                >
                  {hasResumableSession ? t('resuming') : t('startUpload')}
                </button>
              </div>
            )}

            {/* Upload Progress Dashboard */}
            {progress && (
              <div className="flex flex-col gap-4 rounded-xl border border-[#2c2c2c] dark:border-[#2c2c2c] border-gray-200 bg-[#191919] dark:bg-[#191919] bg-gray-50 p-5">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                    {progress.status === 'completed' && (
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                    )}
                    {progress.status === 'cancelled' && (
                      <XCircle className="h-5 w-5 text-gray-400" />
                    )}
                    {progress.status === 'error' && (
                      <AlertTriangle className="h-5 w-5 text-red-500" />
                    )}
                    {isUploading && (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
                    )}
                    {progress.status === 'resuming' && 'Khôi phục phiên...'}
                    {progress.status === 'presigning' && 'Xin presigned URL...'}
                    {progress.status === 'uploading' && t('uploading')}
                    {progress.status === 'completing' && 'Đang hoàn tất...'}
                    {progress.status === 'completed' && t('complete')}
                    {progress.status === 'cancelled' && 'Đã hủy tải lên.'}
                    {progress.status === 'error' && (progress.error || 'Lỗi tải lên')}
                  </span>
                  <span className="font-bold text-red-500">{progress.percent}%</span>
                </div>

                {/* Progress bar */}
                <div className="h-3 w-full overflow-hidden rounded-full bg-[#2e2e2e] dark:bg-[#2e2e2e] bg-gray-200">
                  <div
                    className={`h-full transition-all duration-300 ${
                      progress.status === 'completed' ? 'bg-green-500' : 'bg-red-600'
                    }`}
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>

                {/* Stats Row */}
                {isUploading && (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
                    <div className="flex items-center gap-1.5">
                      <Zap className="h-4 w-4 text-yellow-400" />
                      <span>{t('speed', { speed: progress.speedMBps })}</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Clock className="h-4 w-4 text-blue-400" />
                      <span>
                        {t('eta', {
                          eta: `${Math.floor(progress.etaSeconds / 60)}m ${progress.etaSeconds % 60}s`,
                        })}
                      </span>
                    </div>

                    <div>
                      {formatBytes(progress.uploadedBytes)} / {formatBytes(progress.totalBytes)} (
                      {progress.completedParts}/{progress.totalParts} parts)
                    </div>
                  </div>
                )}

                {/* Cancel action */}
                {isUploading && (
                  <div className="flex justify-end mt-2">
                    <button
                      type="button"
                      onClick={handleCancelUpload}
                      className="rounded-lg bg-gray-800 hover:bg-gray-700 px-4 py-1.5 text-xs font-semibold text-gray-200 transition"
                    >
                      {t('cancel')}
                    </button>
                  </div>
                )}

                {/* Completed Action */}
                {progress.status === 'completed' && (
                  <div className="flex flex-col gap-3 mt-2">
                    {isTranscodeReady ? (
                      <div className="flex items-center gap-2 text-xs text-green-400 font-semibold bg-green-500/10 border border-green-500/30 p-2.5 rounded-xl">
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        <span>Video đã mã hóa xong và sẵn sàng phát!</span>
                      </div>
                    ) : realtimePercent !== null ? (
                      <div className="flex items-center gap-2 text-xs text-purple-400 font-medium bg-purple-500/10 border border-purple-500/30 p-2.5 rounded-xl">
                        <div className="h-3 w-3 animate-spin rounded-full border border-purple-400 border-t-transparent" />
                        <span>
                          Đang mã hóa ({realtimeStage}): {Math.round(realtimePercent)}%
                        </span>
                      </div>
                    ) : null}

                    <div className="flex gap-3 justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedFile(null);
                          setProgress(null);
                          setIsTranscodeReady(false);
                          setRealtimePercent(null);
                        }}
                        className="rounded-xl border border-gray-600 px-4 py-2 text-xs font-semibold text-gray-300 hover:bg-gray-800 transition"
                      >
                        Tải video khác
                      </button>
                      <Link
                        href="/studio"
                        className="flex items-center gap-1.5 rounded-xl bg-red-600 px-5 py-2 text-xs font-semibold text-white hover:bg-red-700 transition"
                      >
                        <span>{t('goToStudio')}</span>
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
