'use client';

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Link } from '../../../i18n/routing';
import { api } from '../../../lib/api-client';
import { ShieldCheck, ShieldAlert, KeyRound, Lock, AlertTriangle, ArrowRight } from 'lucide-react';

function ReportSessionContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [isLoading, setIsLoading] = useState(true);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setIsLoading(false);
      setErrorMessage('Liên kết không hợp lệ hoặc thiếu mã xác thực token.');
      return;
    }

    let isMounted = true;
    async function report() {
      try {
        const { response, error } = await api.auth.POST('/v1/auth/sessions/report', {
          body: { token: token! },
        });

        if (!isMounted) return;

        if (response.status === 204 || response.ok) {
          setIsSuccess(true);
        } else {
          setErrorMessage(
            error?.detail || 'Mã báo cáo không hợp lệ, đã được sử dụng hoặc đã hết hạn.',
          );
        }
      } catch {
        if (!isMounted) return;
        setErrorMessage('Không thể kết nối đến máy chủ. Vui lòng thử lại sau.');
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    report();

    return () => {
      isMounted = false;
    };
  }, [token]);

  if (isLoading) {
    return (
      <div className="w-full max-w-lg p-8 bg-slate-900 border border-slate-800 rounded-2xl shadow-xl text-center space-y-4">
        <div className="w-8 h-8 border-2 border-red-500/20 border-t-red-500 rounded-full animate-spin mx-auto" />
        <h1 className="text-xl font-semibold text-white">Đang xử lý báo cáo đăng nhập...</h1>
        <p className="text-sm text-slate-400">
          Vui lòng đợi giây lát, chúng tôi đang xác minh mã và huỷ phiên đáng ngờ.
        </p>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="w-full max-w-lg p-8 bg-slate-900 border border-slate-800 rounded-2xl shadow-xl space-y-6">
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="p-3 bg-emerald-500/10 rounded-2xl text-emerald-400 border border-emerald-500/20">
              <ShieldCheck className="w-10 h-10" />
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Đã huỷ phiên đăng nhập đáng ngờ
          </h1>
          <p className="text-sm text-slate-300">
            Phiên đăng nhập này đã được huỷ bỏ ngay lập tức. Thiết bị đó sẽ không thể tiếp tục truy
            cập vào tài khoản của bạn.
          </p>
        </div>

        <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            Khuyến nghị bảo vệ tài khoản
          </h2>
          <p className="text-xs text-slate-400">
            Nếu bạn không phải là người thực hiện lượt đăng nhập đó, mật khẩu của bạn có thể đã bị
            lộ. Hãy thực hiện ngay các bước sau:
          </p>

          <div className="pt-2 space-y-2">
            <Link
              href="/cai-dat"
              className="flex items-center justify-between p-3 rounded-lg bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 transition-colors text-sm text-white group"
            >
              <span className="flex items-center gap-2.5 font-medium">
                <Lock className="w-4 h-4 text-red-400" />
                Đổi mật khẩu tài khoản
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition-transform" />
            </Link>

            <Link
              href="/cai-dat/bao-mat"
              className="flex items-center justify-between p-3 rounded-lg bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 transition-colors text-sm text-white group"
            >
              <span className="flex items-center gap-2.5 font-medium">
                <KeyRound className="w-4 h-4 text-emerald-400" />
                Bật xác thực 2 lớp (2FA) & Passkey
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>
        </div>

        <div className="text-center pt-2">
          <Link href="/" className="text-xs text-slate-500 hover:text-slate-400 transition-colors">
            Quay lại trang chủ Winkey
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg p-8 bg-slate-900 border border-slate-800 rounded-2xl shadow-xl space-y-6">
      <div className="text-center space-y-2">
        <div className="flex justify-center">
          <div className="p-3 bg-red-500/10 rounded-2xl text-red-400 border border-red-500/20">
            <ShieldAlert className="w-10 h-10" />
          </div>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Không thể xử lý báo cáo</h1>
        <p className="text-sm text-slate-300">
          {errorMessage || 'Liên kết không hợp lệ, đã được dùng hoặc đã hết hạn sau 7 ngày.'}
        </p>
      </div>

      <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-3">
        <p className="text-xs text-slate-400">
          Nếu bạn nghi ngờ tài khoản bị xâm phạm, bạn vẫn có thể đăng nhập để kiểm tra danh sách
          phiên và đổi mật khẩu bất kỳ lúc nào.
        </p>
        <div className="pt-2 flex flex-col sm:flex-row gap-2">
          <Link
            href="/cai-dat/bao-mat"
            className="flex-1 py-2.5 px-4 bg-red-600 hover:bg-red-500 text-white text-center text-sm font-medium rounded-lg transition-colors"
          >
            Kiểm tra bảo mật
          </Link>
          <Link
            href="/login"
            className="flex-1 py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-white text-center text-sm font-medium rounded-lg border border-slate-700 transition-colors"
          >
            Đăng nhập
          </Link>
        </div>
      </div>

      <div className="text-center pt-2">
        <Link href="/" className="text-xs text-slate-500 hover:text-slate-400 transition-colors">
          Quay lại trang chủ Winkey
        </Link>
      </div>
    </div>
  );
}

export default function ReportSessionPage() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4 py-12">
      <ReportSessionContent />
    </div>
  );
}
