'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  Clock,
  Filter,
  History,
  RotateCw,
  Search,
  Shield,
  UserCheck,
  UserX,
  X,
} from 'lucide-react';
import type { AuditEntry } from '@winkey/api-client';
import { api } from '../../lib/api-client';

export function AuditLogViewer() {
  const t = useTranslations('admin.audit');

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Target User ID Filter
  const [targetUserIdFilter, setTargetUserIdFilter] = useState<string>('');
  const [appliedTargetFilter, setAppliedTargetFilter] = useState<string>('');

  const fetchAuditLogs = useCallback(
    async (cursor?: string | null, append = false) => {
      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
        const queryParams: {
          target_user_id?: string;
          cursor?: string;
          limit?: number;
        } = {
          limit: 20,
        };

        if (appliedTargetFilter.trim()) {
          queryParams.target_user_id = appliedTargetFilter.trim();
        }
        if (cursor) {
          queryParams.cursor = cursor;
        }

        const { data, error: apiError } = await api.auth.GET('/v1/admin/audit-log', {
          params: { query: queryParams },
        });

        if (apiError || !data) {
          setError('Failed to fetch audit log.');
        } else {
          setEntries((prev) => (append ? [...prev, ...data.items] : data.items));
          setNextCursor(data.next_cursor);
        }
      } catch {
        setError('Network error loading audit logs.');
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [appliedTargetFilter],
  );

  useEffect(() => {
    fetchAuditLogs();
  }, [fetchAuditLogs]);

  const handleApplyFilter = (e: React.FormEvent) => {
    e.preventDefault();
    setAppliedTargetFilter(targetUserIdFilter.trim());
  };

  const handleClearFilter = () => {
    setTargetUserIdFilter('');
    setAppliedTargetFilter('');
  };

  const getActionBadge = (action: AuditEntry['action']) => {
    switch (action) {
      case 'USER_ROLES_CHANGED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/30">
            <Shield className="h-3 w-3" />
            <span>{t('rolesChanged')}</span>
          </span>
        );
      case 'USER_SUSPENDED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/30">
            <UserX className="h-3 w-3" />
            <span>{t('suspended')}</span>
          </span>
        );
      case 'USER_UNSUSPENDED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-500/10 text-green-400 border border-green-500/30">
            <UserCheck className="h-3 w-3" />
            <span>{t('unsuspended')}</span>
          </span>
        );
    }
  };

  const renderDetails = (entry: AuditEntry) => {
    const details = entry.details as Record<string, unknown>;
    if (!details) return null;

    if (entry.action === 'USER_ROLES_CHANGED') {
      const fromRoles = Array.isArray(details.from) ? details.from.join(', ') : 'none';
      const toRoles = Array.isArray(details.to) ? details.to.join(', ') : 'none';
      return (
        <span className="text-xs text-gray-300">
          {t('rolesFromTo', { from: fromRoles, to: toRoles })}
        </span>
      );
    }

    if (entry.action === 'USER_SUSPENDED') {
      const reason = typeof details.reason === 'string' ? details.reason : '';
      const until =
        typeof details.until === 'string' && details.until
          ? new Date(details.until).toLocaleString()
          : 'Indefinite';

      return (
        <div className="space-y-0.5 text-xs text-gray-300">
          {reason && <div>{t('reason', { reason })}</div>}
          <div className="text-gray-400 text-[11px]">{t('until', { until })}</div>
        </div>
      );
    }

    return (
      <pre className="text-[11px] text-gray-400 font-mono bg-[#1c1c1c] p-1.5 rounded">
        {JSON.stringify(details)}
      </pre>
    );
  };

  return (
    <div className="space-y-6">
      {/* Search and Filters Bar */}
      <div className="bg-[#1f1f1f] border border-[#2e2e2e] p-4 rounded-2xl">
        <form
          onSubmit={handleApplyFilter}
          className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
        >
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={targetUserIdFilter}
              onChange={(e) => setTargetUserIdFilter(e.target.value)}
              placeholder={t('filterPlaceholder')}
              className="w-full pl-10 pr-4 py-2 bg-[#292929] border border-[#3a3a3a] rounded-xl text-xs text-white placeholder-gray-500 focus:outline-none focus:border-red-500 transition"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold shadow-sm transition"
            >
              <Filter className="h-3.5 w-3.5" />
              <span>Filter</span>
            </button>

            {appliedTargetFilter && (
              <button
                type="button"
                onClick={handleClearFilter}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#292929] hover:bg-[#333] border border-[#3a3a3a] text-gray-300 text-xs font-semibold transition"
              >
                <X className="h-3.5 w-3.5" />
                <span>{t('clearFilter')}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => fetchAuditLogs()}
              className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white bg-[#292929] hover:bg-[#333] border border-[#3a3a3a] px-3 py-2 rounded-xl transition ml-auto"
            >
              <RotateCw className="h-3.5 w-3.5" />
              <span>Refresh</span>
            </button>
          </div>
        </form>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Audit Log Table */}
      {isLoading ? (
        <div className="flex justify-center items-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
        </div>
      ) : entries.length === 0 ? (
        <div className="bg-[#181818] border border-[#292929] rounded-2xl p-12 text-center">
          <History className="h-10 w-10 text-gray-500 mx-auto mb-3" />
          <p className="text-sm font-semibold text-gray-300">{t('empty')}</p>
        </div>
      ) : (
        <div className="bg-[#181818] border border-[#292929] rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#222] border-b border-[#2e2e2e] text-gray-400 uppercase font-semibold">
                <tr>
                  <th className="py-3 px-4">{t('tableTime')}</th>
                  <th className="py-3 px-4">{t('tableActor')}</th>
                  <th className="py-3 px-4">{t('tableAction')}</th>
                  <th className="py-3 px-4">{t('tableTarget')}</th>
                  <th className="py-3 px-4">{t('tableDetails')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#262626]">
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-[#1f1f1f]/50 transition">
                    {/* Timestamp */}
                    <td className="py-3.5 px-4 text-gray-400 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3 w-3 text-gray-500" />
                        <span>{new Date(entry.created_at).toLocaleString()}</span>
                      </div>
                    </td>

                    {/* Actor */}
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-white">{entry.actor.display_name}</div>
                      <div className="text-[11px] text-gray-400">@{entry.actor.handle}</div>
                    </td>

                    {/* Action */}
                    <td className="py-3.5 px-4">{getActionBadge(entry.action)}</td>

                    {/* Target User */}
                    <td className="py-3.5 px-4 font-mono text-[11px] text-gray-400">
                      {entry.target_user_id}
                    </td>

                    {/* Details */}
                    <td className="py-3.5 px-4">{renderDetails(entry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {nextCursor && (
            <div className="flex justify-center p-4 border-t border-[#292929]">
              <button
                onClick={() => fetchAuditLogs(nextCursor, true)}
                disabled={isLoadingMore}
                className="px-6 py-2 rounded-xl bg-[#242424] hover:bg-[#2e2e2e] text-xs font-semibold text-gray-200 border border-[#383838] transition disabled:opacity-50"
              >
                {isLoadingMore ? 'Loading...' : t('loadMore')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
