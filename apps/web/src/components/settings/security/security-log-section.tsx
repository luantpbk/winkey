'use client';

import React, { useState, useEffect } from 'react';
import { api } from '../../../lib/api-client';
import type { SecurityEvent, SecurityEventKind } from '@winkey/api-client';
import {
  History,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Key,
  Smartphone,
  Lock,
  LogOut,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
} from 'lucide-react';

const EVENT_LABELS: Record<SecurityEventKind, { label: string; color: string; icon: any }> = {
  SIGN_IN: { label: 'Đăng nhập thành công', color: 'text-emerald-400', icon: ShieldCheck },
  SIGN_IN_NEW_DEVICE: {
    label: 'Đăng nhập từ thiết bị mới',
    color: 'text-amber-400',
    icon: AlertTriangle,
  },
  MFA_FAILED: { label: 'Xác thực 2FA thất bại', color: 'text-red-400', icon: ShieldAlert },
  TOTP_ENABLED: { label: 'Đã bật xác thực TOTP', color: 'text-emerald-400', icon: Smartphone },
  TOTP_DISABLED: { label: 'Đã tắt xác thực TOTP', color: 'text-amber-400', icon: Smartphone },
  RECOVERY_CODES_GENERATED: {
    label: 'Đã tạo mã khôi phục mới',
    color: 'text-blue-400',
    icon: RefreshCw,
  },
  RECOVERY_CODE_USED: {
    label: 'Đã dùng mã khôi phục để đăng nhập',
    color: 'text-purple-400',
    icon: Lock,
  },
  PASSKEY_ADDED: { label: 'Đã thêm khóa truy cập (Passkey)', color: 'text-emerald-400', icon: Key },
  PASSKEY_REMOVED: { label: 'Đã xóa khóa truy cập (Passkey)', color: 'text-slate-400', icon: Key },
  SESSION_REVOKED: { label: 'Đã đăng xuất một phiên', color: 'text-slate-400', icon: LogOut },
  OTHER_SESSIONS_REVOKED: {
    label: 'Đã đăng xuất tất cả thiết bị khác',
    color: 'text-slate-400',
    icon: LogOut,
  },
  SESSION_REPORTED: {
    label: 'Đã báo cáo phiên đăng nhập bất thường',
    color: 'text-red-400',
    icon: ShieldAlert,
  },
  PASSWORD_CHANGED: { label: 'Đã đổi mật khẩu', color: 'text-blue-400', icon: Lock },
  PASSWORD_RESET: { label: 'Đã đặt lại mật khẩu', color: 'text-blue-400', icon: Lock },
  STEP_UP: { label: 'Xác thực bảo mật nâng cao (Step-up)', color: 'text-indigo-400', icon: Shield },
};

export function SecurityLogSection() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchInitialEvents();
  }, []);

  const fetchInitialEvents = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const { data, response, error } = await api.auth.GET('/v1/auth/me/security-events', {
        params: { query: { limit: 15 } },
      });

      if (response.ok && data) {
        setEvents(data.items || []);
        setNextCursor(data.next_cursor);
      } else {
        setErrorMessage(error?.detail || 'Không thể tải nhật ký bảo mật.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi tải nhật ký bảo mật.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadMore = async () => {
    if (!nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    try {
      const { data, response } = await api.auth.GET('/v1/auth/me/security-events', {
        params: { query: { cursor: nextCursor, limit: 15 } },
      });

      if (response.ok && data) {
        setEvents((prev) => [...prev, ...(data.items || [])]);
        setNextCursor(data.next_cursor);
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingMore(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
      <div className="flex items-center gap-3 pb-4 border-b border-slate-800">
        <div className="p-2.5 bg-indigo-500/10 rounded-xl text-indigo-500 border border-indigo-500/20">
          <History className="w-6 h-6" />
        </div>
        <div>
          <h3 className="text-base font-bold text-white">Nhật ký hoạt động bảo mật</h3>
          <p className="text-xs text-slate-400">
            Lịch sử các sự kiện đăng nhập, thay đổi phương thức xác thực và quản lý tài khoản.
          </p>
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs"
        >
          {errorMessage}
        </div>
      )}

      {isLoading ? (
        <div className="py-6 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
          <div className="w-4 h-4 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
          <span>Đang tải nhật ký bảo mật...</span>
        </div>
      ) : events.length === 0 ? (
        <div className="py-8 text-center text-xs text-slate-500">
          Chưa có sự kiện bảo mật nào được ghi nhận.
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((ev) => {
            const meta = EVENT_LABELS[ev.kind] || {
              label: ev.kind,
              color: 'text-slate-300',
              icon: Shield,
            };
            const Icon = meta.icon;

            return (
              <div
                key={ev.id}
                className="flex items-start justify-between p-3.5 bg-slate-950/60 border border-slate-800/80 rounded-xl gap-3 text-xs"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={`p-2 rounded-lg bg-slate-900 border border-slate-800 shrink-0 ${meta.color}`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="space-y-0.5 min-w-0">
                    <span className="font-semibold text-white block">{meta.label}</span>
                    <div className="text-[11px] text-slate-400 flex items-center gap-2 flex-wrap">
                      {ev.device_label && <span>{ev.device_label}</span>}
                      {ev.country && (
                        <>
                          <span>•</span>
                          <span>{ev.country}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="text-[11px] text-slate-500 shrink-0 text-right">
                  <div>{new Date(ev.created_at).toLocaleDateString('vi-VN')}</div>
                  <div>
                    {new Date(ev.created_at).toLocaleTimeString('vi-VN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
              </div>
            );
          })}

          {nextCursor && (
            <div className="pt-3 text-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-medium border border-slate-700 transition-colors inline-flex items-center gap-1.5"
              >
                {isLoadingMore ? (
                  <div className="w-3.5 h-3.5 border-2 border-slate-400 border-t-white rounded-full animate-spin" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
                <span>Tải thêm sự kiện</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
