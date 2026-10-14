'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Headphones, Check } from 'lucide-react';

export interface AudioTrackOption {
  index: number;
  id?: string;
  lang: string;
  label: string;
  kind?: string;
  isDefault?: boolean;
}

export interface AudioMenuProps {
  tracks: AudioTrackOption[];
  selectedIndex: number;
  onSelectTrack: (track: AudioTrackOption) => void;
}

export function AudioMenu({ tracks, selectedIndex, onSelectTrack }: AudioMenuProps) {
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

  // Hide the menu when the list is empty
  if (!tracks || tracks.length === 0) {
    return null;
  }

  const activeTrack = tracks.find((t) => t.index === selectedIndex) || tracks[0];
  const buttonLabel = activeTrack?.label || 'Âm thanh';

  return (
    <div className="relative inline-block text-left" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Chọn âm thanh"
        aria-expanded={isOpen}
        data-testid="audio-menu-button"
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium backdrop-blur-md transition border border-white/10 bg-black/60 hover:bg-black/80 text-white focus:outline-none focus:ring-2 focus:ring-red-500"
      >
        <Headphones className="h-4 w-4" />
        <span className="hidden sm:inline max-w-[120px] truncate">{buttonLabel}</span>
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label="Danh sách âm thanh"
          data-testid="audio-menu-dropdown"
          className="absolute right-0 bottom-full mb-2 w-52 rounded-xl bg-gray-900/95 p-1.5 text-xs text-white shadow-xl backdrop-blur-lg border border-white/10 z-50 focus:outline-none"
        >
          <div className="px-2 py-1 font-semibold text-gray-400 border-b border-gray-800 mb-1">
            Âm thanh
          </div>
          <div className="flex flex-col gap-0.5 max-h-60 overflow-y-auto">
            {tracks.map((track) => {
              const isSelected = selectedIndex === track.index;
              return (
                <button
                  key={`${track.index}-${track.lang}-${track.label}`}
                  role="menuitem"
                  type="button"
                  data-testid={`audio-option-${track.lang}`}
                  onClick={() => {
                    onSelectTrack(track);
                    setIsOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition ${
                    isSelected
                      ? 'bg-red-600/30 text-red-400 font-semibold'
                      : 'hover:bg-white/10 text-gray-200'
                  }`}
                >
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="truncate">{track.label}</span>
                    {track.kind && track.kind !== 'original' && (
                      <span className="rounded bg-white/20 px-1 py-0.5 text-[9px] font-bold text-gray-300">
                        {track.kind === 'dub'
                          ? 'Dub'
                          : track.kind === 'voiceover'
                            ? 'Thuyết minh'
                            : 'Commentary'}
                      </span>
                    )}
                  </div>
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
