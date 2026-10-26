'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../lib/auth/auth-context';
import { computePermissions } from '../../lib/auth';
import { api } from '../../lib/api-client';
import { Link } from '../../i18n/routing';
import { useToast } from '../ui/toast';
import {
  Sparkles,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Upload,
  LayoutDashboard,
  Send,
  Loader2,
} from 'lucide-react';
import type { CreatorRequest } from '@winkey/api-client';

export function UpgradeCreatorView() {
  const { user, can: rawCan, refresh, isAuthenticated } = useAuth();
  const can = rawCan ?? computePermissions(user, isAuthenticated);
  const { showToast } = useToast();

  const [request, setRequest] = useState<CreatorRequest | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasRefreshedForApproval = useRef(false);

  const fetchRequest = useCallback(async () => {
    try {
      const { data, response } = await api.auth.GET('/v1/auth/me/creator-request');
      if (response.ok && data) {
        setRequest(data);
      } else if (response.status === 404) {
        setRequest(null);
      }
    } catch {
      // Ignore network errors during polling
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchRequest();
  }, [fetchRequest]);

  // Polling every 30s while tab is visible and status is PENDING
  useEffect(() => {
    if (request?.status !== 'PENDING') return;

    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        fetchRequest();
      }
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchRequest();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [request?.status, fetchRequest]);

  // When request is APPROVED and token lacks creator: call refresh() once and toast
  useEffect(() => {
    if (request?.status === 'APPROVED' && !can.upload && !hasRefreshedForApproval.current) {
      hasRefreshedForApproval.current = true;
      refresh()
        .then(() => {
          showToast({
            title: 'Yêu cầu sáng tạo của bạn đã được duyệt thành công!',
            type: 'success',
          });
        })
        .catch(() => {
          // ignore error
        });
    }
  }, [request?.status, can.upload, refresh, showToast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (trimmed.length < 10 || trimmed.length > 1000) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const { data, error, response } = await api.auth.POST('/v1/auth/me/creator-request', {
        body: { message: trimmed },
      });

      if (response.ok && data) {
        setRequest(data);
        showToast({
          title: 'Yêu cầu nâng cấp của bạn đã được gửi thành công.',
          type: 'success',
        });
      } else if (response.status === 429) {
        setErrorMessage(
          'Bạn đã gửi quá nhiều yêu cầu trong hôm nay. Vui lòng thử lại vào ngày mai.',
        );
      } else if (error) {
        const code = (error as any).code;
        if (code === 'ALREADY_CREATOR') {
          setErrorMessage('Tài khoản của bạn đã có quyền sáng tạo.');
          await refresh();
        } else if (code === 'REQUEST_PENDING') {
          setErrorMessage('Bạn đã có một yêu cầu đang chờ quản trị viên phê duyệt.');
          await fetchRequest();
        } else if (code === 'REQUEST_COOLDOWN') {
          setErrorMessage(
            (error as any).detail ||
              'Yêu cầu trước đó vừa bị từ chối. Bạn có thể gửi lại sau 24 giờ.',
          );
        } else {
          setErrorMessage((error as any).detail || (error as any).title || 'Gửi yêu cầu thất bại.');
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Lỗi kết nối khi gửi yêu cầu.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div
        data-testid="upgrade-creator-loading"
        className="max-w-2xl mx-auto py-12 px-4 flex flex-col items-center justify-center min-h-[360px]"
      >
        <Loader2 className="h-8 w-8 text-red-500 animate-spin mb-4" />
        <p className="text-xs text-gray-400">Đang kiểm tra trạng thái quyền sáng tạo...</p>
      </div>
    );
  }

  // If already a creator
  if (can.upload) {
    return (
      <div
        data-testid="upgrade-creator-approved"
        className="max-w-2xl mx-auto py-12 px-4 text-center"
      >
        <div className="rounded-2xl border border-green-500/30 bg-green-500/10 p-8 shadow-xl">
          <div className="flex h-16 w-16 mx-auto items-center justify-center rounded-full bg-green-500/20 text-green-500 mb-4">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            Bạn đã là Nhà sáng tạo Winkey!
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-6 max-w-md mx-auto">
            Tài khoản của bạn có toàn quyền đăng tải video chuẩn HLS CMAF đa độ phân giải, quản lý
            phụ đề, track âm thanh và phân tích Studio.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/upload"
              data-testid="upgrade-to-upload-btn"
              className="inline-flex items-center gap-2 rounded-xl bg-red-600 hover:bg-red-700 text-white px-5 py-2.5 text-sm font-semibold transition shadow-md"
            >
              <Upload className="h-4 w-4" />
              <span>Tải video lên</span>
            </Link>
            <Link
              href="/studio"
              data-testid="upgrade-to-studio-btn"
              className="inline-flex items-center gap-2 rounded-xl bg-gray-100 dark:bg-[#272727] hover:bg-gray-200 dark:hover:bg-[#383838] text-gray-800 dark:text-gray-200 px-5 py-2.5 text-sm font-semibold transition"
            >
              <LayoutDashboard className="h-4 w-4" />
              <span>Winkey Studio</span>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // State: PENDING
  if (request?.status === 'PENDING') {
    return (
      <div
        data-testid="upgrade-creator-pending"
        className="max-w-2xl mx-auto py-12 px-4 text-center"
      >
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-8 shadow-xl">
          <div className="flex h-16 w-16 mx-auto items-center justify-center rounded-full bg-amber-500/20 text-amber-500 mb-4 animate-pulse">
            <Clock className="h-8 w-8" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            Yêu cầu đang chờ duyệt
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4 max-w-md mx-auto">
            Yêu cầu trở thành Nhà sáng tạo của bạn đã được ghi nhận và đang chờ Quản trị viên phê
            duyệt.
          </p>
          <div className="inline-block bg-black/20 dark:bg-black/40 rounded-xl p-4 text-left max-w-lg w-full mb-6 text-xs border border-white/10">
            <div className="flex justify-between text-gray-400 mb-2">
              <span>Ngày gửi:</span>
              <span className="font-medium text-gray-300">
                {new Date(request.created_at).toLocaleString('vi-VN')}
              </span>
            </div>
            <div className="text-gray-400 mb-1">Nội dung giới thiệu:</div>
            <p className="text-gray-200 bg-black/30 p-2.5 rounded-lg whitespace-pre-wrap">
              {request.message}
            </p>
          </div>
          <p className="text-xs text-gray-400">
            Trang sẽ tự động cập nhật khi yêu cầu của bạn được xử lý.
          </p>
        </div>
      </div>
    );
  }

  // State: REJECTED
  if (request?.status === 'REJECTED') {
    return (
      <div data-testid="upgrade-creator-rejected" className="max-w-2xl mx-auto py-12 px-4">
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-8 shadow-xl text-center mb-6">
          <div className="flex h-16 w-16 mx-auto items-center justify-center rounded-full bg-red-500/20 text-red-500 mb-4">
            <XCircle className="h-8 w-8" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            Yêu cầu chưa được phê duyệt
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4 max-w-md mx-auto">
            Quản trị viên đã xem xét và từ chối yêu cầu sáng tạo của bạn.
          </p>
          {request.decision_note && (
            <div className="inline-block bg-black/20 dark:bg-black/40 rounded-xl p-4 text-left max-w-lg w-full mb-4 text-xs border border-white/10">
              <div className="text-gray-400 mb-1 font-semibold">Ghi chú từ quản trị viên:</div>
              <p className="text-red-300 bg-red-950/40 p-2.5 rounded-lg border border-red-800/40 whitespace-pre-wrap">
                {request.decision_note}
              </p>
              {request.decided_at && (
                <div className="text-[11px] text-gray-400 mt-2 text-right">
                  Thời gian: {new Date(request.decided_at).toLocaleString('vi-VN')}
                </div>
              )}
            </div>
          )}
          <p className="text-xs text-gray-400">
            Theo quy định, bạn có thể gửi lại yêu cầu nâng cấp sau 24 giờ kể từ khi có quyết định.
          </p>
        </div>

        {/* Option to submit a new request if cooldown has passed */}
        <div className="rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-6 sm:p-8 shadow-xl">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Gửi yêu cầu mới</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Vui lòng bổ sung thêm thông tin về định hướng kênh và nội dung video bạn dự định đăng
            tải.
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            {errorMessage && (
              <div className="flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                  Nội dung giới thiệu kênh
                </label>
                <span
                  className={`text-xs ${
                    message.length > 1000
                      ? 'text-red-500 font-bold'
                      : message.length >= 10
                        ? 'text-gray-400'
                        : 'text-amber-500'
                  }`}
                >
                  {message.length} / 1000 ký tự
                </span>
              </div>
              <textarea
                rows={4}
                required
                minLength={10}
                maxLength={1000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Mô tả về kênh của bạn, thể loại video dự kiến chia sẻ (tối thiểu 10 ký tự)..."
                className="w-full rounded-xl border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 p-3 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting || message.trim().length < 10 || message.trim().length > 1000}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 hover:bg-red-700 px-6 py-2.5 text-xs font-semibold text-white transition disabled:opacity-50 disabled:cursor-not-allowed shadow-md w-full sm:w-auto"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Đang gửi...</span>
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  <span>Gửi lại yêu cầu</span>
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // State: NONE (No request yet, render explanation and submission form)
  return (
    <div data-testid="upgrade-creator-form-view" className="max-w-2xl mx-auto py-8 px-4">
      <div className="rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-6 sm:p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#D9002B] text-white shadow-lg mb-3">
            <Sparkles className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Trở thành Nhà sáng tạo Winkey
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 max-w-md">
            Để đảm bảo chất lượng nội dung nền tảng, quyền đăng video và sử dụng Winkey Studio được
            Quản trị viên phê duyệt cho từng tài khoản.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <div className="rounded-xl border border-[#262626] dark:border-[#262626] border-gray-100 bg-[#1b1b1b] dark:bg-[#1b1b1b] bg-gray-50 p-3 text-center">
            <Upload className="h-5 w-5 text-red-500 mx-auto mb-1.5" />
            <div className="text-xs font-semibold text-gray-800 dark:text-gray-200">
              Đăng video không giới hạn
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">Chuẩn HLS đa độ phân giải</div>
          </div>
          <div className="rounded-xl border border-[#262626] dark:border-[#262626] border-gray-100 bg-[#1b1b1b] dark:bg-[#1b1b1b] bg-gray-50 p-3 text-center">
            <LayoutDashboard className="h-5 w-5 text-blue-500 mx-auto mb-1.5" />
            <div className="text-xs font-semibold text-gray-800 dark:text-gray-200">
              Winkey Studio
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">Phân tích & quản lý video</div>
          </div>
          <div className="rounded-xl border border-[#262626] dark:border-[#262626] border-gray-100 bg-[#1b1b1b] dark:bg-[#1b1b1b] bg-gray-50 p-3 text-center">
            <Sparkles className="h-5 w-5 text-amber-500 mx-auto mb-1.5" />
            <div className="text-xs font-semibold text-gray-800 dark:text-gray-200">
              Tính năng nâng cao
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">Đa track âm thanh & phụ đề</div>
          </div>
        </div>

        {errorMessage && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label
                htmlFor="creator-request-message"
                className="text-xs font-semibold text-gray-700 dark:text-gray-300"
              >
                Giới thiệu về kênh và nội dung video bạn dự định đăng
              </label>
              <span
                data-testid="creator-request-counter"
                className={`text-xs ${
                  message.length > 1000
                    ? 'text-red-500 font-bold'
                    : message.length >= 10
                      ? 'text-gray-400'
                      : 'text-amber-500'
                }`}
              >
                {message.length} / 1000 ký tự
              </span>
            </div>
            <textarea
              id="creator-request-message"
              data-testid="creator-request-textarea"
              rows={4}
              required
              minLength={10}
              maxLength={1000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Ví dụ: Tôi muốn chia sẻ các video hướng dẫn lập trình web và trải nghiệm công nghệ (tối thiểu 10 ký tự)..."
              className="w-full rounded-xl border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 p-3 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500"
            />
          </div>

          <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-[11px] text-gray-400">
              Tài khoản hiện tại: <span className="font-semibold text-gray-300">{user?.email}</span>
            </p>
            <button
              type="submit"
              data-testid="creator-request-submit-btn"
              disabled={isSubmitting || message.trim().length < 10 || message.trim().length > 1000}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 hover:bg-red-700 px-6 py-2.5 text-xs font-semibold text-white transition disabled:opacity-50 disabled:cursor-not-allowed shadow-md w-full sm:w-auto"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Đang gửi...</span>
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  <span>Gửi yêu cầu nâng cấp</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
