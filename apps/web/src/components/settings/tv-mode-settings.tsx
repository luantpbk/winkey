'use client';

import React from 'react';
import { Tv } from 'lucide-react';
import { useTvMode } from '../../lib/tv-mode';

export function TvModeSettings() {
  const { isTvMode, toggleTvMode } = useTvMode();

  return (
    <section
      aria-labelledby="tv-mode-heading"
      className="rounded-2xl border border-zinc-200 dark:border-[#272727] bg-white dark:bg-[#141414] p-6 shadow-sm transition-colors"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
            <Tv className="h-5 w-5" />
          </div>
          <div>
            <h2
              id="tv-mode-heading"
              className="text-base font-semibold text-zinc-900 dark:text-white"
            >
              Chế độ TV (TV Navigation)
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-xl leading-relaxed">
              Bật tính năng điều hướng không gian 2D bằng phím mũi tên và viền chọn nổi bật cho TV
              Box hoặc điều khiển từ xa (Remote / D-Pad). Mặc định tự động nhận diện thiết bị TV.
            </p>
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={isTvMode}
          aria-label="Bật hoặc tắt chế độ TV"
          onClick={toggleTvMode}
          className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2 self-start sm:self-center ${
            isTvMode ? 'bg-red-600' : 'bg-zinc-300 dark:bg-zinc-700'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              isTvMode ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
    </section>
  );
}
