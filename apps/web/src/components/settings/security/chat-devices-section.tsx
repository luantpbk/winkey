'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../../lib/api-client';
import type { OwnDevice } from '@winkey/api-client';
import { Laptop, Smartphone, Shield, Trash2, KeyRound, Check, Copy } from 'lucide-react';
import { getDeviceManager } from '../../../lib/e2ee/device-manager';

export function ChatDevicesSection() {
  const [devices, setDevices] = useState<OwnDevice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  const currentDeviceId = getDeviceManager().getDeviceId();

  const fetchDevices = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const { data, response, error } = await api.chat.GET('/v1/chat/devices');
      if (response.ok && data) {
        setDevices(data.items || []);
      } else {
        setErrorMessage(error?.detail || 'Không thể tải danh sách thiết bị nhắn tin.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi tải danh sách thiết bị nhắn tin.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleCopyKey = (keyText: string, id: string) => {
    navigator.clipboard?.writeText(keyText);
    setCopiedKeyId(id);
    setTimeout(() => setCopiedKeyId(null), 2000);
  };

  const handleRemoveDevice = async (device: OwnDevice) => {
    const isCurrent = device.id === currentDeviceId;
    const confirmMsg = isCurrent
      ? 'Bạn có chắc chắn muốn xoá thiết bị này khỏi hệ thống E2EE? Toàn bộ khoá mã hoá trên trình duyệt này sẽ bị xoá.'
      : `Bạn có chắc chắn muốn xoá thiết bị "${device.display_name}"? Thiết bị này sẽ không thể giải mã các tin nhắn mới.`;

    if (!window.confirm(confirmMsg)) {
      return;
    }

    setRemovingId(device.id);
    setErrorMessage(null);
    try {
      if (isCurrent) {
        await getDeviceManager().unregisterDeviceAndLogout(device.id);
      } else {
        await api.chat.DELETE('/v1/chat/devices/{device_id}', {
          params: { path: { device_id: device.id } },
        });
      }
      await fetchDevices();
    } catch {
      setErrorMessage('Lỗi khi xoá thiết bị nhắn tin.');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-[#272727] bg-white dark:bg-[#121212] p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-zinc-100 dark:border-[#1f1f1f]">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-white">
              Thiết bị nhắn tin mã hoá (E2EE)
            </h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              <Shield className="h-3 w-3" />
              Đầu cuối
            </span>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Mỗi thiết bị sở hữu cặp khoá riêng biệt (Matrix Vodozemac). Máy chủ không bao giờ đọc
            được nội dung tin nhắn. Tối đa 10 thiết bị hoạt động đồng thời.
          </p>
        </div>
      </div>

      {errorMessage && (
        <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-500">
          {errorMessage}
        </div>
      )}

      <div className="mt-6 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
          </div>
        ) : devices.length === 0 ? (
          <div className="text-center py-8 text-xs text-zinc-500 dark:text-zinc-400">
            Chưa có thiết bị nhắn tin nào được đăng ký. Thiết bị sẽ tự động kích hoạt khi bạn mở mục
            Tin nhắn.
          </div>
        ) : (
          devices.map((device) => {
            const isCurrent = device.id === currentDeviceId;
            const isMobile =
              device.display_name.toLowerCase().includes('iphone') ||
              device.display_name.toLowerCase().includes('android') ||
              device.display_name.toLowerCase().includes('mobile');

            return (
              <div
                key={device.id}
                className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border transition-colors ${
                  isCurrent
                    ? 'border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-500/5'
                    : 'border-zinc-100 dark:border-[#1f1f1f] bg-zinc-50/50 dark:bg-[#181818]'
                }`}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={`p-2.5 rounded-xl shrink-0 ${
                      isCurrent
                        ? 'bg-emerald-500/10 text-emerald-500'
                        : 'bg-zinc-200/50 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    {isMobile ? <Smartphone className="h-5 w-5" /> : <Laptop className="h-5 w-5" />}
                  </div>

                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-zinc-900 dark:text-white">
                        {device.display_name}
                      </span>
                      {isCurrent && (
                        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          Thiết bị này
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400 flex-wrap">
                      <span>
                        Đăng ký: {new Date(device.created_at).toLocaleDateString('vi-VN')}
                      </span>
                      <span>•</span>
                      <span>
                        Hoạt động: {new Date(device.last_seen_at).toLocaleDateString('vi-VN')}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 pt-1 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                      <KeyRound className="h-3 w-3 shrink-0" />
                      <span className="truncate max-w-[200px]" title={device.ed25519_key}>
                        Ed25519: {device.ed25519_key.slice(0, 8)}…{device.ed25519_key.slice(-8)}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyKey(device.ed25519_key, device.id)}
                        className="hover:text-zinc-200 transition-colors"
                        title="Sao chép khoá định danh"
                      >
                        {copiedKeyId === device.id ? (
                          <Check className="h-3 w-3 text-emerald-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                  <button
                    type="button"
                    disabled={removingId === device.id}
                    onClick={() => handleRemoveDevice(device)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/20 text-xs font-medium text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>{removingId === device.id ? 'Đang xoá…' : 'Xoá thiết bị'}</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
