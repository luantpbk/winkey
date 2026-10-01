'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Subtitles, Check } from 'lucide-react';
import type { SubtitleTrack } from '@winkey/api-client';

export interface CcMenuProps {
  tracks: SubtitleTrack[];
  selectedLang: string | null;
  onSelectTrack: (lang: string | null) => void;
}

export function CcMenu({ tracks, selectedLang, onSelectTrack }: CcMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  if (!tracks || tracks.length === 0) {
    return null;
  }

  const isCaptionsActive = selectedLang !== null && selectedLang !== '';
  const activeTrack = tracks.find((t) => t.lang === selectedLang);
  const buttonLabel = isCaptionsActive ? activeTrack?.label || 'CC' : 'CC';

  return (
    <div className="relative inline-block text-left" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Chọn phụ đề"
        aria-expanded={isOpen}
        data-testid="cc-menu-button"
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium backdrop-blur-md transition border focus:outline-none focus:ring-2 focus:ring-red-500 ${
          isCaptionsActive
            ? 'bg-red-600 text-white border-red-500'
            : 'bg-black/60 hover:bg-black/80 text-white border-white/10'
        }`}
      >
        <Subtitles className="h-4 w-4" />
        <span className="hidden sm:inline">{buttonLabel}</span>
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label="Danh sách phụ đề"
          data-testid="cc-menu-dropdown"
          className="absolute right-0 bottom-full mb-2 w-48 rounded-xl bg-gray-900/95 p-1.5 text-xs text-white shadow-xl backdrop-blur-lg border border-white/10 z-50 focus:outline-none"
        >
          <div className="px-2 py-1 font-semibold text-gray-400 border-b border-gray-800 mb-1">
            Phụ đề
          </div>
          <div className="flex flex-col gap-0.5 max-h-60 overflow-y-auto">
            {/* Off Option */}
            <button
              role="menuitem"
              type="button"
              data-testid="cc-option-off"
              onClick={() => {
                onSelectTrack(null);
                setIsOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition ${
                !isCaptionsActive
                  ? 'bg-red-600/30 text-red-400 font-semibold'
                  : 'hover:bg-white/10 text-gray-200'
              }`}
            >
              <span>Tắt</span>
              {!isCaptionsActive && <Check className="h-3.5 w-3.5 text-red-500" />}
            </button>

            {/* Individual Subtitle Tracks */}
            {tracks.map((track) => {
              const isSelected = selectedLang === track.lang;
              return (
                <button
                  key={track.lang}
                  role="menuitem"
                  type="button"
                  data-testid={`cc-option-${track.lang}`}
                  onClick={() => {
                    onSelectTrack(track.lang);
                    setIsOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition ${
                    isSelected
                      ? 'bg-red-600/30 text-red-400 font-semibold'
                      : 'hover:bg-white/10 text-gray-200'
                  }`}
                >
                  <span className="truncate">{track.label}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
