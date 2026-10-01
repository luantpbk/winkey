'use client';

import React, { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { Link } from '../../i18n/routing';
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useSafeTimeout } from '../../lib/hooks/use-safe-timeout';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  link?: string;
  linkLabel?: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
}

interface ToastContextType {
  showToast: (toast: Omit<ToastItem, 'id'>) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const safeTimeout = useSafeTimeout();
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (toast: Omit<ToastItem, 'id'>) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const newToast: ToastItem = { ...toast, id };

      setToasts((prev) => [...prev, newToast]);

      const duration = toast.duration ?? 5000;
      if (duration > 0) {
        safeTimeout(() => {
          dismissToast(id);
        }, duration);
      }

      return id;
    },
    [dismissToast, safeTimeout],
  );

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <div
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none p-4"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto flex items-start gap-3 rounded-2xl bg-zinc-900 border border-zinc-700/80 p-4 shadow-2xl text-white transition-all transform duration-200 animate-in fade-in slide-in-from-bottom-5"
          >
            <div className="shrink-0 mt-0.5">
              {toast.type === 'success' && <CheckCircle2 className="h-5 w-5 text-green-400" />}
              {toast.type === 'error' && <AlertCircle className="h-5 w-5 text-red-400" />}
              {(!toast.type || toast.type === 'info') && <Info className="h-5 w-5 text-blue-400" />}
            </div>

            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">{toast.title}</p>
              {toast.description && (
                <p className="mt-0.5 text-xs text-zinc-300 leading-relaxed">{toast.description}</p>
              )}
              {toast.link && (
                <Link
                  href={toast.link}
                  onClick={() => dismissToast(toast.id)}
                  className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-red-400 hover:text-red-300 underline"
                >
                  {toast.linkLabel || 'Xem ngay'}
                </Link>
              )}
            </div>

            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Đóng thông báo"
              className="shrink-0 text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-800 transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const defaultToastContext: ToastContextType = {
  showToast: () => '',
  dismissToast: () => {},
};

export function useToast() {
  const context = useContext(ToastContext);
  return context ?? defaultToastContext;
}
