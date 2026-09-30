'use client';

import React, { useState, useEffect } from 'react';
import { notFound } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Flag, Users, History, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../../lib/auth/auth-context';
import { ModerationQueue } from '../../../components/admin/moderation-queue';
import { UserManagement } from '../../../components/admin/user-management';
import { AuditLogViewer } from '../../../components/admin/audit-log-viewer';

type AdminTab = 'queue' | 'users' | 'audit';

export default function AdminPage() {
  const t = useTranslations('admin');
  const { isLoading, isAuthenticated, canAccessAdmin, isAdmin, isModerator } = useAuth();

  const [activeTab, setActiveTab] = useState<AdminTab>('queue');

  // Route guard: if authenticated but neither moderator nor admin, trigger 404
  if (!isLoading && (!isAuthenticated || !canAccessAdmin)) {
    notFound();
  }

  // If a moderator somehow selects 'audit', reset to 'queue'
  useEffect(() => {
    if (!isAdmin && activeTab === 'audit') {
      setActiveTab('queue');
    }
  }, [isAdmin, activeTab]);

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

        {isAdmin && (
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
        {activeTab === 'users' && <UserManagement />}
        {activeTab === 'audit' && isAdmin && <AuditLogViewer />}
      </div>
    </div>
  );
}
