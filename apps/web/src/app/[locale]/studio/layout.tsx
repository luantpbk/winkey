'use client';

import React, { useEffect, type ReactNode } from 'react';
import { useAuth } from '../../../lib/auth/auth-context';
import { computePermissions } from '../../../lib/auth';
import { useRouter, usePathname } from '../../../i18n/routing';
import { UpgradeCreatorView } from '../../../components/auth/upgrade-creator-view';

export default function StudioLayout({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, can: rawCan, user } = useAuth();
  const can = rawCan ?? computePermissions(user, isAuthenticated);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push(`/login?return_to=${encodeURIComponent(pathname)}`);
    }
  }, [isLoading, isAuthenticated, pathname, router]);

  if (isLoading) {
    return (
      <div
        data-testid="studio-loading-placeholder"
        className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6"
      >
        <div className="h-8 w-48 bg-zinc-800/80 rounded animate-pulse" />
        <div className="h-10 w-full max-w-sm bg-zinc-800/50 rounded-xl animate-pulse" />
        <div className="h-64 w-full rounded-2xl border border-[#272727] bg-[#141414] p-6 animate-pulse" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  if (!can.studio) {
    return <UpgradeCreatorView />;
  }

  return <>{children}</>;
}
