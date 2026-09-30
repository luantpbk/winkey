'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Clock,
  Eye,
  EyeOff,
  Filter,
  Flag,
  RotateCw,
  Video as VideoIcon,
  MessageSquare,
  User as UserIcon,
  X,
  ExternalLink,
} from 'lucide-react';
import type {
  ModerationCase,
  ReportTargetType,
  ReportReason,
  ReportStatus,
} from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { Link } from '../../i18n/routing';

interface ModerationModalState {
  isOpen: boolean;
  caseItem: ModerationCase | null;
  contentAction: 'KEEP' | 'HIDE' | 'RESTORE';
  actionReason: string;
  resolutionStatus: 'ACTIONED' | 'DISMISSED';
  resolutionNote: string;
  isSubmitting: boolean;
  step1Completed: boolean;
  step2Failed: boolean;
  errorMessage: string | null;
  successMessage: string | null;
}

export function ModerationQueue() {
  const t = useTranslations('admin.queue');
  const tReports = useTranslations('reports');

  const [cases, setCases] = useState<ModerationCase[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<ReportStatus>('OPEN');
  const [targetTypeFilter, setTargetTypeFilter] = useState<string>('ALL');

  // Modal state
  const [modalState, setModalState] = useState<ModerationModalState>({
    isOpen: false,
    caseItem: null,
    contentAction: 'HIDE',
    actionReason: '',
    resolutionStatus: 'ACTIONED',
    resolutionNote: '',
    isSubmitting: false,
    step1Completed: false,
    step2Failed: false,
    errorMessage: null,
    successMessage: null,
  });

  const modalRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  const fetchCases = useCallback(
    async (cursor?: string | null, append = false) => {
      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
        const queryParams: {
          status?: ReportStatus;
          target_type?: ReportTargetType;
          cursor?: string;
          limit?: number;
        } = {
          status: statusFilter,
          limit: 20,
        };

        if (targetTypeFilter !== 'ALL') {
          queryParams.target_type = targetTypeFilter as ReportTargetType;
        }
        if (cursor) {
          queryParams.cursor = cursor;
        }

        const { data, error: apiError } = await api.social.GET('/v1/moderation/reports', {
          params: {
            query: queryParams,
          },
        });

        if (apiError || !data) {
          setError('Failed to fetch moderation queue.');
        } else {
          setCases((prev) => (append ? [...prev, ...data.items] : data.items));
          setNextCursor(data.next_cursor);
        }
      } catch {
        setError('Network error loading moderation queue.');
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [statusFilter, targetTypeFilter],
  );

  useEffect(() => {
    fetchCases();
  }, [fetchCases]);

  // Modal open
  const openModal = (caseItem: ModerationCase) => {
    setModalState({
      isOpen: true,
      caseItem,
      contentAction: 'HIDE',
      actionReason: '',
      resolutionStatus: 'ACTIONED',
      resolutionNote: '',
      isSubmitting: false,
      step1Completed: false,
      step2Failed: false,
      errorMessage: null,
      successMessage: null,
    });
    setTimeout(() => {
      initialFocusRef.current?.focus();
    }, 50);
  };

  const closeModal = () => {
    if (modalState.isSubmitting) return;
    setModalState((prev) => ({ ...prev, isOpen: false, caseItem: null }));
  };

  // Keyboard trap ESC
  useEffect(() => {
    if (!modalState.isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !modalState.isSubmitting) {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [modalState.isOpen, modalState.isSubmitting]);

  // Execute Step 1 (Content Moderation)
  const executeStep1 = async (caseItem: ModerationCase): Promise<boolean> => {
    if (modalState.contentAction === 'KEEP') {
      return true; // No action needed on content
    }

    if (caseItem.target_type === 'VIDEO') {
      const state = modalState.contentAction === 'HIDE' ? 'HIDDEN' : 'VISIBLE';
      const reason = state === 'HIDDEN' ? modalState.actionReason.trim() : undefined;

      const { error: videoError } = await api.video.PUT('/v1/videos/{video_id}/moderation', {
        params: { path: { video_id: caseItem.target_id } },
        body: { state, reason },
      });

      if (videoError) {
        const problem = videoError as { detail?: string } | undefined;
        throw new Error(problem?.detail || 'Failed to update video moderation state.');
      }
      return true;
    }

    if (caseItem.target_type === 'COMMENT') {
      const status = modalState.contentAction === 'HIDE' ? 'HIDDEN' : 'VISIBLE';

      const { error: commentError } = await api.social.PUT('/v1/comments/{comment_id}/moderation', {
        params: { path: { comment_id: caseItem.target_id } },
        body: { status },
      });

      if (commentError) {
        const problem = commentError as { detail?: string } | undefined;
        throw new Error(problem?.detail || 'Failed to update comment moderation state.');
      }
      return true;
    }

    return true;
  };

  // Execute Step 2 (Resolve Moderation Case)
  const executeStep2 = async (caseItem: ModerationCase): Promise<void> => {
    const { error: resolveError } = await api.social.PUT(
      '/v1/moderation/cases/{target_type}/{target_id}/resolution',
      {
        params: {
          path: {
            target_type: caseItem.target_type,
            target_id: caseItem.target_id,
          },
        },
        body: {
          status: modalState.resolutionStatus,
          note: modalState.resolutionNote.trim() || undefined,
        },
      },
    );

    if (resolveError) {
      const problem = resolveError as { detail?: string } | undefined;
      throw new Error(problem?.detail || 'Failed to resolve moderation case.');
    }
  };

  // Full submit handler (Step 1 then Step 2)
  const handleModalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalState.caseItem) return;

    if (
      modalState.contentAction === 'HIDE' &&
      modalState.caseItem.target_type === 'VIDEO' &&
      !modalState.actionReason.trim()
    ) {
      setModalState((prev) => ({
        ...prev,
        errorMessage: 'Action reason is required when hiding a video.',
      }));
      return;
    }

    setModalState((prev) => ({
      ...prev,
      isSubmitting: true,
      errorMessage: null,
      successMessage: null,
      step2Failed: false,
    }));

    try {
      // Step 1: Content Moderation
      await executeStep1(modalState.caseItem);
      setModalState((prev) => ({ ...prev, step1Completed: true }));

      // Step 2: Resolution
      try {
        await executeStep2(modalState.caseItem);
        setModalState((prev) => ({
          ...prev,
          successMessage: t('actionSuccess'),
          isSubmitting: false,
        }));
        setTimeout(() => {
          closeModal();
          fetchCases();
        }, 1200);
      } catch (err: unknown) {
        // Step 1 succeeded, Step 2 failed -> Show retry for resolution only!
        const msg = err instanceof Error ? err.message : t('step2Failed');
        setModalState((prev) => ({
          ...prev,
          isSubmitting: false,
          step2Failed: true,
          errorMessage: msg,
        }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Moderation action failed.';
      setModalState((prev) => ({
        ...prev,
        isSubmitting: false,
        errorMessage: msg,
      }));
    }
  };

  // Retry ONLY Step 2
  const handleRetryStep2 = async () => {
    if (!modalState.caseItem) return;
    setModalState((prev) => ({
      ...prev,
      isSubmitting: true,
      errorMessage: null,
    }));

    try {
      await executeStep2(modalState.caseItem);
      setModalState((prev) => ({
        ...prev,
        successMessage: t('actionSuccess'),
        isSubmitting: false,
        step2Failed: false,
      }));
      setTimeout(() => {
        closeModal();
        fetchCases();
      }, 1200);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('step2Failed');
      setModalState((prev) => ({
        ...prev,
        isSubmitting: false,
        errorMessage: msg,
      }));
    }
  };

  const getTargetIcon = (targetType: ReportTargetType) => {
    switch (targetType) {
      case 'VIDEO':
        return <VideoIcon className="h-4 w-4 text-blue-400" />;
      case 'COMMENT':
        return <MessageSquare className="h-4 w-4 text-green-400" />;
      case 'USER':
        return <UserIcon className="h-4 w-4 text-purple-400" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Filter Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-[#1f1f1f] border border-[#2e2e2e] p-4 rounded-2xl">
        <div className="flex items-center gap-3">
          <Filter className="h-4 w-4 text-gray-400" />
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('filterTarget')}:</label>
            <select
              aria-label={t('filterTarget')}
              value={targetTypeFilter}
              onChange={(e) => setTargetTypeFilter(e.target.value)}
              className="bg-[#292929] border border-[#3a3a3a] text-xs text-white rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-red-500"
            >
              <option value="ALL">{t('allTargets')}</option>
              <option value="VIDEO">{t('videoTarget')}</option>
              <option value="COMMENT">{t('commentTarget')}</option>
              <option value="USER">{t('userTarget')}</option>
            </select>
          </div>

          <div className="flex items-center gap-2 ml-2">
            <label className="text-xs text-gray-400 font-medium">{t('filterStatus')}:</label>
            <select
              aria-label={t('filterStatus')}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as ReportStatus)}
              className="bg-[#292929] border border-[#3a3a3a] text-xs text-white rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-red-500"
            >
              <option value="OPEN">{t('statusOpen')}</option>
              <option value="ACTIONED">{t('statusActioned')}</option>
              <option value="DISMISSED">{t('statusDismissed')}</option>
            </select>
          </div>
        </div>

        <button
          onClick={() => fetchCases()}
          className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white bg-[#292929] hover:bg-[#333] border border-[#3a3a3a] px-3 py-1.5 rounded-lg transition"
        >
          <RotateCw className="h-3.5 w-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Case list */}
      {isLoading ? (
        <div className="flex justify-center items-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
        </div>
      ) : cases.length === 0 ? (
        <div className="bg-[#181818] border border-[#292929] rounded-2xl p-12 text-center">
          <CheckCircle className="h-10 w-10 text-green-500/80 mx-auto mb-3" />
          <p className="text-sm font-semibold text-gray-300">{t('empty')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {cases.map((c) => {
            const caseKey = `${c.target_type}-${c.target_id}`;
            return (
              <div
                key={caseKey}
                className="bg-[#1a1a1a] border border-[#2b2b2b] hover:border-[#383838] transition rounded-2xl p-5 shadow-sm space-y-4"
              >
                {/* Top bar: target info & actions */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-[#292929]">
                  <div className="flex items-center gap-2.5">
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[#262626] border border-[#383838] text-gray-300">
                      {getTargetIcon(c.target_type)}
                      <span>{c.target_type}</span>
                    </span>

                    <span className="text-xs font-mono text-gray-400">ID: {c.target_id}</span>

                    {c.target_type === 'VIDEO' && (
                      <Link
                        href={`/watch/${c.target_id}`}
                        target="_blank"
                        className="text-gray-400 hover:text-blue-400 transition"
                        title="View video"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border ${
                        c.status === 'OPEN'
                          ? 'bg-red-500/10 text-red-400 border-red-500/30'
                          : c.status === 'ACTIONED'
                            ? 'bg-green-500/10 text-green-400 border-green-500/30'
                            : 'bg-gray-500/10 text-gray-400 border-gray-500/30'
                      }`}
                    >
                      {c.status}
                    </span>

                    {c.status === 'OPEN' && (
                      <button
                        onClick={() => openModal(c)}
                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold shadow-sm transition"
                      >
                        <Flag className="h-3.5 w-3.5" />
                        <span>{t('actionButton')}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Case stats & reasons */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="bg-[#202020] border border-[#2d2d2d] rounded-xl p-3 flex flex-col justify-center">
                    <span className="text-gray-400 font-medium">
                      {t('openCount', { count: c.open_count })}
                    </span>
                    <span className="text-[11px] text-gray-500 flex items-center gap-1 mt-1">
                      <Clock className="h-3 w-3" />
                      <span>
                        {t('firstReported', {
                          time: new Date(c.first_reported_at).toLocaleString(),
                        })}
                      </span>
                    </span>
                  </div>

                  <div className="md:col-span-2 bg-[#202020] border border-[#2d2d2d] rounded-xl p-3">
                    <span className="text-gray-400 font-medium block mb-2">{t('reasons')}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(c.reasons || {}).map(([reason, count]) => (
                        <span
                          key={reason}
                          className="px-2 py-0.5 rounded-md bg-[#2d2d2d] text-gray-300 text-[11px] font-medium border border-[#3b3b3b]"
                        >
                          {tReports(`reasons.${reason as ReportReason}`) || reason}:{' '}
                          <strong className="text-red-400">{count}</strong>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Recent reports list */}
                {c.reports && c.reports.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <span className="text-xs font-semibold text-gray-400">
                      {t('recentReports')}
                    </span>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                      {c.reports.map((report) => (
                        <div
                          key={report.id}
                          className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 bg-[#222] border border-[#2c2c2c] rounded-lg p-2.5 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-gray-300">
                              {report.reporter?.display_name || t('reporter')}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-300 border border-red-800/40">
                              {tReports(`reasons.${report.reason as ReportReason}`) ||
                                report.reason}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-gray-400 italic line-clamp-1">
                              {report.note ? `"${report.note}"` : t('noNote')}
                            </span>
                            <span className="text-[10px] text-gray-500 whitespace-nowrap">
                              {new Date(report.created_at).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Pagination */}
          {nextCursor && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => fetchCases(nextCursor, true)}
                disabled={isLoadingMore}
                className="px-6 py-2 rounded-xl bg-[#242424] hover:bg-[#2e2e2e] text-xs font-semibold text-gray-200 border border-[#383838] transition disabled:opacity-50"
              >
                {isLoadingMore ? 'Loading...' : t('loadMore')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Moderation Action Modal */}
      {modalState.isOpen && modalState.caseItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget && !modalState.isSubmitting) closeModal();
          }}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="moderation-modal-title"
            className="w-full max-w-lg rounded-2xl border border-[#333] bg-[#1a1a1a] p-6 shadow-2xl text-gray-100 animate-scale-in max-h-[90vh] overflow-y-auto"
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-[#2e2e2e]">
              <div className="flex items-center gap-2 text-red-500">
                <Flag className="h-5 w-5" />
                <h2 id="moderation-modal-title" className="text-base font-bold text-white">
                  {t('modalTitle')}
                </h2>
              </div>
              <button
                ref={initialFocusRef}
                type="button"
                onClick={closeModal}
                disabled={modalState.isSubmitting}
                className="rounded-lg p-1 text-gray-400 hover:text-white hover:bg-[#2c2c2c] transition disabled:opacity-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Target identifier info */}
            <div className="mt-3 p-3 rounded-xl bg-[#222] border border-[#2e2e2e] text-xs flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-gray-300 font-medium">
                {getTargetIcon(modalState.caseItem.target_type)}
                <span>{modalState.caseItem.target_type}</span>
              </span>
              <span className="font-mono text-gray-400 text-[11px]">
                {modalState.caseItem.target_id}
              </span>
            </div>

            {/* Alerts */}
            {modalState.errorMessage && (
              <div className="mt-4 flex items-start gap-2.5 rounded-xl p-3.5 text-xs font-medium bg-red-500/10 border border-red-500/30 text-red-400">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{modalState.errorMessage}</span>
              </div>
            )}

            {modalState.successMessage && (
              <div className="mt-4 flex items-start gap-2.5 rounded-xl p-3.5 text-xs font-medium bg-green-500/10 border border-green-500/30 text-green-400">
                <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{modalState.successMessage}</span>
              </div>
            )}

            {modalState.step1Completed && !modalState.step2Failed && !modalState.successMessage && (
              <div className="mt-4 flex items-center gap-2 rounded-xl p-2.5 text-xs font-medium bg-blue-500/10 border border-blue-500/30 text-blue-400">
                <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{t('step1Success')}</span>
              </div>
            )}

            {/* Dedicated Retry Button if Step 2 Failed */}
            {modalState.step2Failed ? (
              <div className="mt-5 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-3">
                <p className="text-xs text-amber-300 font-medium">{t('step2Failed')}</p>
                <button
                  type="button"
                  onClick={handleRetryStep2}
                  disabled={modalState.isSubmitting}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs transition disabled:opacity-50"
                >
                  {modalState.isSubmitting ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    <RotateCw className="h-4 w-4" />
                  )}
                  <span>{t('retryResolution')}</span>
                </button>
              </div>
            ) : (
              <form onSubmit={handleModalSubmit} className="mt-4 space-y-4">
                {/* Step 1: Content Action */}
                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-2">
                    {t('chooseAction')}
                  </label>
                  <div className="space-y-1.5 text-xs">
                    <label
                      className={`flex items-center gap-2.5 p-2.5 rounded-xl border cursor-pointer transition ${
                        modalState.contentAction === 'HIDE'
                          ? 'border-red-500/80 bg-red-500/10 text-white font-medium'
                          : 'border-[#2d2d2d] bg-[#222] text-gray-300 hover:bg-[#272727]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="contentAction"
                        value="HIDE"
                        checked={modalState.contentAction === 'HIDE'}
                        onChange={() =>
                          setModalState((prev) => ({ ...prev, contentAction: 'HIDE' }))
                        }
                        className="h-3.5 w-3.5 text-red-600"
                      />
                      <EyeOff className="h-3.5 w-3.5 text-red-400" />
                      <span>{t('hideTarget')}</span>
                    </label>

                    <label
                      className={`flex items-center gap-2.5 p-2.5 rounded-xl border cursor-pointer transition ${
                        modalState.contentAction === 'RESTORE'
                          ? 'border-green-500/80 bg-green-500/10 text-white font-medium'
                          : 'border-[#2d2d2d] bg-[#222] text-gray-300 hover:bg-[#272727]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="contentAction"
                        value="RESTORE"
                        checked={modalState.contentAction === 'RESTORE'}
                        onChange={() =>
                          setModalState((prev) => ({ ...prev, contentAction: 'RESTORE' }))
                        }
                        className="h-3.5 w-3.5 text-green-600"
                      />
                      <Eye className="h-3.5 w-3.5 text-green-400" />
                      <span>{t('restoreTarget')}</span>
                    </label>

                    <label
                      className={`flex items-center gap-2.5 p-2.5 rounded-xl border cursor-pointer transition ${
                        modalState.contentAction === 'KEEP'
                          ? 'border-blue-500/80 bg-blue-500/10 text-white font-medium'
                          : 'border-[#2d2d2d] bg-[#222] text-gray-300 hover:bg-[#272727]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="contentAction"
                        value="KEEP"
                        checked={modalState.contentAction === 'KEEP'}
                        onChange={() =>
                          setModalState((prev) => ({ ...prev, contentAction: 'KEEP' }))
                        }
                        className="h-3.5 w-3.5 text-blue-600"
                      />
                      <span>{t('keepTarget')}</span>
                    </label>
                  </div>
                </div>

                {/* Reason when hiding */}
                {modalState.contentAction === 'HIDE' && (
                  <div>
                    <label
                      htmlFor="action-reason"
                      className="block text-xs font-semibold text-gray-300 mb-1"
                    >
                      {t('actionReason')}{' '}
                      {modalState.caseItem.target_type === 'VIDEO' && (
                        <span className="text-red-500">*</span>
                      )}
                    </label>
                    <input
                      id="action-reason"
                      type="text"
                      maxLength={500}
                      value={modalState.actionReason}
                      onChange={(e) =>
                        setModalState((prev) => ({
                          ...prev,
                          actionReason: e.target.value,
                        }))
                      }
                      placeholder={t('actionReasonPlaceholder')}
                      className="w-full rounded-xl border border-[#333] bg-[#222] p-2.5 text-xs text-white placeholder-gray-500 focus:border-red-500 focus:outline-none"
                    />
                  </div>
                )}

                {/* Step 2: Resolution Decision */}
                <div className="pt-2 border-t border-[#2a2a2a]">
                  <label className="block text-xs font-semibold text-gray-300 mb-2">
                    {t('resolution')}
                  </label>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label
                      className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer transition ${
                        modalState.resolutionStatus === 'ACTIONED'
                          ? 'border-red-500 bg-red-500/10 text-white font-medium'
                          : 'border-[#2d2d2d] bg-[#222] text-gray-400 hover:bg-[#272727]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="resolutionStatus"
                        value="ACTIONED"
                        checked={modalState.resolutionStatus === 'ACTIONED'}
                        onChange={() =>
                          setModalState((prev) => ({
                            ...prev,
                            resolutionStatus: 'ACTIONED',
                          }))
                        }
                        className="h-3.5 w-3.5 text-red-600"
                      />
                      <span>{t('resolutionActioned')}</span>
                    </label>

                    <label
                      className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer transition ${
                        modalState.resolutionStatus === 'DISMISSED'
                          ? 'border-gray-400 bg-gray-500/10 text-white font-medium'
                          : 'border-[#2d2d2d] bg-[#222] text-gray-400 hover:bg-[#272727]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="resolutionStatus"
                        value="DISMISSED"
                        checked={modalState.resolutionStatus === 'DISMISSED'}
                        onChange={() =>
                          setModalState((prev) => ({
                            ...prev,
                            resolutionStatus: 'DISMISSED',
                          }))
                        }
                        className="h-3.5 w-3.5 text-gray-400"
                      />
                      <span>{t('resolutionDismissed')}</span>
                    </label>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="resolution-note"
                    className="block text-xs font-semibold text-gray-300 mb-1"
                  >
                    {t('resolutionNote')}
                  </label>
                  <textarea
                    id="resolution-note"
                    rows={2}
                    maxLength={500}
                    value={modalState.resolutionNote}
                    onChange={(e) =>
                      setModalState((prev) => ({
                        ...prev,
                        resolutionNote: e.target.value,
                      }))
                    }
                    placeholder={t('resolutionNotePlaceholder')}
                    className="w-full rounded-xl border border-[#333] bg-[#222] p-2.5 text-xs text-white placeholder-gray-500 focus:border-red-500 focus:outline-none resize-none"
                  />
                </div>

                {/* Footer Buttons */}
                <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-[#2a2a2a]">
                  <button
                    type="button"
                    onClick={closeModal}
                    disabled={modalState.isSubmitting}
                    className="rounded-xl px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white hover:bg-[#2c2c2c] transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      modalState.isSubmitting ||
                      (modalState.contentAction === 'HIDE' &&
                        modalState.caseItem.target_type === 'VIDEO' &&
                        !modalState.actionReason.trim())
                    }
                    className="flex items-center gap-1.5 rounded-xl bg-red-600 px-5 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {modalState.isSubmitting ? (
                      <>
                        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        <span>Processing...</span>
                      </>
                    ) : (
                      <span>{t('confirmAction')}</span>
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
