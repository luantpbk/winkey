'use client';

import React, { useEffect, useRef } from 'react';

/** A short list that covers everyday chat, with no dependency and no network: emoji come from the system font. */
export const EMOJIS: { char: string; name: string }[] = [
  { char: '😀', name: 'Cười tươi' },
  { char: '😂', name: 'Cười ra nước mắt' },
  { char: '🤣', name: 'Cười lăn lộn' },
  { char: '😊', name: 'Mỉm cười' },
  { char: '😍', name: 'Mắt trái tim' },
  { char: '🥰', name: 'Yêu thương' },
  { char: '😘', name: 'Hôn gió' },
  { char: '😉', name: 'Nháy mắt' },
  { char: '😎', name: 'Đeo kính râm' },
  { char: '🤔', name: 'Suy nghĩ' },
  { char: '😅', name: 'Cười ngượng' },
  { char: '😴', name: 'Ngủ' },
  { char: '😢', name: 'Khóc' },
  { char: '😭', name: 'Khóc to' },
  { char: '😡', name: 'Tức giận' },
  { char: '😱', name: 'Hoảng hốt' },
  { char: '🥳', name: 'Tiệc tùng' },
  { char: '🤗', name: 'Ôm' },
  { char: '🙄', name: 'Đảo mắt' },
  { char: '😐', name: 'Không cảm xúc' },
  { char: '🥺', name: 'Năn nỉ' },
  { char: '😋', name: 'Ngon miệng' },
  { char: '🤤', name: 'Thèm' },
  { char: '🤯', name: 'Nổ não' },
  { char: '👍', name: 'Đồng ý' },
  { char: '👎', name: 'Không đồng ý' },
  { char: '👏', name: 'Vỗ tay' },
  { char: '🙏', name: 'Cảm ơn' },
  { char: '👌', name: 'Ổn' },
  { char: '✌️', name: 'Chiến thắng' },
  { char: '🤝', name: 'Bắt tay' },
  { char: '💪', name: 'Cố lên' },
  { char: '❤️', name: 'Trái tim đỏ' },
  { char: '💔', name: 'Trái tim vỡ' },
  { char: '💯', name: 'Một trăm điểm' },
  { char: '🔥', name: 'Lửa' },
  { char: '✨', name: 'Lấp lánh' },
  { char: '🎉', name: 'Chúc mừng' },
  { char: '🎁', name: 'Quà' },
  { char: '🎂', name: 'Bánh sinh nhật' },
  { char: '🎬', name: 'Phim' },
  { char: '🎵', name: 'Âm nhạc' },
  { char: '📷', name: 'Máy ảnh' },
  { char: '⚽', name: 'Bóng đá' },
  { char: '🍜', name: 'Phở' },
  { char: '🍚', name: 'Cơm' },
  { char: '☕', name: 'Cà phê' },
  { char: '🍻', name: 'Cụng ly' },
  { char: '🌸', name: 'Hoa' },
  { char: '☀️', name: 'Nắng' },
  { char: '🌧️', name: 'Mưa' },
  { char: '🐶', name: 'Chó' },
  { char: '🐱', name: 'Mèo' },
  { char: '🇻🇳', name: 'Cờ Việt Nam' },
  { char: '✅', name: 'Xong' },
  { char: '❌', name: 'Không' },
];

const COLUMNS = 8;

/** A popover of emoji buttons: one tab stop, arrows move, Enter or a click picks, Escape closes. */
export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (char: string) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Only when it opens: a re-render of the conversation must not pull the focus back.
  useEffect(() => {
    rootRef.current?.querySelector('button')?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (rootRef.current?.contains(target)) return;
      if (target?.closest?.('[data-emoji-trigger]')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      ArrowDown: index + COLUMNS,
      ArrowUp: index - COLUMNS,
      Home: 0,
      End: EMOJIS.length - 1,
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    if (next < 0 || next >= EMOJIS.length) return;
    rootRef.current?.querySelectorAll('button')[next]?.focus();
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Chọn emoji"
      className="absolute bottom-full left-0 z-20 mb-2 w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-[#1c1c1c]"
    >
      <div className="grid grid-cols-8 gap-0.5">
        {EMOJIS.map((emoji, index) => (
          <button
            key={emoji.char}
            type="button"
            tabIndex={index === 0 ? 0 : -1}
            aria-label={emoji.name}
            title={emoji.name}
            onClick={() => onPick(emoji.char)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className="flex h-9 w-full items-center justify-center rounded-lg text-xl hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:bg-zinc-800"
          >
            {emoji.char}
          </button>
        ))}
      </div>
    </div>
  );
}
