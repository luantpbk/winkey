'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, UserCheck, UserPlus } from 'lucide-react';
import { useRouter, usePathname } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
import { api } from '../../lib/api-client';
import { friendState } from '../../lib/social/friends';

export interface FriendRelation {
  following: boolean;
  follow_requested: boolean;
  followed_by: boolean;
}

interface FriendButtonProps {
  userId: string;
  displayName: string;
  /** null while the relationship is loading or for a signed-out viewer. */
  relation: FriendRelation | null;
  onRelationChange: (relation: FriendRelation) => void;
  onSubscriberCountChange?: (count: number) => void;
  className?: string;
}

/**
 * Profile button (SOC-6b): "Kết bạn" → "Đã gửi lời mời" → "Bạn bè" (menu: "Huỷ kết bạn"), or "Chấp nhận" when they
 * follow you. Kết bạn and Chấp nhận follow the user; Huỷ unfollows (or withdraws a request to a private account).
 */
export function FriendButton({
  userId,
  displayName,
  relation,
  onRelationChange,
  onSubscriberCountChange,
  className = '',
}: FriendButtonProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated } = useAuth();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const rel = relation ?? { following: false, follow_requested: false, followed_by: false };
  const state = friendState(rel);

  const follow = async () => {
    if (!isAuthenticated) {
      router.push(`/login?return_to=${encodeURIComponent(pathname)}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.social.PUT('/v1/channels/{channel_id}/subscription', {
        params: { path: { channel_id: userId } },
      });
      if (!data) throw new Error('failed');
      onRelationChange({
        ...rel,
        following: data.subscribed,
        follow_requested: Boolean(data.requested),
      });
      onSubscriberCountChange?.(data.subscriber_count);
    } catch {
      setError('Không gửi được lời mời. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  };

  const unfollow = async () => {
    setMenuOpen(false);
    setBusy(true);
    setError(null);
    try {
      const { data, response } = await api.social.DELETE('/v1/channels/{channel_id}/subscription', {
        params: { path: { channel_id: userId } },
      });
      if (!response.ok) throw new Error('failed');
      onRelationChange({ ...rel, following: false, follow_requested: false });
      if (data && typeof data.subscriber_count === 'number') {
        onSubscriberCountChange?.(data.subscriber_count);
      }
    } catch {
      setError('Thao tác thất bại. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  };

  const base =
    'inline-flex h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-60';
  const neutral =
    'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-white dark:hover:bg-zinc-700';
  const primary = 'bg-[#D9002B] text-white hover:bg-[#B80024]';
  const spinner = <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;

  let button: React.ReactNode;
  if (state === 'friends' || state === 'sent') {
    const label = state === 'friends' ? 'Bạn bè' : 'Đã gửi lời mời';
    button = (
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={`${base} ${neutral} ${className}`}
        >
          {busy ? (
            spinner
          ) : state === 'friends' ? (
            <UserCheck className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Check className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{label}</span>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-1 w-48 rounded-xl border border-zinc-200 bg-white p-1 text-sm shadow-xl dark:border-zinc-800 dark:bg-[#1f1f23]"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => void unfollow()}
              className="w-full rounded-lg px-3 py-2 text-left text-red-600 hover:bg-zinc-100 dark:text-red-400 dark:hover:bg-zinc-800"
            >
              {state === 'friends' ? 'Huỷ kết bạn' : 'Huỷ lời mời'}
            </button>
          </div>
        )}
      </div>
    );
  } else {
    const label = state === 'incoming' ? 'Chấp nhận' : 'Kết bạn';
    button = (
      <button
        type="button"
        onClick={() => void follow()}
        disabled={busy}
        aria-label={
          state === 'incoming'
            ? `Chấp nhận lời mời kết bạn của ${displayName}`
            : `Kết bạn với ${displayName}`
        }
        className={`${base} ${primary} ${className}`}
      >
        {busy ? spinner : <UserPlus className="h-4 w-4" aria-hidden="true" />}
        <span>{label}</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {button}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
