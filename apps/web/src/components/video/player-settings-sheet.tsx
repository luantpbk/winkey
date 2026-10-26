'use client';

import React, { useState, useEffect } from 'react';
import { Subtitles, Headphones, Sliders, ChevronRight, ChevronLeft, Check, X } from 'lucide-react';
import type { SubtitleTrack } from '@winkey/api-client';
import type { AudioTrackOption } from './audio-menu';
import type { QualityLevel } from './quality-menu';

export interface PlayerSettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  // Subtitles
  subtitles?: SubtitleTrack[];
  selectedSubtitleLang: string | null;
  onSelectSubtitle: (lang: string | null) => void;
  // Audio
  audioTracks?: AudioTrackOption[];
  selectedAudioIndex: number;
  onSelectAudio: (track: AudioTrackOption) => void;
  // Quality
  qualityLevels?: QualityLevel[];
  currentLevel: number;
  currentHeight?: number;
  onSelectQuality: (levelIndex: number) => void;
}

type SettingsView = 'main' | 'subtitles' | 'audio' | 'quality';

export function PlayerSettingsSheet({
  isOpen,
  onClose,
  subtitles = [],
  selectedSubtitleLang,
  onSelectSubtitle,
  audioTracks = [],
  selectedAudioIndex,
  onSelectAudio,
  qualityLevels = [],
  currentLevel,
  currentHeight,
  onSelectQuality,
}: PlayerSettingsSheetProps) {
  const [activeView, setActiveView] = useState<SettingsView>('main');

  // Reset view when opened
  useEffect(() => {
    if (isOpen) {
      setActiveView('main');
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Active labels
  const activeSubtitleLabel =
    selectedSubtitleLang === null || selectedSubtitleLang === ''
      ? 'Tắt'
      : subtitles.find((t) => t.lang === selectedSubtitleLang)?.label || selectedSubtitleLang;

  const activeAudioTrack =
    audioTracks.find((t) => t.index === selectedAudioIndex) || audioTracks[0];
  const activeAudioLabel = activeAudioTrack?.label || 'Mặc định';

  const activeQualityLabel =
    currentLevel === -1
      ? currentHeight
        ? `Tự động (${currentHeight}p)`
        : 'Tự động'
      : qualityLevels.find((l) => l.index === currentLevel)?.label || 'Tự động';

  return (
    <div
      data-testid="player-settings-sheet"
      className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center"
      onClick={(e) => {
        // Prevent clicks from toggling video playback
        e.stopPropagation();
      }}
    >
      {/* Backdrop */}
      <div
        data-testid="player-settings-backdrop"
        className="absolute inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      {/* Sheet Content */}
      <div className="relative z-10 w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl bg-[#141414] border-t sm:border border-white/10 p-4 shadow-2xl text-white max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-white/10 mb-2">
          {activeView === 'main' ? (
            <h3 className="font-bold text-base text-gray-100">Cài đặt phát lại</h3>
          ) : (
            <button
              type="button"
              data-testid="settings-back-btn"
              onClick={() => setActiveView('main')}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-200 hover:text-white transition cursor-pointer min-h-11 min-w-11"
            >
              <ChevronLeft className="h-5 w-5" />
              <span>
                {activeView === 'subtitles' && 'Phụ đề'}
                {activeView === 'audio' && 'Âm thanh'}
                {activeView === 'quality' && 'Chất lượng'}
              </span>
            </button>
          )}

          <button
            type="button"
            data-testid="settings-close-btn"
            onClick={onClose}
            aria-label="Đóng cài đặt"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-white/10 text-gray-400 hover:text-white transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main Menu View */}
        {activeView === 'main' && (
          <div className="flex flex-col gap-1 py-1">
            {/* Quality Row */}
            {qualityLevels.length > 1 && (
              <button
                type="button"
                data-testid="settings-row-quality"
                onClick={() => setActiveView('quality')}
                className="flex items-center justify-between w-full min-h-11 px-3 py-2.5 rounded-xl hover:bg-white/10 transition cursor-pointer text-left"
              >
                <div className="flex items-center gap-3">
                  <Sliders className="h-4 w-4 text-zinc-300" />
                  <span className="text-sm font-medium">Chất lượng</span>
                </div>
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <span className="text-xs">{activeQualityLabel}</span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </button>
            )}

            {/* Subtitles Row */}
            {subtitles.length > 0 && (
              <button
                type="button"
                data-testid="settings-row-subtitles"
                onClick={() => setActiveView('subtitles')}
                className="flex items-center justify-between w-full min-h-11 px-3 py-2.5 rounded-xl hover:bg-white/10 transition cursor-pointer text-left"
              >
                <div className="flex items-center gap-3">
                  <Subtitles className="h-4 w-4 text-zinc-300" />
                  <span className="text-sm font-medium">Phụ đề</span>
                </div>
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <span className="text-xs">{activeSubtitleLabel}</span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </button>
            )}

            {/* Audio Row */}
            {audioTracks.length >= 2 && (
              <button
                type="button"
                data-testid="settings-row-audio"
                onClick={() => setActiveView('audio')}
                className="flex items-center justify-between w-full min-h-11 px-3 py-2.5 rounded-xl hover:bg-white/10 transition cursor-pointer text-left"
              >
                <div className="flex items-center gap-3">
                  <Headphones className="h-4 w-4 text-zinc-300" />
                  <span className="text-sm font-medium">Âm thanh</span>
                </div>
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <span className="text-xs">{activeAudioLabel}</span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </button>
            )}

            {qualityLevels.length <= 1 && subtitles.length === 0 && audioTracks.length < 2 && (
              <div className="py-6 text-center text-xs text-zinc-400">
                Không có cài đặt bổ sung cho video này.
              </div>
            )}
          </div>
        )}

        {/* Subtitles Selection View */}
        {activeView === 'subtitles' && (
          <div className="flex flex-col gap-1 py-1 max-h-72 overflow-y-auto">
            {/* Turn Off */}
            <button
              type="button"
              data-testid="settings-option-cc-off"
              onClick={() => {
                onSelectSubtitle(null);
                onClose();
              }}
              className={`flex items-center justify-between w-full min-h-11 px-3 py-2.5 rounded-xl transition cursor-pointer text-left ${
                selectedSubtitleLang === null || selectedSubtitleLang === ''
                  ? 'bg-white/10 font-bold text-white'
                  : 'hover:bg-white/5 text-zinc-300'
              }`}
            >
              <span className="text-sm">Tắt</span>
              {(selectedSubtitleLang === null || selectedSubtitleLang === '') && (
                <Check className="h-4 w-4 text-red-500" />
              )}
            </button>

            {/* Tracks */}
            {subtitles.map((track) => {
              const isSelected = selectedSubtitleLang === track.lang;
              return (
                <button
                  key={track.lang}
                  type="button"
                  data-testid={`settings-option-cc-${track.lang}`}
                  onClick={() => {
                    onSelectSubtitle(track.lang);
                    onClose();
                  }}
                  className={`flex items-center justify-between w-full min-h-11 px-3 py-2.5 rounded-xl transition cursor-pointer text-left ${
                    isSelected
                      ? 'bg-white/10 font-bold text-white'
                      : 'hover:bg-white/5 text-zinc-300'
                  }`}
                >
                  <span className="text-sm">{track.label}</span>
                  {isSelected && <Check className="h-4 w-4 text-red-500" />}
                </button>
              );
            })}
          </div>
        )}

        {/* Audio Selection View */}
        {activeView === 'audio' && (
          <div className="flex flex-col gap-1 py-1 max-h-72 overflow-y-auto">
            {audioTracks.map((track) => {
              const isSelected = selectedAudioIndex === track.index;
              return (
                <button
                  key={track.index}
                  type="button"
                  data-testid={`settings-option-audio-${track.index}`}
                  onClick={() => {
                    onSelectAudio(track);
                    onClose();
                  }}
                  className={`flex items-center justify-between w-full min-h-11 px-3 py-2.5 rounded-xl transition cursor-pointer text-left ${
                    isSelected
                      ? 'bg-white/10 font-bold text-white'
                      : 'hover:bg-white/5 text-zinc-300'
                  }`}
                >
                  <span className="text-sm">{track.label}</span>
                  {isSelected && <Check className="h-4 w-4 text-red-500" />}
                </button>
              );
            })}
          </div>
        )}

        {/* Quality Selection View */}
        {activeView === 'quality' && (
          <div className="flex flex-col gap-1 py-1 max-h-72 overflow-y-auto">
            {qualityLevels.map((lvl) => {
              const isSelected = currentLevel === lvl.index;
              return (
                <button
                  key={lvl.index}
                  type="button"
                  data-testid={`settings-option-quality-${lvl.index}`}
                  onClick={() => {
                    onSelectQuality(lvl.index);
                    onClose();
                  }}
                  className={`flex items-center justify-between w-full min-h-11 px-3 py-2.5 rounded-xl transition cursor-pointer text-left ${
                    isSelected
                      ? 'bg-white/10 font-bold text-white'
                      : 'hover:bg-white/5 text-zinc-300'
                  }`}
                >
                  <span className="text-sm">{lvl.label}</span>
                  {isSelected && <Check className="h-4 w-4 text-red-500" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
