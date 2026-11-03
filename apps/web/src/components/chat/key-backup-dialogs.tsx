'use client';

import React, { useEffect, useId, useState } from 'react';
import { X, KeyRound, RefreshCw, Copy, Check, Loader2, AlertTriangle } from 'lucide-react';
import { EFF_SHORT_WORDLIST } from '../../lib/e2ee/eff-short-wordlist';
import { checkOwnPassphrase, generatePassphrase, BackupError } from '../../lib/e2ee/key-backup';
import { getKeyBackupService } from '../../lib/e2ee/key-backup-service';

function Modal({
  title,
  onClose,
  children,
  busy,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  busy?: boolean;
}) {
  const titleId = useId();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose();
        }}
        className="relative w-full max-w-md space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-[#272727] dark:bg-[#181818]"
      >
        <div className="flex items-center justify-between">
          <h3
            id={titleId}
            className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white"
          >
            <KeyRound className="h-5 w-5 text-red-500" aria-hidden="true" />
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Đóng"
            className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-900 disabled:opacity-40 dark:hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-500 focus:outline-none dark:border-[#2c2c2c] dark:bg-[#121212] dark:text-white';

/**
 * Turn on the backup, change its passphrase, or reset it after forgetting the old one (`replace`). Offers a
 * generated 5-word passphrase (recommended) or the user's own (≥ 12 characters, zxcvbn ≥ 3), and makes the user
 * type it back before anything is created.
 */
export function BackupSetupDialog({
  mode,
  onClose,
  onDone,
}: {
  mode: 'enable' | 'change' | 'reset';
  onClose: () => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<'generated' | 'own'>('generated');
  const [generated, setGenerated] = useState(() => generatePassphrase(EFF_SHORT_WORDLIST));
  const [own, setOwn] = useState('');
  const [ownCheck, setOwnCheck] = useState<{ ok: boolean; message?: string } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { own: useId(), confirm: useId(), saved: useId(), hint: useId() };

  const passphrase = kind === 'generated' ? generated : own;

  useEffect(() => {
    if (kind !== 'own' || !own) {
      setOwnCheck(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void checkOwnPassphrase(own).then((r) => live && setOwnCheck(r));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kind, own]);

  const ready =
    saved &&
    confirm.trim() === passphrase.trim() &&
    (kind === 'generated' || ownCheck?.ok === true);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await getKeyBackupService().enable(passphrase.trim(), { replace: mode !== 'enable' });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không bật được sao lưu.');
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'enable'
      ? 'Bật sao lưu tin nhắn'
      : mode === 'change'
        ? 'Đổi cụm mật khẩu khôi phục'
        : 'Đặt lại bản sao lưu';

  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      {mode === 'reset' && (
        <p
          role="alert"
          className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          Đặt lại sẽ xoá bản sao lưu cũ. Lịch sử chỉ có trong bản cũ (không còn trên thiết bị nào
          đang đăng nhập) sẽ mất vĩnh viễn.
        </p>
      )}
      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
        Khoá giải mã tin nhắn được mã hoá bằng cụm mật khẩu này trước khi lưu lên máy chủ. Winkey
        không biết cụm mật khẩu và không thể khôi phục nếu bạn quên.
      </p>

      <fieldset className="flex rounded-xl border border-zinc-200 bg-zinc-100 p-1 text-xs dark:border-[#272727] dark:bg-[#121212]">
        <legend className="sr-only">Loại cụm mật khẩu</legend>
        {(['generated', 'own'] as const).map((k) => (
          <label
            key={k}
            className={`flex-1 cursor-pointer rounded-lg py-2 text-center font-semibold ${
              kind === k
                ? 'bg-white text-zinc-900 shadow-sm dark:bg-[#202020] dark:text-white'
                : 'text-zinc-600 dark:text-zinc-400'
            }`}
          >
            <input
              type="radio"
              name="passphrase-kind"
              value={k}
              checked={kind === k}
              onChange={() => {
                setKind(k);
                setConfirm('');
              }}
              className="sr-only"
            />
            {k === 'generated' ? 'Tạo sẵn (khuyên dùng)' : 'Tự đặt'}
          </label>
        ))}
      </fieldset>

      {kind === 'generated' ? (
        <div className="space-y-2">
          <p
            data-testid="generated-passphrase"
            className="rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-3 font-mono text-sm text-zinc-900 dark:border-[#2c2c2c] dark:bg-[#121212] dark:text-white"
          >
            {generated}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(generated);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {copied ? 'Đã sao chép' : 'Sao chép'}
            </button>
            <button
              type="button"
              onClick={() => {
                setGenerated(generatePassphrase(EFF_SHORT_WORDLIST));
                setConfirm('');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Tạo cụm khác
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <label
            htmlFor={ids.own}
            className="block text-xs font-medium text-zinc-700 dark:text-zinc-300"
          >
            Cụm mật khẩu của bạn (ít nhất 12 ký tự)
          </label>
          <input
            id={ids.own}
            type="password"
            autoComplete="new-password"
            value={own}
            onChange={(e) => setOwn(e.target.value)}
            aria-describedby={ids.hint}
            className={inputClass}
          />
          <p
            id={ids.hint}
            aria-live="polite"
            className="text-[11px] text-zinc-600 dark:text-zinc-400"
          >
            {ownCheck === null
              ? 'Dùng một câu dài, dễ nhớ với bạn nhưng khó đoán.'
              : ownCheck.ok
                ? 'Đủ mạnh.'
                : ownCheck.message}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <label
          htmlFor={ids.confirm}
          className="block text-xs font-medium text-zinc-700 dark:text-zinc-300"
        >
          Nhập lại cụm mật khẩu để xác nhận
        </label>
        <input
          id={ids.confirm}
          type="password"
          autoComplete="off"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass}
        />
      </div>
      <label
        htmlFor={ids.saved}
        className="flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-300"
      >
        <input
          id={ids.saved}
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-0.5"
        />
        Tôi đã lưu cụm mật khẩu ở nơi an toàn (trình quản lý mật khẩu hoặc giấy).
      </label>

      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Huỷ
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!ready || busy}
          className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {busy
            ? 'Đang tạo khoá… (có thể mất vài giây)'
            : mode === 'enable'
              ? 'Bật sao lưu'
              : 'Lưu'}
        </button>
      </div>
    </Modal>
  );
}

/** "Khôi phục lịch sử": unlock with the passphrase, then download and import every backed-up key. */
export function BackupRestoreDialog({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setProgress('Đang kiểm tra cụm mật khẩu…');
      const service = getKeyBackupService();
      await service.unlock(passphrase.trim());
      const result = await service.restore((done, total) =>
        setProgress(`Đang khôi phục khoá ${done}/${total}…`),
      );
      setProgress(`Đã khôi phục ${result.imported} khoá.`);
      void service.uploadPending().catch(() => {});
      onRestored();
    } catch (err) {
      setProgress(null);
      setError(
        err instanceof BackupError || err instanceof Error
          ? err.message
          : 'Không khôi phục được lịch sử.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Khôi phục lịch sử tin nhắn" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
          Nhập cụm mật khẩu khôi phục bạn đã đặt khi bật sao lưu để đọc lại tin nhắn cũ trên thiết
          bị này.
        </p>
        <div className="space-y-1.5">
          <label
            htmlFor={inputId}
            className="block text-xs font-medium text-zinc-700 dark:text-zinc-300"
          >
            Cụm mật khẩu khôi phục
          </label>
          <input
            id={inputId}
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            className={inputClass}
          />
        </div>
        <p aria-live="polite" className="min-h-4 text-xs text-zinc-600 dark:text-zinc-400">
          {progress}
        </p>
        {error && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Để sau
          </button>
          <button
            type="submit"
            disabled={!passphrase.trim() || busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Khôi phục
          </button>
        </div>
      </form>
    </Modal>
  );
}
