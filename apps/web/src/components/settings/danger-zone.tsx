'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { User } from '@winkey/api-client';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { DeleteAccountDialog } from './delete-account-dialog';

interface DangerZoneProps {
  user: User;
}

export function DangerZone({ user }: DangerZoneProps) {
  const t = useTranslations('settings.account');
  const [showDialog, setShowDialog] = useState(false);

  return (
    <>
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 dark:bg-red-950/10 p-6 shadow-sm">
        <div className="flex items-center gap-3 mb-4 pb-4 border-b border-red-500/20">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-red-600 dark:text-red-400">
              {t('dangerZone.title')}
            </h2>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {t('dangerZone.description')}
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-2">
          <div className="text-xs text-zinc-500 dark:text-zinc-400 max-w-md">
            {t('dangerZone.modalWarning')}
          </div>
          <button
            type="button"
            onClick={() => setShowDialog(true)}
            className="flex h-10 px-4 items-center gap-2 rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition shadow-sm shrink-0"
          >
            <Trash2 className="h-4 w-4" />
            <span>{t('dangerZone.deleteButton')}</span>
          </button>
        </div>
      </div>

      <DeleteAccountDialog user={user} isOpen={showDialog} onClose={() => setShowDialog(false)} />
    </>
  );
}
