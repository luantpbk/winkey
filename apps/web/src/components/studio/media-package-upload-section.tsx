'use client';

import React, { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '../../i18n/routing';
import {
  Package,
  FolderUp,
  FileArchive,
  FileVideo,
  Headphones,
  Subtitles,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  ExternalLink,
  Edit,
  Loader2,
  Star,
} from 'lucide-react';
import {
  loadPackageFromFiles,
  loadPackageFromZip,
  type LoadedMediaPackage,
} from '../../lib/media-package/package-loader';
import { PackageUploader, type PackageUploadProgress } from '../../lib/uploader/package-uploader';
import { formatBytes } from '../../lib/format';

export function MediaPackageUploadSection() {
  const t = useTranslations('upload');

  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const uploaderRef = useRef<PackageUploader | null>(null);

  const [isLoadingPackage, setIsLoadingPackage] = useState<boolean>(false);
  const [loadedPackage, setLoadedPackage] = useState<LoadedMediaPackage | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [progress, setProgress] = useState<PackageUploadProgress | null>(null);
  const [completedVideoId, setCompletedVideoId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleReset = () => {
    setLoadedPackage(null);
    setValidationErrors([]);
    setIsUploading(false);
    setProgress(null);
    setCompletedVideoId(null);
    setUploadError(null);
    if (folderInputRef.current) folderInputRef.current.value = '';
    if (zipInputRef.current) zipInputRef.current.value = '';
  };

  const processLoadedResult = (res: {
    success: boolean;
    package?: LoadedMediaPackage;
    errors: string[];
  }) => {
    setIsLoadingPackage(false);
    if (res.success && res.package) {
      setLoadedPackage(res.package);
      setValidationErrors([]);
    } else {
      setLoadedPackage(null);
      setValidationErrors(res.errors);
    }
  };

  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setIsLoadingPackage(true);
    setValidationErrors([]);
    try {
      const res = await loadPackageFromFiles(e.target.files);
      processLoadedResult(res);
    } catch (err: any) {
      setIsLoadingPackage(false);
      setValidationErrors([err.message || 'Lỗi khi đọc thư mục gói']);
    }
  };

  const handleZipChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0]) return;
    const file = e.target.files[0];
    setIsLoadingPackage(true);
    setValidationErrors([]);
    try {
      const res = await loadPackageFromZip(file);
      processLoadedResult(res);
    } catch (err: any) {
      setIsLoadingPackage(false);
      setValidationErrors([err.message || 'Lỗi khi giải nén file .zip']);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

    setIsLoadingPackage(true);
    setValidationErrors([]);

    const files = Array.from(e.dataTransfer.files);
    try {
      if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) {
        const res = await loadPackageFromZip(files[0]);
        processLoadedResult(res);
      } else {
        const res = await loadPackageFromFiles(files);
        processLoadedResult(res);
      }
    } catch (err: any) {
      setIsLoadingPackage(false);
      setValidationErrors([err.message || 'Lỗi khi đọc gói media']);
    }
  };

  const handleStartUpload = async () => {
    if (!loadedPackage) return;

    setIsUploading(true);
    setUploadError(null);

    const uploader = new PackageUploader({
      mediaPackage: loadedPackage,
      onProgress: (p) => {
        setProgress(p);
      },
    });

    uploaderRef.current = uploader;

    try {
      const vid = await uploader.start();
      setCompletedVideoId(vid);
    } catch (err: any) {
      if (err?.message !== 'UPLOAD_CANCELLED') {
        setUploadError(err?.message || 'Lỗi khi tải lên gói media');
      }
    } finally {
      setIsUploading(false);
      uploaderRef.current = null;
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

  return (
    <div className="flex flex-col gap-6" data-testid="studio-media-package-section">
      {/* Hidden file inputs for Folder and ZIP */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is standard for folder picking in Chromium/WebKit/Firefox
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleFolderChange}
        data-testid="package-folder-input"
      />
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={handleZipChange}
        data-testid="package-zip-input"
      />

      {/* Upload Completed View */}
      {completedVideoId && (
        <div
          data-testid="package-upload-success"
          className="rounded-2xl border border-green-500/30 bg-green-500/10 p-8 text-center space-y-4"
        >
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-500/20 text-green-400">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">
              {t('packageComplete')}
            </h3>
            <p className="text-xs text-gray-400 mt-1">
              Video, các track âm thanh và phụ đề đã được tải lên và sẵn sàng xử lý.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3 pt-4">
            <Link
              href={`/studio/videos/${completedVideoId}/edit`}
              className="flex items-center gap-2 rounded-xl bg-red-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-red-700 transition"
              data-testid="package-success-goto-edit"
            >
              <Edit className="h-4 w-4" />
              <span>{t('viewEdit')}</span>
            </Link>

            <Link
              href={`/watch/${completedVideoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800 px-5 py-2.5 text-xs font-semibold text-gray-200 hover:bg-zinc-700 transition"
              data-testid="package-success-goto-watch"
            >
              <ExternalLink className="h-4 w-4" />
              <span>{t('viewWatch')}</span>
            </Link>

            <button
              type="button"
              onClick={handleReset}
              className="rounded-xl px-5 py-2.5 text-xs font-semibold text-gray-400 hover:text-white transition"
            >
              Tải lên gói khác
            </button>
          </div>
        </div>
      )}

      {/* Step 1: Select / Drop Media Package */}
      {!loadedPackage && !completedVideoId && (
        <div className="space-y-4">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#383838] dark:border-[#383838] border-gray-300 p-10 text-center hover:border-red-500 hover:bg-[#1b1b1b] dark:hover:bg-[#1b1b1b] hover:bg-gray-50 transition"
            data-testid="package-dropzone"
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600/10 text-red-500 mb-4">
              <Package className="h-8 w-8" />
            </div>

            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              {t('packageTitle')}
            </h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 max-w-md">
              {t('dropPackageHint')}
            </p>

            <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                data-testid="choose-folder-button"
                className="flex items-center gap-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 px-5 py-2.5 text-xs font-semibold text-white border border-zinc-700 transition cursor-pointer"
              >
                <FolderUp className="h-4 w-4 text-amber-400" />
                <span>{t('chooseFolder')}</span>
              </button>

              <button
                type="button"
                onClick={() => zipInputRef.current?.click()}
                data-testid="choose-zip-button"
                className="flex items-center gap-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 px-5 py-2.5 text-xs font-semibold text-white border border-zinc-700 transition cursor-pointer"
              >
                <FileArchive className="h-4 w-4 text-blue-400" />
                <span>{t('chooseZip')}</span>
              </button>
            </div>
          </div>

          {isLoadingPackage && (
            <div className="flex items-center justify-center gap-2 p-4 text-xs text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin text-red-500" />
              <span>{t('readingPackage')}</span>
            </div>
          )}

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div
              role="alert"
              data-testid="package-validation-errors"
              className="rounded-xl bg-red-500/10 border border-red-500/30 p-4 space-y-2 text-xs text-red-400"
            >
              <div className="flex items-center gap-2 font-semibold">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{t('packageErrors')}</span>
              </div>
              <ul className="list-disc list-inside space-y-1 pl-1">
                {validationErrors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Package Preview & Upload Orchestration */}
      {loadedPackage && !completedVideoId && (
        <div className="space-y-6" data-testid="package-preview-card">
          {/* Header & Reset button */}
          <div className="flex items-center justify-between pb-3 border-b border-[#272727] dark:border-[#272727] border-gray-200">
            <div>
              <h3 className="text-base font-bold text-gray-900 dark:text-white">
                {t('packageOverview')}
              </h3>
              <p className="text-xs text-gray-500">{loadedPackage.manifest.title}</p>
            </div>
            {!isUploading && (
              <button
                type="button"
                onClick={handleReset}
                className="text-xs text-red-500 hover:underline cursor-pointer"
              >
                Chọn gói khác
              </button>
            )}
          </div>

          {/* Manifest metadata summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="rounded-xl bg-[#1a1a1a] p-3 border border-[#2a2a2a]">
              <span className="text-gray-500 block mb-1">Tiêu đề:</span>
              <span className="font-semibold text-gray-200 truncate block">
                {loadedPackage.manifest.title}
              </span>
            </div>
            <div className="rounded-xl bg-[#1a1a1a] p-3 border border-[#2a2a2a]">
              <span className="text-gray-500 block mb-1">Chế độ hiển thị:</span>
              <span className="font-semibold text-gray-200 block">
                {loadedPackage.manifest.visibility || 'PUBLIC'}
              </span>
            </div>
            <div className="rounded-xl bg-[#1a1a1a] p-3 border border-[#2a2a2a]">
              <span className="text-gray-500 block mb-1">Mô tả:</span>
              <span className="text-gray-300 truncate block">
                {loadedPackage.manifest.description || '(Không có)'}
              </span>
            </div>
          </div>

          {/* Video file row */}
          <div className="rounded-xl bg-[#1a1a1a] p-4 border border-[#2a2a2a] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FileVideo className="h-6 w-6 text-red-500 shrink-0" />
              <div>
                <span className="text-xs font-semibold text-gray-200 block">
                  {loadedPackage.videoFile.name}
                </span>
                <span className="text-[11px] text-gray-500">
                  {formatBytes(loadedPackage.videoFile.size)}
                </span>
              </div>
            </div>
            {isUploading && progress?.video && (
              <span className="text-xs font-mono text-gray-400 font-semibold">
                {progress.video.percent}%
              </span>
            )}
          </div>

          {/* Audio tracks list */}
          <div
            className="rounded-xl bg-[#1a1a1a] p-4 border border-[#2a2a2a] space-y-3"
            data-testid="package-audio-list"
          >
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-2">
              <Headphones className="h-4 w-4 text-red-500" />
              <span>{t('audioTracksCount', { count: loadedPackage.audioTracks.length })}</span>
            </h4>

            {loadedPackage.audioTracks.length === 0 ? (
              <p className="text-xs text-gray-500 italic">Không có track âm thanh bổ sung.</p>
            ) : (
              <div className="divide-y divide-[#282828]">
                {loadedPackage.audioTracks.map((tr) => {
                  const key = `${tr.meta.lang}:${tr.meta.kind}`;
                  const pItem = progress?.audioTracks.find((a) => a.id === key);
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between py-2 text-xs"
                      data-testid={`package-audio-row-${tr.meta.lang}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-blue-500/20 px-2 py-0.5 font-mono text-blue-400 font-bold">
                          {tr.meta.lang}
                        </span>
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-gray-300">
                          {tr.meta.kind}
                        </span>
                        {tr.meta.default && (
                          <span className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300 font-bold">
                            <Star className="h-2.5 w-2.5 fill-amber-300" />
                            Default
                          </span>
                        )}
                        <span className="text-gray-300 font-medium">{tr.meta.label}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] text-gray-500">
                          {formatBytes(tr.file.size)}
                        </span>
                        {isUploading && pItem && (
                          <span className="text-[11px] font-mono text-gray-400">
                            {pItem.status === 'completed' ? '✓' : `${pItem.percent}%`}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Subtitles list */}
          <div
            className="rounded-xl bg-[#1a1a1a] p-4 border border-[#2a2a2a] space-y-3"
            data-testid="package-subtitles-list"
          >
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-2">
              <Subtitles className="h-4 w-4 text-red-500" />
              <span>{t('subtitlesCount', { count: loadedPackage.subtitles.length })}</span>
            </h4>

            {loadedPackage.subtitles.length === 0 ? (
              <p className="text-xs text-gray-500 italic">Không có phụ đề.</p>
            ) : (
              <div className="divide-y divide-[#282828]">
                {loadedPackage.subtitles.map((sub) => {
                  const pItem = progress?.subtitles.find((s) => s.lang === sub.meta.lang);
                  return (
                    <div
                      key={sub.meta.lang}
                      className="flex items-center justify-between py-2 text-xs"
                      data-testid={`package-subtitle-row-${sub.meta.lang}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-red-500/20 px-2 py-0.5 font-mono text-red-400 font-bold">
                          {sub.meta.lang}
                        </span>
                        {sub.meta.kind === 'captions' && (
                          <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-bold text-gray-200">
                            CC
                          </span>
                        )}
                        <span className="text-gray-300 font-medium">{sub.meta.label}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] text-gray-500">
                          {formatBytes(sub.file.size)}
                        </span>
                        {isUploading && pItem && (
                          <span className="text-[11px] font-mono text-gray-400">
                            {pItem.status === 'completed' ? '✓' : '...'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Upload Progress Bar */}
          {isUploading && progress && (
            <div className="space-y-2 pt-2" data-testid="package-overall-progress">
              <div className="flex items-center justify-between text-xs text-gray-300">
                <span>{t('uploadingPackage')}</span>
                <span className="font-mono font-semibold">{progress.overallPercent}%</span>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-red-600 h-2.5 transition-all duration-200"
                  style={{ width: `${progress.overallPercent}%` }}
                />
              </div>
            </div>
          )}

          {uploadError && (
            <div
              role="alert"
              className="rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-400 flex items-center gap-2"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{uploadError}</span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-[#272727]">
            {isUploading ? (
              <button
                type="button"
                onClick={handleCancelUpload}
                data-testid="cancel-package-upload-button"
                className="px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-gray-300 transition"
              >
                Hủy bỏ
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStartUpload}
                data-testid="start-package-upload-button"
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-xs font-semibold text-white transition shadow-md cursor-pointer"
              >
                <ArrowRight className="h-4 w-4" />
                <span>{t('startPackageUpload')}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
