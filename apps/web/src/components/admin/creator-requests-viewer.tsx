'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { computePermissions } from '../../lib/auth';
import { useToast } from '../ui/toast';
import { formatRelativeTime } from '../../lib/format';
import { Sparkles, Check, X, AlertCircle, Clock, RotateCw, Loader2 } from 'lucide-react';
import type { AdminCreatorRequest, CreatorRequestStatus, Problem } from '@winkey/api-client';

export function CreatorRequestsViewer({
  onPendingCountChange,
}: {
  onPendingCountChange?: (count: number) => void;
}) {
  const { can: rawCan, user, isAuthenticated } = useAuth();
  const can = rawCan ?? computePermissions(user, isAuthenticated);
  const { showToast } = useToast();

  const [requests, setRequests] = useState<AdminCreatorRequest[]>([]);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [statusFilter, setStatusFilter] = useState<CreatorRequestStatus | 'ALL'>('PENDING');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reject dialog state
  const [rejectModal, setRejectModal] = useState<{
    isOpen: boolean;
    target: AdminCreatorRequest | null;
    note: string;
    isSubmitting: boolean;
    error: string | null;
  }>({
    isOpen: false,
    target: null,
    note: '',
    isSubmitting: false,
    error: null,
  });

  // Approve dialog state (optional note)
  const [approveModal, setApproveModal] = useState<{
    isOpen: boolean;
    target: AdminCreatorRequest | null;
    note: string;
    isSubmitting: boolean;
  }>({
    isOpen: false,
    target: null,
    note: '',
    isSubmitting: false,
  });

  const fetchRequests = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const {
        data,
        response,
        error: apiErr,
      } = await api.auth.GET('/v1/admin/creator-requests', {
        params: {
          query: statusFilter !== 'ALL' ? { status: statusFilter } : undefined,
        },
      });

      if (response.ok && data) {
        setRequests(data.items);
        setPendingCount(data.pending_count);
        onPendingCountChange?.(data.pending_count);
      } else {
        setError((apiErr as Problem)?.detail || 'Không thể tải danh sách yêu cầu sáng tạo');
      }
    } catch (err: any) {
      setError(err.message || 'Lỗi kết nối khi tải danh sách');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, onPendingCountChange]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const handleApprove = async () => {
    const target = approveModal.target;
    if (!target) return;

    setApproveModal((prev) => ({ ...prev, isSubmitting: true }));

    // Optimistic UI update: remove row if viewing PENDING or update its status
    const prevRequests = [...requests];
    const prevPending = pendingCount;

    if (statusFilter === 'PENDING') {
      setRequests((prev) => prev.filter((r) => r.id !== target.id));
    } else {
      setRequests((prev) =>
        prev.map((r) =>
          r.id === target.id
            ? {
                ...r,
                status: 'APPROVED',
                decision_note: approveModal.note.trim() || null,
                decided_at: new Date().toISOString(),
              }
            : r,
        ),
      );
    }
    const newPending = Math.max(0, pendingCount - 1);
    setPendingCount(newPending);
    onPendingCountChange?.(newPending);

    try {
      const { error: apiErr, response } = await api.auth.POST(
        '/v1/admin/creator-requests/{request_id}/decision',
        {
          params: { path: { request_id: target.id } },
          body: {
            decision: 'APPROVE',
            note: approveModal.note.trim() || undefined,
          },
        },
      );

      if (response.status === 409) {
        showToast({
          title: 'Yêu cầu này đã được xử lý trước đó.',
          type: 'warning',
        });
        await fetchRequests();
      } else if (!response.ok) {
        setRequests(prevRequests);
        setPendingCount(prevPending);
        onPendingCountChange?.(prevPending);
        showToast({
          title: (apiErr as Problem)?.detail || 'Không thể duyệt yêu cầu.',
          type: 'error',
        });
      } else {
        showToast({
          title: `Đã cấp quyền Creator cho @${target.user.handle}.`,
          type: 'success',
        });
      }
    } catch {
      setRequests(prevRequests);
      setPendingCount(prevPending);
      onPendingCountChange?.(prevPending);
      showToast({
        title: 'Lỗi mạng khi xử lý duyệt yêu cầu.',
        type: 'error',
      });
    } finally {
      setApproveModal({
        isOpen: false,
        target: null,
        note: '',
        isSubmitting: false,
      });
    }
  };

  const handleReject = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = rejectModal.target;
    if (!target) return;

    const trimmedNote = rejectModal.note.trim();
    if (!trimmedNote) {
      setRejectModal((prev) => ({
        ...prev,
        error: 'Vui lòng nhập lý do từ chối (bắt buộc).',
      }));
      return;
    }

    setRejectModal((prev) => ({ ...prev, isSubmitting: true, error: null }));

    const prevRequests = [...requests];
    const prevPending = pendingCount;

    if (statusFilter === 'PENDING') {
      setRequests((prev) => prev.filter((r) => r.id !== target.id));
    } else {
      setRequests((prev) =>
        prev.map((r) =>
          r.id === target.id
            ? {
                ...r,
                status: 'REJECTED',
                decision_note: trimmedNote,
                decided_at: new Date().toISOString(),
              }
            : r,
        ),
      );
    }
    const newPending = Math.max(0, pendingCount - 1);
    setPendingCount(newPending);
    onPendingCountChange?.(newPending);

    try {
      const { error: apiErr, response } = await api.auth.POST(
        '/v1/admin/creator-requests/{request_id}/decision',
        {
          params: { path: { request_id: target.id } },
          body: {
            decision: 'REJECT',
            note: trimmedNote,
          },
        },
      );

      if (response.status === 409) {
        showToast({
          title: 'Yêu cầu này đã được xử lý trước đó.',
          type: 'warning',
        });
        await fetchRequests();
      } else if (!response.ok) {
        setRequests(prevRequests);
        setPendingCount(prevPending);
        onPendingCountChange?.(prevPending);
        showToast({
          title: (apiErr as Problem)?.detail || 'Không thể từ chối yêu cầu.',
          type: 'error',
        });
      } else {
        showToast({
          title: `Đã từ chối yêu cầu của @${target.user.handle}.`,
          type: 'info',
        });
      }
    } catch {
      setRequests(prevRequests);
      setPendingCount(prevPending);
      onPendingCountChange?.(prevPending);
      showToast({
        title: 'Lỗi mạng khi xử lý từ chối yêu cầu.',
        type: 'error',
      });
    } finally {
      setRejectModal({
        isOpen: false,
        target: null,
        note: '',
        isSubmitting: false,
        error: null,
      });
    }
  };

  if (!can.adminOnly) {
    return null;
  }

  return (
    <div className="space-y-6" data-testid="creator-requests-viewer">
      {/* Filters Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 bg-[#1f1f1f] border border-[#2e2e2e] p-4 rounded-2xl">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400 font-medium">Trạng thái:</label>
          <select
            aria-label="Lọc theo trạng thái yêu cầu sáng tạo"
            data-testid="creator-request-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="bg-[#292929] border border-[#3a3a3a] text-xs text-white rounded-lg px-3 py-1.5 focus:outline-none focus:border-red-500"
          >
            <option value="PENDING">Chờ duyệt ({pendingCount})</option>
            <option value="APPROVED">Đã duyệt</option>
            <option value="REJECTED">Đã từ chối</option>
            <option value="ALL">Tất cả trạng thái</option>
          </select>
        </div>

        <button
          onClick={() => fetchRequests()}
          data-testid="refresh-creator-requests-btn"
          className="flex items-center justify-center gap-1.5 text-xs text-gray-300 hover:text-white bg-[#292929] hover:bg-[#333] border border-[#3a3a3a] px-3.5 py-1.5 rounded-lg transition"
        >
          <RotateCw className="h-3.5 w-3.5" />
          <span>Làm mới</span>
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="flex items-center gap-2 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Table / List */}
      {isLoading ? (
        <div className="flex justify-center items-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-red-500" />
        </div>
      ) : requests.length === 0 ? (
        <div className="bg-[#1a1a1a] border border-[#2e2e2e] rounded-2xl p-12 text-center">
          <Sparkles className="h-10 w-10 text-gray-500 mx-auto mb-3" />
          <h3 className="text-sm font-semibold text-gray-300 mb-1">
            Không có yêu cầu sáng tạo nào
          </h3>
          <p className="text-xs text-gray-500">
            {statusFilter === 'PENDING'
              ? 'Tất cả các yêu cầu đã được xử lý xong!'
              : 'Chưa có dữ liệu cho bộ lọc này.'}
          </p>
        </div>
      ) : (
        <div className="bg-[#191919] border border-[#2a2a2a] rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#282828] bg-[#222] text-gray-400 uppercase tracking-wider text-[11px] font-semibold">
                  <th className="py-3 px-4">Người dùng</th>
                  <th className="py-3 px-4">Ngày tạo tài khoản</th>
                  <th className="py-3 px-4">Nội dung giới thiệu</th>
                  <th className="py-3 px-4">Thời gian gửi</th>
                  <th className="py-3 px-4">Trạng thái</th>
                  <th className="py-3 px-4 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#242424]">
                {requests.map((req) => (
                  <tr
                    key={req.id}
                    data-testid={`creator-request-row-${req.id}`}
                    className="hover:bg-[#202020] transition"
                  >
                    {/* User info */}
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        {req.user.avatar_url ? (
                          <img
                            src={req.user.avatar_url}
                            alt=""
                            className="h-9 w-9 rounded-full object-cover shrink-0"
                          />
                        ) : (
                          <div className="h-9 w-9 rounded-full bg-zinc-800 text-gray-300 flex items-center justify-center font-bold text-xs shrink-0">
                            {req.user.display_name.charAt(0)}
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="font-semibold text-gray-100 truncate">
                            {req.user.display_name}
                          </div>
                          <div className="text-[11px] text-gray-400 truncate">
                            @{req.user.handle}
                          </div>
                          <div className="text-[11px] text-gray-500 truncate">{req.user.email}</div>
                        </div>
                      </div>
                    </td>

                    {/* Account created */}
                    <td className="py-3.5 px-4 text-gray-400 whitespace-nowrap">
                      {new Date(req.user.created_at).toLocaleDateString('vi-VN')}
                    </td>

                    {/* Request message */}
                    <td className="py-3.5 px-4 max-w-xs sm:max-w-md">
                      <p className="text-gray-300 text-xs bg-[#121212] p-2.5 rounded-lg border border-[#2a2a2a] whitespace-pre-wrap line-clamp-3">
                        {req.message}
                      </p>
                      {req.decision_note && (
                        <div className="mt-1 text-[11px] text-gray-400">
                          <span className="font-semibold text-gray-500">Ghi chú:</span>{' '}
                          {req.decision_note}
                        </div>
                      )}
                    </td>

                    {/* Age / Submitted date */}
                    <td className="py-3.5 px-4 text-gray-400 whitespace-nowrap">
                      <div title={new Date(req.created_at).toLocaleString('vi-VN')}>
                        {formatRelativeTime(req.created_at)}
                      </div>
                      <div className="text-[10px] text-gray-500">
                        {new Date(req.created_at).toLocaleDateString('vi-VN')}
                      </div>
                    </td>

                    {/* Status Badge */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      {req.status === 'PENDING' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-950/60 text-amber-400 border border-amber-800/40">
                          <Clock className="h-3 w-3" />
                          <span>Chờ duyệt</span>
                        </span>
                      )}
                      {req.status === 'APPROVED' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-green-950/60 text-green-400 border border-green-800/40">
                          <Check className="h-3 w-3" />
                          <span>Đã duyệt</span>
                        </span>
                      )}
                      {req.status === 'REJECTED' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-red-950/60 text-red-400 border border-red-800/40">
                          <X className="h-3 w-3" />
                          <span>Đã từ chối</span>
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      {req.status === 'PENDING' ? (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            data-testid={`admin-approve-btn-${req.id}`}
                            onClick={() =>
                              setApproveModal({
                                isOpen: true,
                                target: req,
                                note: '',
                                isSubmitting: false,
                              })
                            }
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-500/30 font-semibold transition"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>Duyệt</span>
                          </button>
                          <button
                            type="button"
                            data-testid={`admin-reject-btn-${req.id}`}
                            onClick={() =>
                              setRejectModal({
                                isOpen: true,
                                target: req,
                                note: '',
                                isSubmitting: false,
                                error: null,
                              })
                            }
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 font-semibold transition"
                          >
                            <X className="h-3.5 w-3.5" />
                            <span>Từ chối</span>
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-gray-500">Đã giải quyết</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Approve Dialog (optional note) */}
      {approveModal.isOpen && approveModal.target && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget && !approveModal.isSubmitting) {
              setApproveModal({ isOpen: false, target: null, note: '', isSubmitting: false });
            }
          }}
        >
          <div className="w-full max-w-md rounded-2xl bg-[#1e1e1e] border border-[#333] p-6 shadow-2xl space-y-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Check className="h-5 w-5 text-green-500" />
              <span>Phê duyệt yêu cầu sáng tạo</span>
            </h3>
            <p className="text-xs text-gray-300">
              Bạn sắp cấp vai trò <span className="font-semibold text-green-400">Creator</span> cho
              người dùng{' '}
              <span className="font-semibold text-white">@{approveModal.target.user.handle}</span>.
            </p>

            <div>
              <label className="block text-xs text-gray-400 mb-1.5">
                Ghi chú phê duyệt (không bắt buộc):
              </label>
              <textarea
                rows={3}
                value={approveModal.note}
                onChange={(e) => setApproveModal((prev) => ({ ...prev, note: e.target.value }))}
                placeholder="Ví dụ: Chào mừng bạn gia nhập đội ngũ nhà sáng tạo Winkey!"
                className="w-full rounded-xl border border-[#3a3a3a] bg-[#141414] p-3 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={approveModal.isSubmitting}
                onClick={() =>
                  setApproveModal({ isOpen: false, target: null, note: '', isSubmitting: false })
                }
                className="px-4 py-2 rounded-xl text-xs font-semibold text-gray-300 hover:bg-[#2a2a2a] transition disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                type="button"
                data-testid="confirm-approve-btn"
                disabled={approveModal.isSubmitting}
                onClick={handleApprove}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-green-600 hover:bg-green-700 text-white transition disabled:opacity-50"
              >
                {approveModal.isSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                <span>Xác nhận duyệt</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Dialog (note is REQUIRED) */}
      {rejectModal.isOpen && rejectModal.target && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget && !rejectModal.isSubmitting) {
              setRejectModal({
                isOpen: false,
                target: null,
                note: '',
                isSubmitting: false,
                error: null,
              });
            }
          }}
        >
          <form
            onSubmit={handleReject}
            className="w-full max-w-md rounded-2xl bg-[#1e1e1e] border border-[#333] p-6 shadow-2xl space-y-4"
          >
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <X className="h-5 w-5 text-red-500" />
              <span>Từ chối yêu cầu sáng tạo</span>
            </h3>
            <p className="text-xs text-gray-300">
              Từ chối yêu cầu của{' '}
              <span className="font-semibold text-white">@{rejectModal.target.user.handle}</span>.
              Người dùng sẽ phải chờ 24 giờ trước khi có thể gửi lại yêu cầu.
            </p>

            {rejectModal.error && (
              <div className="flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-2.5 text-xs text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{rejectModal.error}</span>
              </div>
            )}

            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-semibold">
                Lý do từ chối <span className="text-red-500">* (Bắt buộc)</span>:
              </label>
              <textarea
                rows={3}
                required
                value={rejectModal.note}
                data-testid="admin-reject-note-input"
                onChange={(e) =>
                  setRejectModal((prev) => ({ ...prev, note: e.target.value, error: null }))
                }
                placeholder="Nêu rõ lý do hoặc tiêu chuẩn nội dung người dùng cần hoàn thiện..."
                className="w-full rounded-xl border border-[#3a3a3a] bg-[#141414] p-3 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={rejectModal.isSubmitting}
                onClick={() =>
                  setRejectModal({
                    isOpen: false,
                    target: null,
                    note: '',
                    isSubmitting: false,
                    error: null,
                  })
                }
                className="px-4 py-2 rounded-xl text-xs font-semibold text-gray-300 hover:bg-[#2a2a2a] transition disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                type="submit"
                data-testid="confirm-reject-btn"
                disabled={rejectModal.isSubmitting || !rejectModal.note.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-red-600 hover:bg-red-700 text-white transition disabled:opacity-50"
              >
                {rejectModal.isSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                <span>Xác nhận từ chối</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
