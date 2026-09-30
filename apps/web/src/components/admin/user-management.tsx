'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Clock,
  Lock,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Unlock,
  UserCheck,
  UserX,
  X,
  RotateCw,
} from 'lucide-react';
import type { AdminUser, Role, UserStatus, Problem } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';

export function UserManagement() {
  const t = useTranslations('admin.users');
  const { user: currentUser, isAdmin, isModerator } = useAuth();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Debounce search query (300 ms)
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(searchQuery.trim());
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  // Modals state
  const [suspendModal, setSuspendModal] = useState<{
    isOpen: boolean;
    targetUser: AdminUser | null;
    reason: string;
    isIndefinite: boolean;
    untilLocal: string;
    isSubmitting: boolean;
    error: string | null;
    success: string | null;
  }>({
    isOpen: false,
    targetUser: null,
    reason: '',
    isIndefinite: true,
    untilLocal: '',
    isSubmitting: false,
    error: null,
    success: null,
  });

  const [rolesModal, setRolesModal] = useState<{
    isOpen: boolean;
    targetUser: AdminUser | null;
    selectedRoles: Role[];
    isSubmitting: boolean;
    error: string | null;
    success: string | null;
  }>({
    isOpen: false,
    targetUser: null,
    selectedRoles: ['viewer'],
    isSubmitting: false,
    error: null,
    success: null,
  });

  const [unsuspendConfirm, setUnsuspendConfirm] = useState<{
    isOpen: boolean;
    targetUser: AdminUser | null;
    isSubmitting: boolean;
    error: string | null;
  }>({
    isOpen: false,
    targetUser: null,
    isSubmitting: false,
    error: null,
  });

  const suspendInputRef = useRef<HTMLInputElement>(null);
  const rolesModalRef = useRef<HTMLDivElement>(null);

  const fetchUsers = useCallback(
    async (cursor?: string | null, append = false) => {
      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
        const queryParams: {
          q?: string;
          role?: Role;
          status?: UserStatus;
          cursor?: string;
          limit?: number;
        } = {
          limit: 20,
        };

        if (debouncedQuery.length >= 2) {
          queryParams.q = debouncedQuery;
        }
        if (roleFilter !== 'ALL') {
          queryParams.role = roleFilter as Role;
        }
        if (statusFilter !== 'ALL') {
          queryParams.status = statusFilter as UserStatus;
        }
        if (cursor) {
          queryParams.cursor = cursor;
        }

        const { data, error: apiError } = await api.auth.GET('/v1/admin/users', {
          params: { query: queryParams },
        });

        if (apiError || !data) {
          setError('Failed to fetch users.');
        } else {
          setUsers((prev) => (append ? [...prev, ...data.items] : data.items));
          setNextCursor(data.next_cursor);
        }
      } catch {
        setError('Network error loading users.');
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [debouncedQuery, roleFilter, statusFilter],
  );

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // Error code mapper helper
  const mapProblemError = (err: unknown, defaultMessage: string): string => {
    if (!err || typeof err !== 'object') return defaultMessage;
    const problem = err as Problem;
    if (problem.code === 'CANNOT_MODERATE_TARGET') {
      return t('cannotModerateTarget');
    }
    if (problem.code === 'LAST_ADMIN') {
      return t('lastAdmin');
    }
    if (problem.status === 409 || problem.code === 'DELETED') {
      return t('userDeleted');
    }
    return problem.detail || defaultMessage;
  };

  // Check if current user can moderate target user
  const canModerateUser = (target: AdminUser): { allowed: boolean; reason?: string } => {
    // Cannot moderate yourself
    if (currentUser?.id === target.id) {
      return { allowed: false, reason: t('cannotModerateTarget') };
    }

    // Target is deleted
    if (target.status === 'DELETED') {
      return { allowed: false, reason: t('userDeleted') };
    }

    // Nobody can moderate admins
    if (target.roles.includes('admin')) {
      return { allowed: false, reason: t('cannotModerateTarget') };
    }

    // If current user is a moderator (not admin), they can only moderate viewers & creators
    if (isModerator && !isAdmin) {
      if (target.roles.includes('moderator')) {
        return { allowed: false, reason: t('cannotModerateTarget') };
      }
    }

    return { allowed: true };
  };

  // Open Suspend Modal
  const openSuspendModal = (user: AdminUser) => {
    const { allowed } = canModerateUser(user);
    if (!allowed) return;

    setSuspendModal({
      isOpen: true,
      targetUser: user,
      reason: user.suspension_reason || '',
      isIndefinite: !user.suspended_until,
      untilLocal: user.suspended_until
        ? new Date(user.suspended_until).toISOString().slice(0, 16)
        : '',
      isSubmitting: false,
      error: null,
      success: null,
    });
    setTimeout(() => {
      suspendInputRef.current?.focus();
    }, 50);
  };

  const closeSuspendModal = () => {
    if (suspendModal.isSubmitting) return;
    setSuspendModal((prev) => ({ ...prev, isOpen: false, targetUser: null }));
  };

  const handleSuspendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!suspendModal.targetUser) return;

    const trimmedReason = suspendModal.reason.trim();
    if (!trimmedReason) {
      setSuspendModal((prev) => ({
        ...prev,
        error: t('suspendReason'),
      }));
      return;
    }

    let untilUtc: string | undefined = undefined;
    if (!suspendModal.isIndefinite && suspendModal.untilLocal) {
      untilUtc = new Date(suspendModal.untilLocal).toISOString();
    }

    setSuspendModal((prev) => ({
      ...prev,
      isSubmitting: true,
      error: null,
      success: null,
    }));

    try {
      const { error: apiError } = await api.auth.PUT('/v1/admin/users/{user_id}/suspension', {
        params: { path: { user_id: suspendModal.targetUser.id } },
        body: {
          reason: trimmedReason,
          until: untilUtc,
        },
      });

      if (apiError) {
        setSuspendModal((prev) => ({
          ...prev,
          isSubmitting: false,
          error: mapProblemError(apiError, 'Failed to suspend user.'),
        }));
      } else {
        setSuspendModal((prev) => ({
          ...prev,
          isSubmitting: false,
          success: t('suspendSuccess'),
        }));
        setTimeout(() => {
          closeSuspendModal();
          fetchUsers();
        }, 1200);
      }
    } catch (err: unknown) {
      setSuspendModal((prev) => ({
        ...prev,
        isSubmitting: false,
        error: mapProblemError(err, 'Failed to suspend user.'),
      }));
    }
  };

  // Unsuspend flow
  const handleUnsuspend = async (user: AdminUser) => {
    const { allowed } = canModerateUser(user);
    if (!allowed) return;

    setUnsuspendConfirm({
      isOpen: true,
      targetUser: user,
      isSubmitting: false,
      error: null,
    });
  };

  const confirmUnsuspend = async () => {
    if (!unsuspendConfirm.targetUser) return;

    setUnsuspendConfirm((prev) => ({
      ...prev,
      isSubmitting: true,
      error: null,
    }));

    try {
      const { error: apiError } = await api.auth.DELETE('/v1/admin/users/{user_id}/suspension', {
        params: { path: { user_id: unsuspendConfirm.targetUser.id } },
      });

      if (apiError) {
        setUnsuspendConfirm((prev) => ({
          ...prev,
          isSubmitting: false,
          error: mapProblemError(apiError, 'Failed to unsuspend user.'),
        }));
      } else {
        setUnsuspendConfirm({
          isOpen: false,
          targetUser: null,
          isSubmitting: false,
          error: null,
        });
        fetchUsers();
      }
    } catch (err: unknown) {
      setUnsuspendConfirm((prev) => ({
        ...prev,
        isSubmitting: false,
        error: mapProblemError(err, 'Failed to unsuspend user.'),
      }));
    }
  };

  // Role Editor Flow (Admin only)
  const openRolesModal = (user: AdminUser) => {
    if (!isAdmin) return;
    if (currentUser?.id === user.id) return;

    setRolesModal({
      isOpen: true,
      targetUser: user,
      selectedRoles: [...user.roles],
      isSubmitting: false,
      error: null,
      success: null,
    });
  };

  const closeRolesModal = () => {
    if (rolesModal.isSubmitting) return;
    setRolesModal((prev) => ({ ...prev, isOpen: false, targetUser: null }));
  };

  const handleRoleToggle = (role: Role) => {
    if (role === 'viewer') return; // Viewer is immutable

    setRolesModal((prev) => {
      const exists = prev.selectedRoles.includes(role);
      const nextRoles = exists
        ? prev.selectedRoles.filter((r) => r !== role)
        : [...prev.selectedRoles, role];
      return { ...prev, selectedRoles: nextRoles };
    });
  };

  const handleRolesSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rolesModal.targetUser) return;

    setRolesModal((prev) => ({
      ...prev,
      isSubmitting: true,
      error: null,
      success: null,
    }));

    try {
      const { error: apiError } = await api.auth.PUT('/v1/admin/users/{user_id}/roles', {
        params: { path: { user_id: rolesModal.targetUser.id } },
        body: { roles: rolesModal.selectedRoles },
      });

      if (apiError) {
        setRolesModal((prev) => ({
          ...prev,
          isSubmitting: false,
          error: mapProblemError(apiError, 'Failed to update roles.'),
        }));
      } else {
        setRolesModal((prev) => ({
          ...prev,
          isSubmitting: false,
          success: t('rolesSuccess'),
        }));
        setTimeout(() => {
          closeRolesModal();
          fetchUsers();
        }, 1200);
      }
    } catch (err: unknown) {
      setRolesModal((prev) => ({
        ...prev,
        isSubmitting: false,
        error: mapProblemError(err, 'Failed to update roles.'),
      }));
    }
  };

  // Keyboard trap ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (suspendModal.isOpen && !suspendModal.isSubmitting) closeSuspendModal();
        if (rolesModal.isOpen && !rolesModal.isSubmitting) closeRolesModal();
        if (unsuspendConfirm.isOpen && !unsuspendConfirm.isSubmitting) {
          setUnsuspendConfirm({
            isOpen: false,
            targetUser: null,
            isSubmitting: false,
            error: null,
          });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    suspendModal.isOpen,
    suspendModal.isSubmitting,
    rolesModal.isOpen,
    rolesModal.isSubmitting,
    unsuspendConfirm.isOpen,
    unsuspendConfirm.isSubmitting,
  ]);

  const getStatusBadge = (user: AdminUser) => {
    switch (user.status) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-500/10 text-green-400 border border-green-500/30">
            <UserCheck className="h-3 w-3" />
            <span>{t('statusActive')}</span>
          </span>
        );
      case 'SUSPENDED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/30">
            <UserX className="h-3 w-3" />
            <span>{t('statusSuspended')}</span>
          </span>
        );
      case 'DELETED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-500/10 text-gray-400 border border-gray-500/30">
            <span>{t('statusDeleted')}</span>
          </span>
        );
    }
  };

  const getRoleBadge = (role: Role) => {
    switch (role) {
      case 'admin':
        return (
          <span
            key={role}
            className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-red-900/40 text-red-300 border border-red-700/50"
          >
            admin
          </span>
        );
      case 'moderator':
        return (
          <span
            key={role}
            className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-purple-900/40 text-purple-300 border border-purple-700/50"
          >
            moderator
          </span>
        );
      case 'creator':
        return (
          <span
            key={role}
            className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-blue-900/40 text-blue-300 border border-blue-700/50"
          >
            creator
          </span>
        );
      case 'viewer':
      default:
        return (
          <span
            key={role}
            className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-gray-800 text-gray-300 border border-gray-700"
          >
            viewer
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Search and Filters Bar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 bg-[#1f1f1f] border border-[#2e2e2e] p-4 rounded-2xl">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full pl-10 pr-4 py-2 bg-[#292929] border border-[#3a3a3a] rounded-xl text-xs text-white placeholder-gray-500 focus:outline-none focus:border-red-500 transition"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('filterRole')}:</label>
            <select
              aria-label={t('filterRole')}
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="bg-[#292929] border border-[#3a3a3a] text-xs text-white rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-red-500"
            >
              <option value="ALL">{t('allRoles')}</option>
              <option value="viewer">Viewer</option>
              <option value="creator">Creator</option>
              <option value="moderator">Moderator</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('filterStatus')}:</label>
            <select
              aria-label={t('filterStatus')}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-[#292929] border border-[#3a3a3a] text-xs text-white rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-red-500"
            >
              <option value="ALL">{t('allStatuses')}</option>
              <option value="ACTIVE">{t('statusActive')}</option>
              <option value="SUSPENDED">{t('statusSuspended')}</option>
              <option value="DELETED">{t('statusDeleted')}</option>
            </select>
          </div>

          <button
            onClick={() => fetchUsers()}
            className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white bg-[#292929] hover:bg-[#333] border border-[#3a3a3a] px-3 py-1.5 rounded-lg transition"
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Error notification */}
      {error && (
        <div className="flex items-center gap-2 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Users Table / List */}
      {isLoading ? (
        <div className="flex justify-center items-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
        </div>
      ) : users.length === 0 ? (
        <div className="bg-[#181818] border border-[#292929] rounded-2xl p-12 text-center">
          <UserX className="h-10 w-10 text-gray-500 mx-auto mb-3" />
          <p className="text-sm font-semibold text-gray-300">{t('empty')}</p>
        </div>
      ) : (
        <div className="bg-[#181818] border border-[#292929] rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#222] border-b border-[#2e2e2e] text-gray-400 uppercase font-semibold">
                <tr>
                  <th className="py-3 px-4">{t('tableUser')}</th>
                  <th className="py-3 px-4">{t('tableRoles')}</th>
                  <th className="py-3 px-4">{t('tableStatus')}</th>
                  <th className="py-3 px-4">{t('tableCreated')}</th>
                  <th className="py-3 px-4 text-right">{t('tableActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#262626]">
                {users.map((target) => {
                  const modCheck = canModerateUser(target);
                  const isSelf = currentUser?.id === target.id;

                  return (
                    <tr key={target.id} className="hover:bg-[#1f1f1f]/50 transition">
                      {/* User Column */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-gray-700 to-gray-600 flex items-center justify-center font-bold text-white uppercase shrink-0">
                            {target.display_name.charAt(0) || target.handle.charAt(0)}
                          </div>
                          <div>
                            <div className="font-semibold text-white flex items-center gap-1.5">
                              <span>{target.display_name}</span>
                              {isSelf && (
                                <span className="text-[10px] text-gray-400 font-normal italic">
                                  (you)
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-gray-400">
                              @{target.handle} &bull; {target.email}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Roles Column */}
                      <td className="py-3.5 px-4">
                        <div className="flex flex-wrap gap-1">{target.roles.map(getRoleBadge)}</div>
                      </td>

                      {/* Status Column with suspension details */}
                      <td className="py-3.5 px-4">
                        <div className="space-y-1">
                          <div>{getStatusBadge(target)}</div>
                          {target.status === 'SUSPENDED' && (
                            <div className="text-[10px] text-gray-400 space-y-0.5">
                              {target.suspension_reason && (
                                <div className="italic line-clamp-1">
                                  {t('suspensionReason', { reason: target.suspension_reason })}
                                </div>
                              )}
                              <div className="flex items-center gap-1 text-gray-500">
                                <Clock className="h-2.5 w-2.5" />
                                <span>
                                  {target.suspended_until
                                    ? t('suspendedUntil', {
                                        date: new Date(target.suspended_until).toLocaleString(),
                                      })
                                    : t('suspendedIndefinite')}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Created At */}
                      <td className="py-3.5 px-4 text-gray-400 whitespace-nowrap">
                        {new Date(target.created_at).toLocaleDateString()}
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {/* Suspend / Unsuspend */}
                          {target.status === 'SUSPENDED' ? (
                            <button
                              onClick={() => handleUnsuspend(target)}
                              disabled={!modCheck.allowed}
                              title={modCheck.reason}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-500/30 font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Unlock className="h-3 w-3" />
                              <span>{t('unsuspend')}</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => openSuspendModal(target)}
                              disabled={!modCheck.allowed || target.status === 'DELETED'}
                              title={modCheck.reason}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Lock className="h-3 w-3" />
                              <span>{t('suspend')}</span>
                            </button>
                          )}

                          {/* Edit Roles (Admin only, never on self, never on deleted) */}
                          {isAdmin && (
                            <button
                              onClick={() => openRolesModal(target)}
                              disabled={isSelf || target.status === 'DELETED'}
                              title={
                                isSelf
                                  ? t('cannotModerateTarget')
                                  : target.status === 'DELETED'
                                    ? t('userDeleted')
                                    : undefined
                              }
                              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#2c2c2c] hover:bg-[#363636] text-gray-200 border border-[#404040] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Shield className="h-3 w-3 text-purple-400" />
                              <span>{t('editRoles')}</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {nextCursor && (
            <div className="flex justify-center p-4 border-t border-[#292929]">
              <button
                onClick={() => fetchUsers(nextCursor, true)}
                disabled={isLoadingMore}
                className="px-6 py-2 rounded-xl bg-[#242424] hover:bg-[#2e2e2e] text-xs font-semibold text-gray-200 border border-[#383838] transition disabled:opacity-50"
              >
                {isLoadingMore ? 'Loading...' : t('loadMore')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Suspend Modal */}
      {suspendModal.isOpen && suspendModal.targetUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget && !suspendModal.isSubmitting) {
              closeSuspendModal();
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="suspend-modal-title"
            className="w-full max-w-md rounded-2xl border border-[#333] bg-[#1a1a1a] p-6 shadow-2xl text-gray-100 animate-scale-in"
          >
            <div className="flex items-center justify-between pb-4 border-b border-[#2e2e2e]">
              <div className="flex items-center gap-2 text-red-500">
                <ShieldAlert className="h-5 w-5" />
                <h2 id="suspend-modal-title" className="text-base font-bold text-white">
                  {t('suspendModalTitle')}
                </h2>
              </div>
              <button
                type="button"
                onClick={closeSuspendModal}
                disabled={suspendModal.isSubmitting}
                className="rounded-lg p-1 text-gray-400 hover:text-white hover:bg-[#2c2c2c] transition"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-3 p-3 rounded-xl bg-[#222] border border-[#2e2e2e] text-xs">
              <span className="font-semibold text-white">
                {suspendModal.targetUser.display_name}
              </span>{' '}
              <span className="text-gray-400">(@{suspendModal.targetUser.handle})</span>
            </div>

            {suspendModal.error && (
              <div className="mt-4 flex items-start gap-2 rounded-xl p-3 text-xs bg-red-500/10 border border-red-500/30 text-red-400">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{suspendModal.error}</span>
              </div>
            )}

            {suspendModal.success && (
              <div className="mt-4 flex items-start gap-2 rounded-xl p-3 text-xs bg-green-500/10 border border-green-500/30 text-green-400">
                <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{suspendModal.success}</span>
              </div>
            )}

            <form onSubmit={handleSuspendSubmit} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="suspend-reason-input"
                  className="block text-xs font-semibold text-gray-300 mb-1"
                >
                  {t('suspendReason')} <span className="text-red-500">*</span>
                </label>
                <input
                  ref={suspendInputRef}
                  id="suspend-reason-input"
                  type="text"
                  required
                  maxLength={500}
                  value={suspendModal.reason}
                  onChange={(e) => setSuspendModal((prev) => ({ ...prev, reason: e.target.value }))}
                  placeholder={t('suspendReasonPlaceholder')}
                  className="w-full rounded-xl border border-[#333] bg-[#222] p-2.5 text-xs text-white placeholder-gray-500 focus:border-red-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={suspendModal.isIndefinite}
                    onChange={(e) =>
                      setSuspendModal((prev) => ({
                        ...prev,
                        isIndefinite: e.target.checked,
                      }))
                    }
                    className="h-3.5 w-3.5 text-red-600 rounded bg-[#222] border-gray-600"
                  />
                  <span>{t('suspendedIndefinite')}</span>
                </label>
              </div>

              {!suspendModal.isIndefinite && (
                <div>
                  <label
                    htmlFor="suspend-until-input"
                    className="block text-xs font-semibold text-gray-300 mb-1"
                  >
                    {t('suspendUntil')}
                  </label>
                  <input
                    id="suspend-until-input"
                    type="datetime-local"
                    value={suspendModal.untilLocal}
                    onChange={(e) =>
                      setSuspendModal((prev) => ({
                        ...prev,
                        untilLocal: e.target.value,
                      }))
                    }
                    className="w-full rounded-xl border border-[#333] bg-[#222] p-2.5 text-xs text-white focus:border-red-500 focus:outline-none"
                  />
                </div>
              )}

              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-[#2a2a2a]">
                <button
                  type="button"
                  onClick={closeSuspendModal}
                  disabled={suspendModal.isSubmitting}
                  className="rounded-xl px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white hover:bg-[#2c2c2c] transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={suspendModal.isSubmitting || !suspendModal.reason.trim()}
                  className="flex items-center gap-1.5 rounded-xl bg-red-600 px-5 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition"
                >
                  {suspendModal.isSubmitting ? 'Saving...' : t('suspend')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Unsuspend Confirm Modal */}
      {unsuspendConfirm.isOpen && unsuspendConfirm.targetUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget && !unsuspendConfirm.isSubmitting) {
              setUnsuspendConfirm({
                isOpen: false,
                targetUser: null,
                isSubmitting: false,
                error: null,
              });
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsuspend-modal-title"
            className="w-full max-w-sm rounded-2xl border border-[#333] bg-[#1a1a1a] p-6 shadow-2xl text-gray-100 animate-scale-in"
          >
            <div className="flex items-center gap-2 text-green-500 mb-3">
              <Unlock className="h-5 w-5" />
              <h2 id="unsuspend-modal-title" className="text-base font-bold text-white">
                {t('unsuspend')}
              </h2>
            </div>

            <p className="text-xs text-gray-300 mb-4">{t('unsuspendConfirm')}</p>

            {unsuspendConfirm.error && (
              <div className="mb-4 flex items-start gap-2 rounded-xl p-3 text-xs bg-red-500/10 border border-red-500/30 text-red-400">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{unsuspendConfirm.error}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() =>
                  setUnsuspendConfirm({
                    isOpen: false,
                    targetUser: null,
                    isSubmitting: false,
                    error: null,
                  })
                }
                disabled={unsuspendConfirm.isSubmitting}
                className="rounded-xl px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white hover:bg-[#2c2c2c] transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmUnsuspend}
                disabled={unsuspendConfirm.isSubmitting}
                className="flex items-center gap-1.5 rounded-xl bg-green-600 px-5 py-2 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50 transition"
              >
                {unsuspendConfirm.isSubmitting ? 'Updating...' : t('unsuspend')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Role Editor Modal (Admin only) */}
      {rolesModal.isOpen && rolesModal.targetUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget && !rolesModal.isSubmitting) {
              closeRolesModal();
            }
          }}
        >
          <div
            ref={rolesModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="roles-modal-title"
            className="w-full max-w-md rounded-2xl border border-[#333] bg-[#1a1a1a] p-6 shadow-2xl text-gray-100 animate-scale-in"
          >
            <div className="flex items-center justify-between pb-4 border-b border-[#2e2e2e]">
              <div className="flex items-center gap-2 text-purple-400">
                <ShieldCheck className="h-5 w-5" />
                <h2 id="roles-modal-title" className="text-base font-bold text-white">
                  {t('rolesModalTitle')}
                </h2>
              </div>
              <button
                type="button"
                onClick={closeRolesModal}
                disabled={rolesModal.isSubmitting}
                className="rounded-lg p-1 text-gray-400 hover:text-white hover:bg-[#2c2c2c] transition"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-3 p-3 rounded-xl bg-[#222] border border-[#2e2e2e] text-xs">
              <span className="font-semibold text-white">{rolesModal.targetUser.display_name}</span>{' '}
              <span className="text-gray-400">(@{rolesModal.targetUser.handle})</span>
            </div>

            <p className="mt-2 text-[11px] text-gray-400 italic">{t('rolesViewerNote')}</p>

            {rolesModal.error && (
              <div className="mt-4 flex items-start gap-2 rounded-xl p-3 text-xs bg-red-500/10 border border-red-500/30 text-red-400">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{rolesModal.error}</span>
              </div>
            )}

            {rolesModal.success && (
              <div className="mt-4 flex items-start gap-2 rounded-xl p-3 text-xs bg-green-500/10 border border-green-500/30 text-green-400">
                <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{rolesModal.success}</span>
              </div>
            )}

            <form onSubmit={handleRolesSubmit} className="mt-4 space-y-3">
              {(['viewer', 'creator', 'moderator', 'admin'] as Role[]).map((role) => {
                const isChecked = rolesModal.selectedRoles.includes(role);
                const isViewer = role === 'viewer';

                return (
                  <label
                    key={role}
                    className={`flex items-center justify-between p-3 rounded-xl border text-xs cursor-pointer transition ${
                      isChecked
                        ? 'border-purple-500/70 bg-purple-500/10 text-white font-medium'
                        : 'border-[#2d2d2d] bg-[#222] text-gray-300 hover:bg-[#282828]'
                    } ${isViewer ? 'opacity-70 cursor-not-allowed' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isViewer}
                        onChange={() => handleRoleToggle(role)}
                        className="h-4 w-4 text-purple-600 rounded bg-[#222] border-gray-600 focus:ring-purple-500"
                      />
                      <span className="uppercase font-semibold tracking-wider">{role}</span>
                    </div>
                    {isViewer && <span className="text-[10px] text-gray-400">(Required)</span>}
                  </label>
                );
              })}

              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-[#2a2a2a]">
                <button
                  type="button"
                  onClick={closeRolesModal}
                  disabled={rolesModal.isSubmitting}
                  className="rounded-xl px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white hover:bg-[#2c2c2c] transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={rolesModal.isSubmitting}
                  className="flex items-center gap-1.5 rounded-xl bg-purple-600 px-5 py-2 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50 transition"
                >
                  {rolesModal.isSubmitting ? 'Saving...' : 'Save Roles'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
