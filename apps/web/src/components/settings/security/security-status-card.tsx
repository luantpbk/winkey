'use client';

import React from 'react';
import type { SecuritySummary } from '@winkey/api-client';
import { ShieldCheck, ShieldAlert, Key, Smartphone, Lock, AlertTriangle } from 'lucide-react';

interface SecurityStatusCardProps {
  summary: SecuritySummary;
}

export function SecurityStatusCard({ summary }: SecurityStatusCardProps) {
  const isProtected = summary.mfa_enabled || summary.totp_enabled || summary.passkey_count > 0;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={`p-3 rounded-2xl border ${
              isProtected
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
            }`}
          >
            {isProtected ? (
              <ShieldCheck className="w-7 h-7" />
            ) : (
              <ShieldAlert className="w-7 h-7" />
            )}
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Tổng quan bảo mật tài khoản</h2>
            <p className="text-xs text-slate-400">
              {isProtected
                ? 'Tài khoản của bạn đã được tăng cường bảo vệ bằng lớp xác thực thứ hai.'
                : 'Hãy kích hoạt xác thực ứng dụng hoặc Passkey để bảo vệ tài khoản khỏi truy cập trái phép.'}
            </p>
          </div>
        </div>

        <div>
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
              isProtected
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                : 'bg-amber-500/15 border-amber-500/30 text-amber-400'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${isProtected ? 'bg-emerald-400' : 'bg-amber-400'}`}
            />
            {isProtected ? 'Đã bảo vệ' : 'Chưa bật 2FA'}
          </span>
        </div>
      </div>

      {summary.staff_roles_pending_mfa && summary.staff_roles_pending_mfa.length > 0 && (
        <div
          role="alert"
          className="p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-start gap-3 text-amber-300 text-xs"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-400" />
          <div>
            <span className="font-semibold">Yêu cầu quyền quản trị: </span>
            Bạn có quyền quản trị ({summary.staff_roles_pending_mfa.join(', ')}) đang bị tạm khóa.
            Bạn phải bật xác thực hai lớp (TOTP hoặc Passkey) để quyền quản trị có hiệu lực.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
        <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-1">
            <Smartphone className="w-3.5 h-3.5 text-slate-400" />
            <span>Mã ứng dụng (TOTP)</span>
          </div>
          <div className="text-sm font-semibold text-white">
            {summary.totp_enabled ? 'Đang bật' : 'Chưa bật'}
          </div>
        </div>

        <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-1">
            <Key className="w-3.5 h-3.5 text-slate-400" />
            <span>Passkeys</span>
          </div>
          <div className="text-sm font-semibold text-white">
            {summary.passkey_count > 0 ? `${summary.passkey_count} khóa` : 'Chưa có'}
          </div>
        </div>

        <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-1">
            <Lock className="w-3.5 h-3.5 text-slate-400" />
            <span>Mã khôi phục</span>
          </div>
          <div className="text-sm font-semibold text-white">
            {summary.recovery_codes_remaining} mã còn lại
          </div>
        </div>

        <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-1">
            <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
            <span>Mật khẩu</span>
          </div>
          <div className="text-sm font-semibold text-white">
            {summary.has_password ? 'Đã đặt mật khẩu' : 'Chưa đặt (OAuth)'}
          </div>
        </div>
      </div>
    </div>
  );
}
