'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type { PostImage } from '@winkey/api-client';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';

export interface PostImagesProps {
  images: PostImage[];
  authorName?: string;
}

export function PostImages({ images, authorName = 'người dùng' }: PostImagesProps) {
  const [activeLightboxIndex, setActiveLightboxIndex] = useState<number | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (activeLightboxIndex === null) return;
      if (e.key === 'Escape') {
        setActiveLightboxIndex(null);
      } else if (e.key === 'ArrowLeft') {
        setActiveLightboxIndex((prev) =>
          prev !== null ? (prev - 1 + images.length) % images.length : null,
        );
      } else if (e.key === 'ArrowRight') {
        setActiveLightboxIndex((prev) => (prev !== null ? (prev + 1) % images.length : null));
      }
    },
    [activeLightboxIndex, images.length],
  );

  useEffect(() => {
    if (activeLightboxIndex !== null) {
      window.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [activeLightboxIndex, handleKeyDown]);

  if (!images || images.length === 0) return null;

  const count = images.length;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-950">
      {/* 1 Image */}
      {count === 1 && (
        <button
          type="button"
          onClick={() => setActiveLightboxIndex(0)}
          className="w-full block overflow-hidden focus:outline-none focus:ring-2 focus:ring-red-500 rounded-2xl"
          aria-label={`Xem ảnh 1 của bài viết của ${authorName}`}
        >
          <img
            src={images[0].thumb_url || images[0].url}
            alt={`Ảnh 1 của bài viết của ${authorName}`}
            width={images[0].width || 1200}
            height={images[0].height || 800}
            loading="lazy"
            className="w-full max-h-[560px] object-cover hover:scale-[1.01] transition-transform duration-200"
          />
        </button>
      )}

      {/* 2 Images */}
      {count === 2 && (
        <div className="grid grid-cols-2 gap-1">
          {images.map((img, i) => (
            <button
              key={img.id || i}
              type="button"
              onClick={() => setActiveLightboxIndex(i)}
              className="relative aspect-square w-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-red-500"
              aria-label={`Xem ảnh ${i + 1} của bài viết của ${authorName}`}
            >
              <img
                src={img.thumb_url || img.url}
                alt={`Ảnh ${i + 1} của bài viết của ${authorName}`}
                width={img.width || 600}
                height={img.height || 600}
                loading="lazy"
                className="w-full h-full object-cover hover:scale-[1.02] transition-transform duration-200"
              />
            </button>
          ))}
        </div>
      )}

      {/* 3 Images */}
      {count === 3 && (
        <div className="grid grid-cols-2 gap-1 aspect-[4/3]">
          <button
            type="button"
            onClick={() => setActiveLightboxIndex(0)}
            className="relative h-full w-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-red-500"
            aria-label={`Xem ảnh 1 của bài viết của ${authorName}`}
          >
            <img
              src={images[0].thumb_url || images[0].url}
              alt={`Ảnh 1 của bài viết của ${authorName}`}
              width={images[0].width || 800}
              height={images[0].height || 800}
              loading="lazy"
              className="w-full h-full object-cover hover:scale-[1.02] transition-transform duration-200"
            />
          </button>
          <div className="grid grid-rows-2 gap-1 h-full">
            {images.slice(1, 3).map((img, i) => (
              <button
                key={img.id || i}
                type="button"
                onClick={() => setActiveLightboxIndex(i + 1)}
                className="relative h-full w-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-red-500"
                aria-label={`Xem ảnh ${i + 2} của bài viết của ${authorName}`}
              >
                <img
                  src={img.thumb_url || img.url}
                  alt={`Ảnh ${i + 2} của bài viết của ${authorName}`}
                  width={img.width || 400}
                  height={img.height || 400}
                  loading="lazy"
                  className="w-full h-full object-cover hover:scale-[1.02] transition-transform duration-200"
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 4 Images */}
      {count === 4 && (
        <div className="grid grid-cols-2 gap-1 aspect-square">
          {images.map((img, i) => (
            <button
              key={img.id || i}
              type="button"
              onClick={() => setActiveLightboxIndex(i)}
              className="relative aspect-square w-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-red-500"
              aria-label={`Xem ảnh ${i + 1} của bài viết của ${authorName}`}
            >
              <img
                src={img.thumb_url || img.url}
                alt={`Ảnh ${i + 1} của bài viết của ${authorName}`}
                width={img.width || 400}
                height={img.height || 400}
                loading="lazy"
                className="w-full h-full object-cover hover:scale-[1.02] transition-transform duration-200"
              />
            </button>
          ))}
        </div>
      )}

      {/* 5+ Images */}
      {count >= 5 && (
        <div className="grid grid-cols-2 gap-1 aspect-square">
          {images.slice(0, 3).map((img, i) => (
            <button
              key={img.id || i}
              type="button"
              onClick={() => setActiveLightboxIndex(i)}
              className="relative aspect-square w-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-red-500"
              aria-label={`Xem ảnh ${i + 1} của bài viết của ${authorName}`}
            >
              <img
                src={img.thumb_url || img.url}
                alt={`Ảnh ${i + 1} của bài viết của ${authorName}`}
                width={img.width || 400}
                height={img.height || 400}
                loading="lazy"
                className="w-full h-full object-cover hover:scale-[1.02] transition-transform duration-200"
              />
            </button>
          ))}
          {/* 4th slot with overlay */}
          <button
            type="button"
            onClick={() => setActiveLightboxIndex(3)}
            className="relative aspect-square w-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-red-500 group"
            aria-label={`Xem thêm ${count - 3} ảnh nữa của bài viết của ${authorName}`}
          >
            <img
              src={images[3].thumb_url || images[3].url}
              alt={`Ảnh 4 của bài viết của ${authorName}`}
              width={images[3].width || 400}
              height={images[3].height || 400}
              loading="lazy"
              className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
            />
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white font-bold text-2xl transition-colors group-hover:bg-black/70">
              +{count - 3}
            </div>
          </button>
        </div>
      )}

      {/* Lightbox Modal */}
      {activeLightboxIndex !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Xem ảnh phóng to"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-md"
          onClick={() => setActiveLightboxIndex(null)}
        >
          {/* Close button */}
          <button
            type="button"
            onClick={() => setActiveLightboxIndex(null)}
            className="absolute top-4 right-4 z-50 p-2 text-zinc-400 hover:text-white bg-zinc-900/80 hover:bg-zinc-800 rounded-full transition-colors"
            aria-label="Đóng xem ảnh"
          >
            <X className="w-6 h-6" />
          </button>

          {/* Prev button */}
          {images.length > 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setActiveLightboxIndex((activeLightboxIndex - 1 + images.length) % images.length);
              }}
              className="absolute left-4 z-50 p-3 text-zinc-300 hover:text-white bg-zinc-900/80 hover:bg-zinc-800 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
              aria-label="Ảnh trước"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}

          {/* Current image */}
          <div
            className="max-w-[90vw] max-h-[85vh] flex flex-col items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={images[activeLightboxIndex].url}
              alt={`Ảnh ${activeLightboxIndex + 1} của bài viết của ${authorName}`}
              className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
            />
            <span className="text-xs text-zinc-400 mt-3 font-medium">
              Ảnh {activeLightboxIndex + 1} / {images.length}
            </span>
          </div>

          {/* Next button */}
          {images.length > 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setActiveLightboxIndex((activeLightboxIndex + 1) % images.length);
              }}
              className="absolute right-4 z-50 p-3 text-zinc-300 hover:text-white bg-zinc-900/80 hover:bg-zinc-800 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
              aria-label="Ảnh tiếp theo"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
