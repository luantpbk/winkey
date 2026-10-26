'use client';

import React, { useState, useEffect } from 'react';
import { notFound } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Flag, Users, History, ShieldCheck, Sparkles, Film } from 'lucide-react';
import { useAuth } from '../../../lib/auth/auth-context';
import { computePermissions } from '../../../lib/auth';
import { api } from '../../../lib/api-client';
import { ModerationQueue } from '../../../components/admin/moderation-queue';
import { UserManagement } from '../../../components/admin/user-management';
import { AuditLogViewer } from '../../../components/admin/audit-log-viewer';
import { CreatorRequestsViewer } from '../../../components/admin/creator-requests-viewer';
import { AdminVideosViewer } from '../../../components/admin/admin-videos-viewer';

type AdminTab = 'queue' | 'videos' | 'users' | 'creator-requests' | 'audit';

export default function AdminPage() {
  const t = useTranslations('admin');
  const { isLoading, isAuthenticated, can: rawCan, user, isAdmin, isModerator } = useAuth();
  const can = rawCan ?? computePermissions(user, isAuthenticated);

  const [activeTab, setActiveTab] = useState<AdminTab>('queue');
  const [pendingCount, setPendingCount] = useState<number>(0);

  // Fetch pending creator requests count for admin badge
  useEffect(() => {
    if (can.adminOnly) {
      api.auth
        .GET('/v1/admin/creator-requests', {
          params: { query: { status: 'PENDING' } },
        })
        .then(({ data }) => {
          if (data) {
            setPendingCount(data.pending_count);
          }
        })
        .catch(() => {});
    }
  }, [can.adminOnly]);

  // Ensure document language is explicitly declared for accessibility audit
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = 'vi';
    }
  }, []);

  // Route guard: if authenticated but not moderator or admin, trigger 404
  if (!isLoading && (!isAuthenticated || !can.moderate)) {
    notFound();
  }

  // If a moderator somehow selects 'audit' or 'creator-requests', reset to 'queue'
  useEffect(() => {
    if (!can.adminOnly && (activeTab === 'audit' || activeTab === 'creator-requests')) {
      setActiveTab('queue');
    }
  }, [can.adminOnly, activeTab]);

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#282828] pb-6">
        <div>
          <div className="flex items-center gap-2 text-red-500 mb-1">
            <ShieldCheck className="h-6 w-6" />
            <h1 className="text-2xl font-bold tracking-tight text-white">{t('title')}</h1>
          </div>
          <p className="text-xs text-gray-400">{t('description')}</p>
        </div>

        {/* Roles status tag */}
        <div className="flex items-center gap-2">
          {isAdmin && (
            <span className="px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-red-950/60 text-red-400 border border-red-700/50">
              Administrator
            </span>
          )}
          {isModerator && !isAdmin && (
            <span className="px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-purple-950/60 text-purple-400 border border-purple-700/50">
              Moderator
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-[#282828] pb-px overflow-x-auto">
        <button
          onClick={() => setActiveTab('queue')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-xl transition border-b-2 whitespace-nowrap ${
            activeTab === 'queue'
              ? 'border-red-500 text-white bg-[#222]'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-[#1a1a1a]'
          }`}
        >
          <Flag className="h-4 w-4" />
          <span>{t('nav.queue')}</span>
        </button>

        <button
          data-testid="admin-tab-videos"
          onClick={() => setActiveTab('videos')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-xl transition border-b-2 whitespace-nowrap ${
            activeTab === 'videos'
              ? 'border-red-500 text-white bg-[#222]'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-[#1a1a1a]'
          }`}
        >
          <Film className="h-4 w-4" />
          <span>{t('nav.videos')}</span>
        </button>

        <button
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-xl transition border-b-2 whitespace-nowrap ${
            activeTab === 'users'
              ? 'border-red-500 text-white bg-[#222]'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-[#1a1a1a]'
          }`}
        >
          <Users className="h-4 w-4" />
          <span>{t('nav.users')}</span>
        </button>

        {can.adminOnly && (
          <button
            data-testid="admin-tab-creator-requests"
            onClick={() => setActiveTab('creator-requests')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-xl transition border-b-2 whitespace-nowrap ${
              activeTab === 'creator-requests'
                ? 'border-red-500 text-white bg-[#222]'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-[#1a1a1a]'
            }`}
          >
            <Sparkles className="h-4 w-4 text-amber-500" />
            <span>Yêu cầu sáng tạo</span>
            {pendingCount > 0 && (
              <span
                data-testid="pending-creator-requests-badge"
                className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-600 text-white leading-none"
              >
                {pendingCount}
              </span>
            )}
          </button>
        )}

        {can.adminOnly && (
          <button
            onClick={() => setActiveTab('audit')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-xl transition border-b-2 whitespace-nowrap ${
              activeTab === 'audit'
                ? 'border-red-500 text-white bg-[#222]'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-[#1a1a1a]'
            }`}
          >
            <History className="h-4 w-4" />
            <span>{t('nav.audit')}</span>
          </button>
        )}
      </div>

      {/* Active Tab Content */}
      <div className="pt-2">
        {activeTab === 'queue' && <ModerationQueue />}
        {activeTab === 'videos' && <AdminVideosViewer />}
        {activeTab === 'users' && <UserManagement />}
        {activeTab === 'creator-requests' && can.adminOnly && (
          <CreatorRequestsViewer onPendingCountChange={setPendingCount} />
        )}
        {activeTab === 'audit' && can.adminOnly && <AuditLogViewer />}
      </div>
    </div>
  );
}
