'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CloudUpload, Loader2 } from 'lucide-react';
import { getKeyBackupService } from '../../../lib/e2ee/key-backup-service';
import type { BackupStatus } from '../../../lib/e2ee/protocol';
import { BackupRestoreDialog, BackupSetupDialog } from '../../chat/key-backup-dialogs';

type View =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'off' }
  | { state: 'on'; version: number; sessionCount: number; local: BackupStatus };

/** Settings → Bảo mật → "Sao lưu tin nhắn" (SOC-3b). */
export function ChatBackupSection() {
  const [view, setView] = useState<View>({ state: 'loading' });
  const [dialog, setDialog] = useState<'enable' | 'change' | 'reset' | 'restore' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const service = getKeyBackupService();
      // The E2EE engine is only woken up when there is a backup to describe.
      const server = await service.getServerBackup();
      if (!server) {
        setView({ state: 'off' });
        return;
      }
      const local = await service.status();
      setView({ state: 'on', version: server.version, sessionCount: server.session_count, local });
    } catch {
      setView({ state: 'error', message: 'Không tải được trạng thái sao lưu.' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const turnOff = async () => {
    if (
      !window.confirm(
        'Tắt sao lưu sẽ xoá bản sao lưu trên máy chủ. Thiết bị mới sẽ không đọc được tin nhắn cũ. Tiếp tục?',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await getKeyBackupService().disable();
      setNotice('Đã tắt sao lưu tin nhắn.');
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Không tắt được sao lưu.');
    } finally {
      setBusy(false);
    }
  };

  const unlockedHere =
    view.state === 'on' && view.local.unlocked && view.local.version === view.version;

  return (
    <section
      aria-labelledby="chat-backup-title"
      className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-[#272727] dark:bg-[#181818]"
    >
      <div className="flex items-start gap-3">
        <CloudUpload className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />
        <div className="space-y-1">
          <h2
            id="chat-backup-title"
            className="text-sm font-semibold text-zinc-900 dark:text-white"
          >
            Sao lưu tin nhắn
          </h2>
          <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            Lưu khoá giải mã (đã mã hoá bằng cụm mật khẩu của bạn) để đọc lại lịch sử trên thiết bị
            mới. Winkey không đọc được tin nhắn hay cụm mật khẩu.
          </p>
        </div>
      </div>

      {view.state === 'loading' && (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" aria-label="Đang tải" />
      )}
      {view.state === 'error' && (
        <p className="text-xs text-red-600 dark:text-red-400">{view.message}</p>
      )}

      {view.state === 'off' && (
        <button
          type="button"
          onClick={() => setDialog('enable')}
          className="rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500"
        >
          Bật sao lưu
        </button>
      )}

      {view.state === 'on' && (
        <div className="space-y-3">
          <p data-testid="backup-status" className="text-xs text-zinc-700 dark:text-zinc-300">
            {unlockedHere
              ? `Đang bật · ${view.local.backedUpCount}/${view.local.sessionCount} khoá trên thiết bị này đã sao lưu.`
              : 'Đang bật · thiết bị này chưa mở khoá bản sao lưu.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {unlockedHere ? (
              <button
                type="button"
                onClick={() => setDialog('change')}
                className="rounded-xl border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Đổi cụm mật khẩu
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setDialog('restore')}
                  className="rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-500"
                >
                  Khôi phục lịch sử
                </button>
                <button
                  type="button"
                  onClick={() => setDialog('reset')}
                  className="rounded-xl border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Quên cụm mật khẩu? Đặt lại
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void turnOff()}
              disabled={busy}
              className="rounded-xl px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
            >
              Tắt sao lưu
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p aria-live="polite" className="text-xs text-zinc-700 dark:text-zinc-300">
          {notice}
        </p>
      )}

      {(dialog === 'enable' || dialog === 'change' || dialog === 'reset') && (
        <BackupSetupDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setNotice(
              dialog === 'enable' ? 'Đã bật sao lưu tin nhắn.' : 'Đã cập nhật bản sao lưu.',
            );
            void refresh();
          }}
        />
      )}
      {dialog === 'restore' && (
        <BackupRestoreDialog
          onClose={() => setDialog(null)}
          onRestored={() => {
            setDialog(null);
            setNotice('Đã khôi phục lịch sử tin nhắn trên thiết bị này.');
            void refresh();
          }}
        />
      )}
    </section>
  );
}
