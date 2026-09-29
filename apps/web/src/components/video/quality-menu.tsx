'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Settings, Check } from 'lucide-react';

export interface QualityLevel {
  index: number;
  label: string;
  height?: number;
  bitrate?: number;
}

interface QualityMenuProps {
  levels: QualityLevel[];
  currentLevel: number;
  currentHeight?: number;
  onSelectLevel: (levelIndex: number) => void;
}

export function QualityMenu({
  levels,
  currentLevel,
  currentHeight,
  onSelectLevel,
}: QualityMenuProps) {
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

  const activeLabel =
    currentLevel === -1
      ? currentHeight
        ? `Tự động (${currentHeight}p)`
        : 'Tự động'
      : levels.find((l) => l.index === currentLevel)?.label || 'Chất lượng';

  return (
    <div className="relative inline-block text-left" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Chọn chất lượng video"
        aria-expanded={isOpen}
        className="flex items-center gap-1.5 rounded-lg bg-black/60 hover:bg-black/80 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-md transition border border-white/10 focus:outline-none focus:ring-2 focus:ring-red-500"
      >
        <Settings className="h-4 w-4" />
        <span className="hidden sm:inline">{activeLabel}</span>
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 bottom-full mb-2 w-44 rounded-xl bg-gray-900/95 p-1.5 text-xs text-white shadow-xl backdrop-blur-lg border border-white/10 z-50 focus:outline-none"
        >
          <div className="px-2 py-1 font-semibold text-gray-400 border-b border-gray-800 mb-1">
            Chất lượng
          </div>
          <div className="flex flex-col gap-0.5">
            {levels.map((lvl) => {
              const isSelected = currentLevel === lvl.index;
              return (
                <button
                  key={lvl.index}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    onSelectLevel(lvl.index);
                    setIsOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition ${
                    isSelected
                      ? 'bg-red-600/30 text-red-400 font-semibold'
                      : 'hover:bg-white/10 text-gray-200'
                  }`}
                >
                  <span>{lvl.label}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 text-red-500" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
