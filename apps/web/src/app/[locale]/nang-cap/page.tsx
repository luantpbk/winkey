'use client';

import React, { useEffect } from 'react';
import { useAuth } from '../../../lib/auth/auth-context';
import { useRouter, usePathname } from '../../../i18n/routing';
import { UpgradeCreatorView } from '../../../components/auth/upgrade-creator-view';
import { Loader2 } from 'lucide-react';

export default function NangCapPage() {
  const { isLoading, isAuthenticated } = useAuth();
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
        data-testid="nang-cap-loading-placeholder"
        className="max-w-2xl mx-auto py-12 px-4 flex flex-col items-center justify-center min-h-[360px]"
      >
        <Loader2 className="h-8 w-8 text-red-500 animate-spin mb-4" />
        <div className="h-4 w-48 bg-zinc-800 rounded animate-pulse" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <UpgradeCreatorView />;
}
