'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { X, Search } from 'lucide-react';
import type { SocialComponents } from '@winkey/api-client';
import { api } from '../../lib/api-client';

export type PickedUser = SocialComponents['schemas']['PeoplePage']['items'][number];

const DEBOUNCE_MS = 250;
const PAGE_SIZE = 8;

interface UserPickerProps {
  /** Selected users, in order. */
  value: PickedUser[];
  onChange: (users: PickedUser[]) => void;
  /** 1 = pick one user (the input is replaced by the chip); more = chips + input. */
  max: number;
  label: string;
  placeholder?: string;
  /** Shown before typing (and when nothing matches the query), e.g. friends first (SOC-6b). */
  suggestions?: PickedUser[];
  disabled?: boolean;
  /** Optional id for the input, so an outer label or error can point at it. */
  inputId?: string;
}

export function Avatar({ user, size = 32 }: { user: PickedUser; size?: number }) {
  const style = { width: size, height: size };
  return user.avatar_url ? (
    <img
      src={user.avatar_url}
      alt=""
      style={style}
      className="rounded-full object-cover shrink-0"
    />
  ) : (
    <span
      aria-hidden="true"
      style={style}
      className="rounded-full bg-red-600 font-bold text-white flex items-center justify-center text-xs shrink-0"
    >
      {user.display_name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Finds people with `searchPeople` (SOC-6a). WAI-ARIA combobox: ↑/↓ move, Enter picks, Escape closes,
 * Backspace on an empty input removes the last chip.
 */
export function UserPicker({
  value,
  onChange,
  max,
  label,
  placeholder = 'Tìm theo tên hoặc @tên_người_dùng',
  suggestions = [],
  disabled = false,
  inputId,
}: UserPickerProps) {
  const autoId = useId();
  const id = inputId ?? `user-picker-${autoId}`;
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedIds = new Set(value.map((u) => u.id));
  const trimmed = query.trim().replace(/^@/, '').trim();
  const pool = trimmed ? results : suggestions;
  const options = pool.filter((u) => !selectedIds.has(u.id));
  const full = value.length >= max;

  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const { data, response } = await api.social.GET('/v1/people/search', {
          params: { query: { q: trimmed.slice(0, 64), limit: PAGE_SIZE } },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (data) {
          setResults(data.items);
          setError(null);
        } else {
          setResults([]);
          setError(
            response.status === 429
              ? 'Bạn tìm quá nhanh, vui lòng thử lại sau ít phút.'
              : 'Không tìm được người dùng. Vui lòng thử lại.',
          );
        }
        setActive(0);
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setError('Không tìm được người dùng. Vui lòng thử lại.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  const pick = (user: PickedUser) => {
    if (selectedIds.has(user.id) || full) return;
    onChange(max === 1 ? [user] : [...value, user]);
    setQuery('');
    setActive(0);
    setOpen(max !== 1 && value.length + 1 < max);
    if (max !== 1) inputRef.current?.focus();
  };

  const remove = (userId: string) => {
    onChange(value.filter((u) => u.id !== userId));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (options.length ? (i + 1) % options.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (options.length ? (i - 1 + options.length) % options.length : 0));
    } else if (e.key === 'Enter') {
      if (open && options[active]) {
        e.preventDefault();
        pick(options[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    } else if (e.key === 'Backspace' && !query && value.length > 0) {
      remove(value[value.length - 1]!.id);
    }
  };

  const showList = open && !full && (options.length > 0 || (trimmed !== '' && !loading));
  const activeOption = showList ? options[active] : undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </label>

      <div className="relative">
        <div className="flex flex-wrap items-center gap-1.5 w-full px-2.5 py-2 rounded-xl border border-zinc-200 dark:border-[#2c2c2c] bg-zinc-50 dark:bg-[#121212] focus-within:ring-2 focus-within:ring-red-500">
          {value.map((u) => (
            <span
              key={u.id}
              className="inline-flex items-center gap-1.5 max-w-full rounded-full bg-white dark:bg-[#202020] border border-zinc-200 dark:border-[#2c2c2c] pl-1 pr-1.5 py-0.5 text-xs text-zinc-900 dark:text-white"
            >
              <Avatar user={u} size={20} />
              <span className="truncate">{u.display_name}</span>
              <button
                type="button"
                onClick={() => remove(u.id)}
                disabled={disabled}
                aria-label={`Bỏ chọn ${u.display_name}`}
                className="inline-flex items-center justify-center rounded-full p-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}

          {!full && (
            <div className="flex items-center gap-1.5 flex-1 min-w-[10rem]">
              <Search className="h-4 w-4 text-zinc-400 shrink-0" aria-hidden="true" />
              <input
                ref={inputRef}
                id={id}
                type="text"
                role="combobox"
                aria-expanded={showList}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
                aria-describedby={hintId}
                data-embedded-field=""
                autoComplete="off"
                spellCheck={false}
                maxLength={65}
                disabled={disabled}
                placeholder={placeholder}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => window.setTimeout(() => setOpen(false), 150)}
                onKeyDown={onKeyDown}
                className="flex-1 min-w-0 bg-transparent py-0.5 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-500 dark:placeholder:text-zinc-400 focus:outline-none"
              />
              {loading && (
                <span
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-red-500 border-t-transparent shrink-0"
                  aria-hidden="true"
                />
              )}
            </div>
          )}
        </div>

        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          hidden={!showList}
          className="absolute z-10 mt-1 w-full max-h-64 overflow-y-auto rounded-xl border border-zinc-200 dark:border-[#2c2c2c] bg-white dark:bg-[#181818] shadow-xl py-1"
        >
          {options.map((u, i) => (
            <li
              key={u.id}
              id={`${listId}-${u.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(u)}
              onMouseEnter={() => setActive(i)}
              className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer ${
                i === active ? 'bg-zinc-100 dark:bg-[#262626]' : ''
              }`}
            >
              <Avatar user={u} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-900 dark:text-white truncate">
                  {u.display_name}
                </span>
                <span className="block text-xs text-zinc-600 dark:text-zinc-400 truncate">
                  @{u.handle}
                </span>
              </span>
            </li>
          ))}
          {options.length === 0 && trimmed !== '' && !loading && (
            <li role="presentation" className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
              {error ?? `Không tìm thấy ai khớp với “${trimmed}”.`}
            </li>
          )}
        </ul>
      </div>

      <p id={hintId} className="text-[11px] text-zinc-600 dark:text-zinc-400" aria-live="polite">
        {max > 1
          ? `Đã chọn ${value.length}/${max} người.`
          : value.length === 1
            ? 'Đã chọn 1 người.'
            : 'Gõ tên hoặc @tên_người_dùng, dùng ↑ ↓ để chọn, Enter để xác nhận.'}
      </p>
    </div>
  );
}
