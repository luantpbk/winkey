'use client';

import React, { useState, useEffect } from 'react';
import { ShieldCheck, Copy, Check, X } from 'lucide-react';
import { computeSafetyNumber } from '../../lib/e2ee/safety-number';

interface SafetyNumberDialogProps {
  isOpen: boolean;
  onClose: () => void;
  peerName: string;
  myEd25519Key: string;
  peerEd25519Key: string;
}

export function SafetyNumberDialog({
  isOpen,
  onClose,
  peerName,
  myEd25519Key,
  peerEd25519Key,
}: SafetyNumberDialogProps) {
  const [safetyNumber, setSafetyNumber] = useState<{
    formatted: string;
    groups: string[];
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen && myEd25519Key && peerEd25519Key) {
      computeSafetyNumber(myEd25519Key, peerEd25519Key).then((res) => {
        setSafetyNumber(res);
      });
    }
  }, [isOpen, myEd25519Key, peerEd25519Key]);

  if (!isOpen) return null;

  const handleCopy = () => {
    if (safetyNumber) {
      navigator.clipboard?.writeText(safetyNumber.formatted);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-md rounded-2xl bg-white dark:bg-[#181818] border border-zinc-200 dark:border-[#272727] p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-100 dark:border-[#242424]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
                Mã số an toàn E2EE
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Xác minh bảo mật với {peerName}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
          So sánh mã 60 chữ số này với đối phương qua kênh liên lạc khác (gặp trực tiếp hoặc gọi
          điện) để đảm bảo không ai can thiệp vào cuộc trò chuyện của hai bạn.
        </p>

        {safetyNumber ? (
          <div className="p-4 rounded-xl bg-zinc-50 dark:bg-[#121212] border border-zinc-200 dark:border-[#272727] space-y-3">
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 font-mono text-center text-sm font-semibold tracking-wider text-zinc-900 dark:text-zinc-100">
              {safetyNumber.groups.map((group, index) => (
                <div
                  key={index}
                  className="py-1 px-1.5 rounded bg-white dark:bg-[#1f1f1f] border border-zinc-200/50 dark:border-zinc-800"
                >
                  {group}
                </div>
              ))}
            </div>

            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                    <span>Đã sao chép</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Sao chép toàn bộ mã</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-center py-6">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          </div>
        )}

        <div className="pt-2 text-right">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
          >
            Đã hiểu
          </button>
        </div>
      </div>
    </div>
  );
}
