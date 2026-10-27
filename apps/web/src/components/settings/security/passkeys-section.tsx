'use client';

import React, { useState, useEffect } from 'react';
import { api } from '../../../lib/api-client';
import type { Passkey } from '@winkey/api-client';
import {
  isWebAuthnSupported,
  parseCreationOptions,
  serializeCredential,
} from '../../../lib/auth/webauthn';
import { Key, Plus, Trash2, Edit2, Check, X, AlertCircle, Cloud, Laptop } from 'lucide-react';
import { RecoveryCodesModal } from './recovery-codes-modal';

interface PasskeysSectionProps {
  onRefresh: () => void;
  onRequireStepUp: (onSuccessRetry: () => Promise<void>) => void;
}

function getDefaultPasskeyName(): string {
  if (typeof navigator === 'undefined') return 'Khóa bảo mật';
  const ua = navigator.userAgent;
  let browser = 'Trình duyệt';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
  else if (ua.includes('Firefox/')) browser = 'Firefox';

  let os = 'thiết bị';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('iPhone')) os = 'iPhone';
  else if (ua.includes('iPad')) os = 'iPad';
  else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'Mac';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('Linux')) os = 'Linux';

  return `${browser} trên ${os}`;
}

export function PasskeysSection({ onRefresh, onRequireStepUp }: PasskeysSectionProps) {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [supportsWebAuthn, setSupportsWebAuthn] = useState(false);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);

  useEffect(() => {
    setSupportsWebAuthn(isWebAuthnSupported());
    fetchPasskeys();
  }, []);

  const fetchPasskeys = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const { data, response, error } = await api.auth.GET('/v1/auth/me/passkeys');
      if (response.ok && data) {
        setPasskeys(data.items || (data as any).passkeys || []);
      } else {
        setErrorMessage(error?.detail || 'Không thể tải danh sách khóa truy cập.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi tải danh sách passkey.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddPasskey = async () => {
    setIsAdding(true);
    setErrorMessage(null);
    try {
      const {
        data: options,
        error: optErr,
        response: optRes,
      } = await api.auth.POST('/v1/auth/me/passkeys/registration-options');

      if (!optRes.ok || !options) {
        setErrorMessage(optErr?.detail || 'Không thể khởi tạo yêu cầu đăng ký passkey.');
        setIsAdding(false);
        return;
      }

      const creationOptions = parseCreationOptions(options.public_key as any);
      const credential = await navigator.credentials.create(creationOptions);
      if (!credential) {
        setErrorMessage('Không nhận được thông tin xác thực từ thiết bị.');
        setIsAdding(false);
        return;
      }

      const serialized = serializeCredential(credential);
      const defaultName = getDefaultPasskeyName();

      const {
        data: addData,
        error: addErr,
        response: addRes,
      } = await api.auth.POST('/v1/auth/me/passkeys', {
        body: {
          flow_id: options.flow_id,
          name: defaultName,
          credential: serialized,
        },
      });

      if (addRes.ok && addData) {
        await fetchPasskeys();
        onRefresh();

        if (addData.recovery_codes && addData.recovery_codes.length > 0) {
          setNewRecoveryCodes(addData.recovery_codes);
        }
      } else {
        setErrorMessage(addErr?.detail || 'Không thể lưu khóa truy cập mới.');
      }
    } catch (err: unknown) {
      const errorObj = err as { name?: string; message?: string };
      if (errorObj?.name !== 'NotAllowedError') {
        setErrorMessage(errorObj?.message || 'Lỗi khi tạo passkey.');
      }
    } finally {
      setIsAdding(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!editingName.trim()) {
      setEditingId(null);
      return;
    }

    try {
      const { response, error } = await api.auth.PATCH('/v1/auth/me/passkeys/{passkey_id}', {
        params: { path: { passkey_id: id } },
        body: { name: editingName.trim() },
      });

      if (response.ok) {
        setEditingId(null);
        await fetchPasskeys();
      } else {
        setErrorMessage(error?.detail || 'Không thể đổi tên passkey.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi đổi tên passkey.');
    }
  };

  const executeDeletePasskey = async (id: string) => {
    try {
      const { response, error } = await api.auth.DELETE('/v1/auth/me/passkeys/{passkey_id}', {
        params: { path: { passkey_id: id } },
      });

      if (response.status === 204 || response.ok) {
        await fetchPasskeys();
        onRefresh();
      } else if (response.status === 403 && error?.code === 'STEP_UP_REQUIRED') {
        onRequireStepUp(() => executeDeletePasskey(id));
      } else {
        setErrorMessage(error?.detail || 'Không thể xóa khóa truy cập.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi xóa passkey.');
    }
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Bạn có chắc chắn muốn xóa khóa truy cập "${name}"?`)) {
      executeDeletePasskey(id);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-500/10 rounded-xl text-blue-500 border border-blue-500/20">
            <Key className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Khóa truy cập (Passkeys)</h3>
            <p className="text-xs text-slate-400">
              Đăng nhập an toàn, tiện lợi bằng vân tay, Face ID, Windows Hello hoặc khóa bảo mật
              phần cứng.
            </p>
          </div>
        </div>

        {supportsWebAuthn && (
          <button
            type="button"
            onClick={handleAddPasskey}
            disabled={isAdding}
            className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-medium transition-colors shadow-lg shadow-red-600/20 flex items-center gap-2 self-start sm:self-center"
          >
            {isAdding ? (
              <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            <span>Thêm Passkey</span>
          </button>
        )}
      </div>

      {!supportsWebAuthn && (
        <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-400">
          Trình duyệt hoặc thiết bị của bạn không hỗ trợ WebAuthn / Passkeys.
        </div>
      )}

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
          <span>Đang tải danh sách khóa truy cập...</span>
        </div>
      ) : passkeys.length === 0 ? (
        <div className="py-8 text-center space-y-2">
          <Laptop className="w-8 h-8 text-slate-600 mx-auto" />
          <p className="text-sm font-medium text-slate-300">Chưa có khóa truy cập nào</p>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Thêm passkey để đăng nhập không cần mật khẩu từ điện thoại, máy tính bảng hoặc laptop
            của bạn.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {passkeys.map((pk) => {
            const isEditing = editingId === pk.id;
            return (
              <div
                key={pk.id}
                className="flex items-center justify-between p-3.5 bg-slate-950 border border-slate-800 rounded-xl hover:border-slate-700/80 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1 mr-3">
                  <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300">
                    <Key className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="flex items-center gap-2 max-w-xs">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white focus:outline-none focus:border-red-500 flex-1"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRename(pk.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => handleRename(pk.id)}
                          className="p-1 hover:text-emerald-400 text-slate-400"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="p-1 hover:text-red-400 text-slate-400"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white truncate">{pk.name}</span>
                        {pk.backed_up && (
                          <span
                            title="Khóa đã được đồng bộ đám mây (iCloud Keychain / Google Password Manager)"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20"
                          >
                            <Cloud className="w-2.5 h-2.5" />
                            <span>Đã đồng bộ</span>
                          </span>
                        )}
                      </div>
                    )}
                    <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
                      <span>Tạo: {new Date(pk.created_at).toLocaleDateString('vi-VN')}</span>
                      {pk.last_used_at && (
                        <>
                          <span>•</span>
                          <span>
                            Dùng gần nhất: {new Date(pk.last_used_at).toLocaleDateString('vi-VN')}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(pk.id);
                        setEditingName(pk.name);
                      }}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                      title="Đổi tên"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDelete(pk.id, pk.name)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
                    title="Xóa khóa"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recovery Codes Modal if newly generated */}
      {newRecoveryCodes && (
        <RecoveryCodesModal
          isOpen={true}
          codes={newRecoveryCodes}
          onClose={() => setNewRecoveryCodes(null)}
          title="Mã khôi phục mới cho tài khoản"
        />
      )}
    </div>
  );
}
