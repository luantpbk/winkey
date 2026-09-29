import type { Role } from '../db/types.js';
import { ProblemError } from '../errors/problem.js';

export type AdminAction =
  'LIST_USERS' | 'GET_USER' | 'CHANGE_ROLES' | 'SUSPEND_USER' | 'UNSUSPEND_USER' | 'VIEW_AUDIT_LOG';

export interface RbacCheckParams {
  actorRoles: Role[];
  action: AdminAction;
  targetRoles?: Role[];
  isSelf?: boolean;
}

export interface RbacCheckResult {
  allowed: boolean;
  errorCode?: 'FORBIDDEN' | 'CANNOT_MODERATE_TARGET';
  reason?: string;
}

export function checkRbacPermission(params: RbacCheckParams): RbacCheckResult {
  const { actorRoles, action, targetRoles, isSelf } = params;
  const isActorAdmin = actorRoles.includes('admin');
  const isActorMod = actorRoles.includes('moderator');

  // Check base role permission
  if (!isActorAdmin && !isActorMod) {
    return {
      allowed: false,
      errorCode: 'FORBIDDEN',
      reason: 'Requires moderator or admin role',
    };
  }

  // Admin-only actions
  if ((action === 'CHANGE_ROLES' || action === 'VIEW_AUDIT_LOG') && !isActorAdmin) {
    return {
      allowed: false,
      errorCode: 'FORBIDDEN',
      reason: 'Requires admin role',
    };
  }

  // Self protection
  if (isSelf) {
    if (action === 'CHANGE_ROLES') {
      return {
        allowed: false,
        errorCode: 'CANNOT_MODERATE_TARGET',
        reason: 'Cannot change own roles',
      };
    }
    if (action === 'SUSPEND_USER') {
      return {
        allowed: false,
        errorCode: 'CANNOT_MODERATE_TARGET',
        reason: 'Cannot suspend self',
      };
    }
  }

  // Target-specific checks
  if (targetRoles) {
    const isTargetAdmin = targetRoles.includes('admin');
    const isTargetMod = targetRoles.includes('moderator');

    // Admin protection: nobody can suspend or change roles of an admin
    if (isTargetAdmin) {
      if (action === 'CHANGE_ROLES') {
        return {
          allowed: false,
          errorCode: 'CANNOT_MODERATE_TARGET',
          reason: 'Cannot modify roles of an admin',
        };
      }
      if (action === 'SUSPEND_USER' || action === 'UNSUSPEND_USER') {
        return {
          allowed: false,
          errorCode: 'CANNOT_MODERATE_TARGET',
          reason: 'Cannot moderate an admin',
        };
      }
    }

    // Moderator protection: moderators cannot moderate moderators
    if (isTargetMod && !isActorAdmin) {
      if (action === 'SUSPEND_USER' || action === 'UNSUSPEND_USER') {
        return {
          allowed: false,
          errorCode: 'CANNOT_MODERATE_TARGET',
          reason: 'Moderators cannot moderate other moderators',
        };
      }
    }
  }

  return { allowed: true };
}

export function enforceRbac(params: RbacCheckParams): void {
  const result = checkRbacPermission(params);
  if (!result.allowed) {
    if (result.errorCode === 'CANNOT_MODERATE_TARGET') {
      throw ProblemError.cannotModerateTarget(result.reason || 'Cannot moderate target');
    }
    throw ProblemError.forbidden(result.reason || 'Forbidden');
  }
}
