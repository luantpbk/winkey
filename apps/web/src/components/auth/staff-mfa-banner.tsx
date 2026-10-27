'use client';

import React from 'react';
import { useAuth } from '../../lib/auth/auth-context';
import { Link } from '../../i18n/routing';
import { ShieldAlert, ArrowRight } from 'lucide-react';

export function StaffMfaBanner() {
  const { user, isAuthenticated } = useAuth();

  if (
    !isAuthenticated ||
    !user ||
    !user.staff_roles_pending_mfa ||
    user.staff_roles_pending_mfa.length === 0
  ) {
    return null;
  }

  return (
    <aside
      role="alert"
      aria-label="Cảnh báo bảo mật quyền quản trị"
      className="w-full bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5 text-xs text-amber-900 dark:text-amber-200 transition-colors flex items-center justify-between gap-3 z-30"
    >
      <div className="flex items-center gap-2 min-w-0">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="truncate font-medium">Bật xác thực hai lớp để dùng quyền quản trị</span>
      </div>
      <Link
        href="/cai-dat/bao-mat"
        className="inline-flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-300 hover:underline shrink-0"
      >
        <span>Cài đặt bảo mật</span>
        <ArrowRight className="h-3 w-3" />
      </Link>
    </aside>
  );
}
