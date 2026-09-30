'use client';

import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { VideoSubtitlesSection } from './video-subtitles-section';

export interface VideoSubtitlesDialogProps {
  videoId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function VideoSubtitlesDialog({ videoId, isOpen, onClose }: VideoSubtitlesDialogProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quản lý phụ đề"
      data-testid="video-subtitles-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm overflow-y-auto"
    >
      <div
        className="relative w-full max-w-xl rounded-2xl bg-[#141414] dark:bg-[#141414] bg-white p-6 shadow-2xl border border-[#2b2b2b] dark:border-[#2b2b2b] border-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng hộp thoại"
          data-testid="close-subtitles-dialog"
          className="absolute top-4 right-4 rounded-lg p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 transition"
        >
          <X className="h-5 w-5" />
        </button>

        <VideoSubtitlesSection videoId={videoId} />
      </div>
    </div>
  );
}
