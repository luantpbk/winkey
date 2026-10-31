'use client';

import React, { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../../lib/api-client';
import { Avatar, type PickedUser } from './user-picker';

const DEBOUNCE_MS = 200;
// "@" at the start or after a character that cannot end a handle, then a partial handle, right before the caret.
const MENTION_BEFORE_CARET = /(?:^|[^A-Za-z0-9_.@])@([A-Za-z0-9_.]{1,30})$/;

/** The partial `@handle` that ends at `caret`, or null. Exported for tests. */
export function findMentionToken(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const match = MENTION_BEFORE_CARET.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1]!;
  return { start: caret - query.length - 1, query };
}

type MentionTextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange'
> & {
  value: string;
  onValueChange: (value: string) => void;
};

/**
 * A textarea that suggests people while an `@handle` is being typed (SOC-6a, `searchPeople`). ↑/↓ move, Enter or
 * Tab inserts `@handle `, Escape closes. The post keeps plain text: social-svc parses mentions itself. Stays a plain
 * (multi-line) textbox for assistive tech; aria-autocomplete + aria-activedescendant expose the suggestions.
 */
export const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(
  function MentionTextarea({ value, onValueChange, onKeyDown, onBlur, ...props }, ref) {
    const innerRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => innerRef.current!);
    const listId = `mention-list-${useId()}`;
    const [token, setToken] = useState<{ start: number; query: string } | null>(null);
    const [options, setOptions] = useState<PickedUser[]>([]);
    const [active, setActive] = useState(0);

    const updateToken = (text: string, caret: number | null) => {
      setToken(caret === null ? null : findMentionToken(text, caret));
    };

    useEffect(() => {
      if (!token) {
        setOptions([]);
        return;
      }
      const controller = new AbortController();
      const timer = window.setTimeout(async () => {
        try {
          const { data } = await api.social.GET('/v1/people/search', {
            params: { query: { q: token.query, limit: 6 } },
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            setOptions(data?.items ?? []);
            setActive(0);
          }
        } catch {
          if (!controller.signal.aborted) setOptions([]);
        }
      }, DEBOUNCE_MS);
      return () => {
        controller.abort();
        window.clearTimeout(timer);
      };
    }, [token?.query, token?.start]);

    const open = token !== null && options.length > 0;

    const insert = (user: PickedUser) => {
      if (!token) return;
      const end = token.start + 1 + token.query.length;
      const next = `${value.slice(0, token.start)}@${user.handle} ${value.slice(end)}`;
      const caret = token.start + user.handle.length + 2;
      onValueChange(next);
      setToken(null);
      setOptions([]);
      window.requestAnimationFrame(() => {
        innerRef.current?.focus();
        innerRef.current?.setSelectionRange(caret, caret);
      });
    };

    return (
      <div className="relative">
        <textarea
          {...props}
          ref={innerRef}
          value={value}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            open && options[active] ? `${listId}-${options[active].id}` : undefined
          }
          onChange={(e) => {
            onValueChange(e.target.value);
            updateToken(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => updateToken(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={(e) => {
            window.setTimeout(() => setToken(null), 150);
            onBlur?.(e);
          }}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setActive((i) => (i + step + options.length) % options.length);
                return;
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && options[active]) {
                e.preventDefault();
                insert(options[active]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setToken(null);
                return;
              }
            }
            onKeyDown?.(e);
          }}
        />
        <ul
          id={listId}
          role="listbox"
          aria-label="Gợi ý nhắc tên"
          hidden={!open}
          className="absolute z-20 left-0 mt-1 w-72 max-w-full rounded-xl border border-zinc-200 dark:border-[#2c2c2c] bg-white dark:bg-[#181818] shadow-xl py-1"
        >
          {options.map((u, i) => (
            <li
              key={u.id}
              id={`${listId}-${u.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(u)}
              onMouseEnter={() => setActive(i)}
              className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer ${
                i === active ? 'bg-zinc-100 dark:bg-[#262626]' : ''
              }`}
            >
              <Avatar user={u} size={28} />
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
        </ul>
      </div>
    );
  },
);
