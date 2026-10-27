'use client';

import React, { useState, useEffect, useRef } from 'react';
import { X, ZoomIn, ZoomOut, Check, Crop } from 'lucide-react';
import { cropAndResizeImage } from '../../lib/media/upload-image';

export interface ImageCropModalProps {
  isOpen: boolean;
  file: File | null;
  purpose: 'AVATAR' | 'BANNER';
  onClose: () => void;
  onCropComplete: (croppedBlob: Blob) => void;
}

export function ImageCropModal({
  isOpen,
  file,
  purpose,
  onClose,
  onCropComplete,
}: ImageCropModalProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageElement, setImageElement] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);

  const aspectRatio = purpose === 'AVATAR' ? 1 : 3; // 1:1 or 3:1
  const maxDimension = purpose === 'AVATAR' ? 800 : 2048;

  useEffect(() => {
    if (!file) {
      setImageSrc(null);
      setImageElement(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setImageSrc(url);

    const img = new Image();
    img.onload = () => {
      setImageElement(img);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
    img.src = url;

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  if (!isOpen || !file || !imageSrc) return null;

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleApply = async () => {
    if (!imageElement) return;

    setIsProcessing(true);
    try {
      const naturalW = imageElement.naturalWidth;
      const naturalH = imageElement.naturalHeight;

      // Determine the crop box in the source coordinate system
      let cropW = naturalW;
      let cropH = naturalW / aspectRatio;

      if (cropH > naturalH) {
        cropH = naturalH;
        cropW = naturalH * aspectRatio;
      }

      // Apply zoom (higher zoom = smaller crop window in original image)
      cropW = cropW / zoom;
      cropH = cropH / zoom;

      // Centered with offset
      const centerX = naturalW / 2 - (offset.x / (300 * zoom)) * (naturalW / 2);
      const centerY = naturalH / 2 - (offset.y / (300 * zoom)) * (naturalH / 2);

      let cropX = centerX - cropW / 2;
      let cropY = centerY - cropH / 2;

      // Bound to image bounds
      cropX = Math.max(0, Math.min(naturalW - cropW, cropX));
      cropY = Math.max(0, Math.min(naturalH - cropH, cropY));

      const blob = await cropAndResizeImage(
        imageElement,
        {
          x: cropX,
          y: cropY,
          width: cropW,
          height: cropH,
        },
        maxDimension,
      );

      onCropComplete(blob);
      onClose();
    } catch {
      // In case of error, pass original file as blob fallback
      onCropComplete(file);
      onClose();
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="crop-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      onMouseUp={handleMouseUp}
    >
      <div className="relative w-full max-w-lg bg-[#18181b] border border-[#27272a] rounded-2xl p-6 text-white shadow-2xl flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Crop className="w-5 h-5 text-red-500" />
            <h2 id="crop-modal-title" className="text-lg font-semibold">
              {purpose === 'AVATAR' ? 'Cắt ảnh đại diện (1:1)' : 'Cắt ảnh bìa (3:1)'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Viewport container */}
        <div
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          className="relative w-full h-64 sm:h-72 bg-black/60 rounded-xl overflow-hidden flex items-center justify-center cursor-move select-none border border-zinc-800"
        >
          {imageElement && (
            <img
              src={imageSrc}
              alt="Crop preview"
              draggable={false}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                transition: isDragging ? 'none' : 'transform 0.1s ease-out',
              }}
            />
          )}

          {/* Overlay guide */}
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div
              className={`border-2 border-red-500/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] ${
                purpose === 'AVATAR'
                  ? 'w-48 h-48 rounded-full'
                  : 'w-72 sm:w-80 h-24 sm:h-28 rounded-lg'
              }`}
            />
          </div>
        </div>

        {/* Zoom controls */}
        <div className="flex items-center justify-between gap-4 px-2">
          <div className="flex items-center gap-3 w-full">
            <ZoomOut className="w-4 h-4 text-zinc-400 shrink-0" />
            <input
              type="range"
              min="1"
              max="3"
              step="0.05"
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              className="w-full accent-red-600 cursor-pointer"
            />
            <ZoomIn className="w-4 h-4 text-zinc-400 shrink-0" />
          </div>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setOffset({ x: 0, y: 0 });
            }}
            className="text-xs text-zinc-400 hover:text-white transition whitespace-nowrap"
          >
            Đặt lại
          </button>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={isProcessing}
            className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition disabled:opacity-50"
          >
            {isProcessing ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            <span>Áp dụng</span>
          </button>
        </div>
      </div>
    </div>
  );
}
