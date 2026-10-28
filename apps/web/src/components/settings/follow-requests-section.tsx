'use client';

import React, { useState, useEffect } from 'react';
import { Check, X, UserPlus } from 'lucide-react';
import { Link } from '../../i18n/routing';
import { api } from '../../lib/api-client';
import type { PublicProfile } from '@winkey/api-client';

interface FollowRequestItem {
  requester: PublicProfile;
  requested_at: string;
}

export function FollowRequestsSection() {
  const [requests, setRequests] = useState<FollowRequestItem[]>([]);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadFollowRequests() {
      try {
        const res = await api.social.GET('/v1/me/follow-requests', {});
        if (res.response.ok && res.data && isMounted) {
          setRequests(res.data.items || []);
          setPendingCount(res.data.pending_count ?? (res.data.items?.length || 0));
        }
      } catch {
        // Ignored
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }
    void loadFollowRequests();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleDecision = async (userId: string, decision: 'APPROVE' | 'REJECT') => {
    setActionInProgress(userId);
    try {
      const res = await api.social.POST('/v1/me/follow-requests/{requester_id}/decision', {
        params: { path: { requester_id: userId } },
        body: { decision },
      });
      if (res.response.ok) {
        setRequests((prev) => prev.filter((r) => r.requester.id !== userId));
        setPendingCount((prev) => Math.max(0, prev - 1));
      }
    } catch {
      // Ignored
    } finally {
      setActionInProgress(null);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-[#272727] bg-white dark:bg-[#18181b] p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
            <UserPlus className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-zinc-900 dark:text-white">
                Yêu cầu theo dõi
              </h2>
              {pendingCount > 0 && (
                <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-red-600 text-white">
                  {pendingCount}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Những người dùng đang chờ bạn phê duyệt theo dõi tài khoản riêng tư của bạn.
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <div className="h-6 w-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : requests.length === 0 ? (
        <div className="py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
          Không có yêu cầu theo dõi nào đang chờ duyệt.
        </div>
      ) : (
        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {requests.map((req) => (
            <div
              key={req.requester.id}
              className="flex items-center justify-between py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 px-2 rounded-xl transition"
            >
              <Link href={`/c/${req.requester.handle}`} className="flex items-center gap-3 min-w-0">
                {req.requester.avatar_url ? (
                  <img
                    src={req.requester.avatar_url}
                    alt={req.requester.display_name}
                    className="w-10 h-10 rounded-full object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-red-600 font-bold text-white flex items-center justify-center text-sm shrink-0">
                    {req.requester.display_name.charAt(0)}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-white truncate hover:underline">
                    {req.requester.display_name}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    @{req.requester.handle}
                  </p>
                </div>
              </Link>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleDecision(req.requester.id, 'APPROVE')}
                  disabled={actionInProgress === req.requester.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg transition disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Chấp nhận</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDecision(req.requester.id, 'REJECT')}
                  disabled={actionInProgress === req.requester.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded-lg transition disabled:opacity-50"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Từ chối</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
