'use client';

import React, { useState, useEffect } from 'react';
import { api } from '../../../lib/api-client';
import type { Session } from '@winkey/api-client';
import { Laptop, Smartphone, LogOut, AlertCircle } from 'lucide-react';

interface SessionsSectionProps {
  onRequireStepUp: (onSuccessRetry: () => Promise<void>) => void;
}

function getCountryFlag(countryCode?: string | null): string {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  try {
    const codePoints = countryCode
      .toUpperCase()
      .split('')
      .map((char) => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
  } catch {
    return '🌐';
  }
}

export function SessionsSection({ onRequireStepUp }: SessionsSectionProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRevokingAll, setIsRevokingAll] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const { data, response, error } = await api.auth.GET('/v1/auth/me/sessions');
      if (response.ok && data) {
        setSessions(data.items || (data as any).sessions || []);
      } else {
        setErrorMessage(error?.detail || 'Không thể tải danh sách phiên đăng nhập.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi tải danh sách phiên.');
    } finally {
      setIsLoading(false);
    }
  };

  const executeRevokeSession = async (id: string) => {
    setRevokingId(id);
    setErrorMessage(null);
    try {
      const { response, error } = await api.auth.DELETE('/v1/auth/me/sessions/{session_id}', {
        params: { path: { session_id: id } },
      });

      if (response.status === 204 || response.ok) {
        await fetchSessions();
      } else if (response.status === 403 && error?.code === 'STEP_UP_REQUIRED') {
        onRequireStepUp(() => executeRevokeSession(id));
      } else {
        setErrorMessage(error?.detail || 'Không thể đăng xuất phiên này.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi đăng xuất phiên.');
    } finally {
      setRevokingId(null);
    }
  };

  const executeRevokeOthers = async () => {
    setIsRevokingAll(true);
    setErrorMessage(null);
    try {
      const { response, error } = await api.auth.POST('/v1/auth/me/sessions/revoke-others');

      if (response.status === 204 || response.ok) {
        await fetchSessions();
      } else if (response.status === 403 && error?.code === 'STEP_UP_REQUIRED') {
        onRequireStepUp(executeRevokeOthers);
      } else {
        setErrorMessage(error?.detail || 'Không thể đăng xuất các thiết bị khác.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi đăng xuất các thiết bị khác.');
    } finally {
      setIsRevokingAll(false);
    }
  };

  const handleRevokeOthers = () => {
    if (confirm('Bạn có chắc chắn muốn đăng xuất khỏi tất cả các thiết bị khác?')) {
      executeRevokeOthers();
    }
  };

  const otherSessionsCount = sessions.filter((s) => !s.current).length;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-purple-500/10 rounded-xl text-purple-500 border border-purple-500/20">
            <Laptop className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Phiên đăng nhập đang hoạt động</h3>
            <p className="text-xs text-slate-400">
              Quản lý các thiết bị và trình duyệt đang duy trì đăng nhập vào tài khoản của bạn.
            </p>
          </div>
        </div>

        {otherSessionsCount > 0 && (
          <button
            type="button"
            onClick={handleRevokeOthers}
            disabled={isRevokingAll}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-red-400 border border-slate-700 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 self-start sm:self-center"
          >
            {isRevokingAll ? (
              <div className="w-4 h-4 border-2 border-red-400/20 border-t-red-400 rounded-full animate-spin" />
            ) : (
              <LogOut className="w-4 h-4" />
            )}
            <span>Đăng xuất tất cả thiết bị khác</span>
          </button>
        )}
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2.5 text-red-400 text-xs"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      {isLoading ? (
        <div className="py-6 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
          <div className="w-4 h-4 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
          <span>Đang tải danh sách phiên đăng nhập...</span>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((sess) => {
            const isRevoking = revokingId === sess.id;
            const flag = getCountryFlag(sess.country);

            return (
              <div
                key={sess.id}
                className={`flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border transition-colors gap-3 ${
                  sess.current
                    ? 'bg-slate-950/90 border-slate-700/80'
                    : 'bg-slate-950/50 border-slate-800 hover:border-slate-750'
                }`}
              >
                <div className="flex items-start gap-3.5 min-w-0">
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 mt-0.5">
                    {sess.device_label?.toLowerCase().includes('phone') ||
                    sess.device_label?.toLowerCase().includes('android') ||
                    sess.device_label?.toLowerCase().includes('ios') ? (
                      <Smartphone className="w-5 h-5 text-purple-400" />
                    ) : (
                      <Laptop className="w-5 h-5 text-purple-400" />
                    )}
                  </div>

                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-white">
                        {sess.device_label || 'Thiết bị không xác định'}
                      </span>
                      {sess.current && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
                          Thiết bị này
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs text-slate-400 flex-wrap">
                      <span className="flex items-center gap-1">
                        <span>{flag}</span>
                        <span>{sess.country || 'Vị trí không xác định'}</span>
                      </span>
                      <span>•</span>
                      <span>
                        Hoạt động: {new Date(sess.last_used_at).toLocaleDateString('vi-VN')}{' '}
                        {new Date(sess.last_used_at).toLocaleTimeString('vi-VN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>

                    {sess.methods && sess.methods.length > 0 && (
                      <div className="flex items-center gap-1.5 pt-0.5">
                        <span className="text-[11px] text-slate-500">Đăng nhập bằng:</span>
                        {sess.methods.map((m) => (
                          <span
                            key={m}
                            className="px-1.5 py-0.2 rounded text-[10px] bg-slate-900 text-slate-300 border border-slate-800 uppercase"
                          >
                            {m}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {!sess.current && (
                  <button
                    type="button"
                    onClick={() => executeRevokeSession(sess.id)}
                    disabled={isRevoking}
                    className="self-end sm:self-center px-3 py-1.5 bg-slate-900 hover:bg-red-500/10 text-slate-400 hover:text-red-400 border border-slate-800 hover:border-red-500/20 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
                  >
                    {isRevoking ? (
                      <div className="w-3.5 h-3.5 border-2 border-red-400/20 border-t-red-400 rounded-full animate-spin" />
                    ) : (
                      <LogOut className="w-3.5 h-3.5" />
                    )}
                    <span>Đăng xuất</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
