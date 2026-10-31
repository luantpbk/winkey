'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, MessageCircle, Search, UserCheck, UserPlus, Users } from 'lucide-react';
import { Link, useRouter } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
import { api } from '../../lib/api-client';
import { Avatar, type PickedUser } from './user-picker';
import { FriendButton, type FriendRelation } from './friend-button';

type Tab = 'ban-be' | 'loi-moi' | 'tim-ban';

const TABS: { id: Tab; label: string }[] = [
  { id: 'ban-be', label: 'Bạn bè' },
  { id: 'loi-moi', label: 'Lời mời' },
  { id: 'tim-ban', label: 'Tìm bạn' },
];

const rowClass =
  'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-zinc-200 bg-white px-4 py-3 dark:border-[#272727] dark:bg-[#181818]';
const smallBtn =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-60';

function Person({ user, children }: { user: PickedUser; children?: React.ReactNode }) {
  return (
    <li className={rowClass}>
      <Link
        href={`/c/${user.handle}`}
        className="flex min-w-[12rem] flex-1 items-center gap-3 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
      >
        <Avatar user={user} size={44} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-white">
            {user.display_name}
          </span>
          <span className="block truncate text-xs text-zinc-600 dark:text-zinc-400">
            @{user.handle}
          </span>
        </span>
      </Link>
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </li>
  );
}

function Empty({ icon: Icon, text }: { icon: typeof Users; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-zinc-600 dark:text-zinc-400">
      <Icon className="h-8 w-8 text-zinc-400" aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function FriendsTab() {
  const [items, setItems] = useState<{ user: PickedUser; friends_since: string }[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [more, setMore] = useState(false);

  const load = useCallback(async (after?: string) => {
    const { data } = await api.social.GET('/v1/me/friends', {
      params: { query: { limit: 24, ...(after ? { cursor: after } : {}) } },
    });
    if (!data) throw new Error('failed');
    setItems((prev) => (after ? [...prev, ...data.items] : data.items));
    setCursor(data.next_cursor);
  }, []);

  useEffect(() => {
    load()
      .then(() => setState('ready'))
      .catch(() => setState('error'));
  }, [load]);

  const unfriend = async (user: PickedUser) => {
    if (!window.confirm(`Huỷ kết bạn với ${user.display_name}? Bạn sẽ bỏ theo dõi người này.`))
      return;
    const { response } = await api.social.DELETE('/v1/channels/{channel_id}/subscription', {
      params: { path: { channel_id: user.id } },
    });
    if (response.ok) setItems((prev) => prev.filter((f) => f.user.id !== user.id));
  };

  if (state === 'loading')
    return (
      <Loader2 className="mx-auto my-12 h-6 w-6 animate-spin text-zinc-400" aria-label="Đang tải" />
    );
  if (state === 'error')
    return (
      <p role="alert" className="py-12 text-center text-sm text-red-600 dark:text-red-400">
        Không tải được danh sách bạn bè.
      </p>
    );
  if (items.length === 0) {
    return (
      <Empty
        icon={Users}
        text="Chưa có bạn bè. Khi hai người theo dõi nhau, các bạn sẽ là bạn bè."
      />
    );
  }
  return (
    <>
      <ul className="space-y-2">
        {items.map(({ user }) => (
          <Person key={user.id} user={user}>
            <Link
              href={`/tin-nhan?to=${user.id}`}
              aria-label={`Nhắn tin cho ${user.display_name}`}
              className={`${smallBtn} bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-white dark:hover:bg-zinc-700`}
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Nhắn tin</span>
            </Link>
            <button
              type="button"
              onClick={() => void unfriend(user)}
              aria-label={`Huỷ kết bạn với ${user.display_name}`}
              className={`${smallBtn} text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800`}
            >
              Huỷ kết bạn
            </button>
          </Person>
        ))}
      </ul>
      {cursor && (
        <button
          type="button"
          disabled={more}
          onClick={() => {
            setMore(true);
            void load(cursor).finally(() => setMore(false));
          }}
          className="mx-auto mt-4 block rounded-full px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
        >
          {more ? 'Đang tải…' : 'Xem thêm'}
        </button>
      )}
    </>
  );
}

function RequestsTab({ onCount }: { onCount: (n: number) => void }) {
  const [items, setItems] = useState<{ user: PickedUser; followed_at: string }[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      const { data } = await api.social.GET('/v1/me/friend-requests', {
        params: { query: { limit: 24, ...(after ? { cursor: after } : {}) } },
      });
      if (!data) throw new Error('failed');
      setItems((prev) => (after ? [...prev, ...data.items] : data.items));
      setCursor(data.next_cursor);
      setCount(data.pending_count);
      onCount(data.pending_count);
    },
    [onCount],
  );

  useEffect(() => {
    load()
      .then(() => setState('ready'))
      .catch(() => setState('error'));
  }, [load]);

  const done = (user: PickedUser, message: string) => {
    setItems((prev) => prev.filter((r) => r.user.id !== user.id));
    setCount((c) => {
      onCount(Math.max(0, c - 1));
      return Math.max(0, c - 1);
    });
    setNotice(message);
  };

  const accept = async (user: PickedUser) => {
    setBusy(user.id);
    try {
      const { data } = await api.social.PUT('/v1/channels/{channel_id}/subscription', {
        params: { path: { channel_id: user.id } },
      });
      if (!data) throw new Error('failed');
      done(
        user,
        data.subscribed
          ? `Bạn và ${user.display_name} đã là bạn bè.`
          : `Đã gửi yêu cầu theo dõi tới ${user.display_name} (tài khoản riêng tư).`,
      );
    } catch {
      setNotice('Không chấp nhận được lời mời. Vui lòng thử lại.');
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (user: PickedUser) => {
    setBusy(user.id);
    try {
      const { response } = await api.social.POST('/v1/me/friend-requests/{user_id}/dismiss', {
        params: { path: { user_id: user.id } },
      });
      if (!response.ok && response.status !== 404) throw new Error('failed');
      done(user, `Đã xoá lời mời của ${user.display_name}. Người này không nhận được thông báo.`);
    } catch {
      setNotice('Không xoá được lời mời. Vui lòng thử lại.');
    } finally {
      setBusy(null);
    }
  };

  if (state === 'loading')
    return (
      <Loader2 className="mx-auto my-12 h-6 w-6 animate-spin text-zinc-400" aria-label="Đang tải" />
    );
  if (state === 'error')
    return (
      <p role="alert" className="py-12 text-center text-sm text-red-600 dark:text-red-400">
        Không tải được lời mời kết bạn.
      </p>
    );
  return (
    <>
      <p
        aria-live="polite"
        className="mb-3 min-h-[1.25rem] text-sm text-zinc-700 dark:text-zinc-300"
      >
        {notice ?? (count > 0 ? `${count} lời mời kết bạn` : '')}
      </p>
      {items.length === 0 ? (
        <Empty icon={UserPlus} text="Không có lời mời kết bạn nào." />
      ) : (
        <ul className="space-y-2">
          {items.map(({ user }) => (
            <Person key={user.id} user={user}>
              <button
                type="button"
                disabled={busy === user.id}
                onClick={() => void accept(user)}
                aria-label={`Chấp nhận lời mời kết bạn của ${user.display_name}`}
                className={`${smallBtn} bg-[#D9002B] text-white hover:bg-[#B80024]`}
              >
                <UserCheck className="h-4 w-4" aria-hidden="true" />
                Chấp nhận
              </button>
              <button
                type="button"
                disabled={busy === user.id}
                onClick={() => void dismiss(user)}
                aria-label={`Xoá lời mời kết bạn của ${user.display_name}`}
                className={`${smallBtn} bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-white dark:hover:bg-zinc-700`}
              >
                Xoá
              </button>
            </Person>
          ))}
        </ul>
      )}
      {cursor && (
        <button
          type="button"
          onClick={() => void load(cursor)}
          className="mx-auto mt-4 block rounded-full px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
        >
          Xem thêm
        </button>
      )}
    </>
  );
}

function SearchRow({ user }: { user: PickedUser }) {
  const [relation, setRelation] = useState<FriendRelation | null>(null);
  useEffect(() => {
    let live = true;
    void api.social
      .GET('/v1/channels/{channel_id}/relationship', { params: { path: { channel_id: user.id } } })
      .then(({ data }) => {
        if (data && live) setRelation(data);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [user.id]);
  return (
    <Person user={user}>
      <FriendButton
        userId={user.id}
        displayName={user.display_name}
        relation={relation}
        onRelationChange={(r) => setRelation((prev) => ({ ...(prev ?? r), ...r }))}
        className="!h-9 !px-4 !text-xs"
      />
    </Person>
  );
}

function SearchTab() {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedUser[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setState('idle');
      return;
    }
    const controller = new AbortController();
    setState('loading');
    const timer = window.setTimeout(async () => {
      try {
        const { data, response } = await api.social.GET('/v1/people/search', {
          params: { query: { q: q.slice(0, 64), limit: 20 } },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!data) throw new Error(String(response.status));
        setResults(data.items);
        setState('ready');
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="space-y-3">
      <label htmlFor={inputId} className="sr-only">
        Tìm người dùng
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          data-embedded-field
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tìm theo tên hoặc @tên_người_dùng"
          className="w-full rounded-xl border border-zinc-200 bg-white py-2.5 pl-9 pr-3 text-sm text-zinc-900 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-red-500 dark:border-[#2c2c2c] dark:bg-[#121212] dark:text-white"
        />
      </div>
      {state === 'loading' && (
        <Loader2
          className="mx-auto my-6 h-5 w-5 animate-spin text-zinc-400"
          aria-label="Đang tìm"
        />
      )}
      {state === 'error' && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Không tìm được, vui lòng thử lại.
        </p>
      )}
      {state === 'ready' && results.length === 0 && (
        <Empty icon={Search} text="Không tìm thấy ai phù hợp." />
      )}
      {state === 'idle' && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Nhập ít nhất 2 ký tự để tìm.</p>
      )}
      {results.length > 0 && (
        <ul className="space-y-2" aria-label="Kết quả tìm kiếm">
          {results.map((u) => (
            <SearchRow key={u.id} user={u} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** /ban-be (SOC-6b): friends, friend requests (accept = follow back, dismiss), and people search (SOC-6a). */
export function FriendsView({ initialTab = 'ban-be' }: { initialTab?: string }) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(
    TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : 'ban-be',
  );
  const [pending, setPending] = useState<number | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    'ban-be': null,
    'loi-moi': null,
    'tim-ban': null,
  });
  const baseId = useId();
  const tabRef = (id: Tab) => (el: HTMLButtonElement | null) => {
    tabRefs.current[id] = el;
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    void api.social
      .GET('/v1/me/friend-requests', { params: { query: { limit: 1 } } })
      .then(({ data }) => {
        if (data) setPending(data.pending_count);
      })
      .catch(() => {});
  }, [isAuthenticated]);

  const select = (next: Tab) => {
    setTab(next);
    router.replace(next === 'ban-be' ? '/ban-be' : `/ban-be?tab=${next}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(i + step + TABS.length) % TABS.length]!.id;
    select(next);
    tabRefs.current[next]?.focus();
  };

  if (isLoading)
    return (
      <Loader2 className="mx-auto my-16 h-6 w-6 animate-spin text-zinc-400" aria-label="Đang tải" />
    );
  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <Users className="mx-auto h-10 w-10 text-zinc-400" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-bold text-zinc-900 dark:text-white">Bạn bè</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Đăng nhập để xem bạn bè và lời mời kết bạn.
        </p>
        <Link
          href={`/login?return_to=${encodeURIComponent('/ban-be')}`}
          className="mt-4 inline-flex rounded-full bg-[#D9002B] px-5 py-2 text-sm font-semibold text-white hover:bg-[#B80024]"
        >
          Đăng nhập
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="mb-4 text-xl font-bold text-zinc-900 dark:text-white">Bạn bè</h1>
      <div
        role="tablist"
        aria-label="Bạn bè"
        onKeyDown={onKeyDown}
        className="mb-4 flex gap-1 rounded-xl border border-zinc-200 p-1 dark:border-[#272727]"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={tabRef(t.id)}
            id={`${baseId}-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${baseId}-${t.id}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => select(t.id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
              tab === t.id
                ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            {t.label}
            {t.id === 'loi-moi' && pending ? (
              <span
                aria-label={`${pending} lời mời`}
                className="rounded-full bg-[#D9002B] px-1.5 text-[11px] font-bold leading-5 text-white"
              >
                {pending > 99 ? '99+' : pending}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-${tab}-panel`} aria-labelledby={`${baseId}-${tab}`}>
        {tab === 'ban-be' && <FriendsTab />}
        {tab === 'loi-moi' && <RequestsTab onCount={setPending} />}
        {tab === 'tim-ban' && <SearchTab />}
      </div>
    </div>
  );
}
