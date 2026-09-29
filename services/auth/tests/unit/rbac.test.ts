import { describe, it, expect } from 'vitest';
import { checkRbacPermission, enforceRbac, type AdminAction } from '../../src/utils/rbac.js';
import type { Role } from '../../src/db/types.js';

interface TestCase {
  name: string;
  actorRoles: Role[];
  action: AdminAction;
  targetRoles?: Role[];
  isSelf?: boolean;
  expectedAllowed: boolean;
  expectedErrorCode?: 'FORBIDDEN' | 'CANNOT_MODERATE_TARGET';
}

describe('RBAC Matrix (Table-Driven)', () => {
  const cases: TestCase[] = [
    // 1. Unauthorized roles (viewer, creator)
    {
      name: 'viewer cannot list users',
      actorRoles: ['viewer'],
      action: 'LIST_USERS',
      expectedAllowed: false,
      expectedErrorCode: 'FORBIDDEN',
    },
    {
      name: 'creator cannot get user',
      actorRoles: ['creator', 'viewer'],
      action: 'GET_USER',
      expectedAllowed: false,
      expectedErrorCode: 'FORBIDDEN',
    },
    {
      name: 'creator cannot suspend user',
      actorRoles: ['creator'],
      action: 'SUSPEND_USER',
      targetRoles: ['viewer'],
      expectedAllowed: false,
      expectedErrorCode: 'FORBIDDEN',
    },
    {
      name: 'creator cannot unsuspend user',
      actorRoles: ['creator'],
      action: 'UNSUSPEND_USER',
      targetRoles: ['viewer'],
      expectedAllowed: false,
      expectedErrorCode: 'FORBIDDEN',
    },
    {
      name: 'viewer cannot change roles',
      actorRoles: ['viewer'],
      action: 'CHANGE_ROLES',
      targetRoles: ['viewer'],
      expectedAllowed: false,
      expectedErrorCode: 'FORBIDDEN',
    },
    {
      name: 'viewer cannot view audit log',
      actorRoles: ['viewer'],
      action: 'VIEW_AUDIT_LOG',
      expectedAllowed: false,
      expectedErrorCode: 'FORBIDDEN',
    },

    // 2. Moderator actions
    {
      name: 'moderator can list users',
      actorRoles: ['moderator'],
      action: 'LIST_USERS',
      expectedAllowed: true,
    },
    {
      name: 'moderator can get user',
      actorRoles: ['moderator'],
      action: 'GET_USER',
      expectedAllowed: true,
    },
    {
      name: 'moderator CANNOT change roles',
      actorRoles: ['moderator'],
      action: 'CHANGE_ROLES',
      targetRoles: ['viewer'],
      expectedAllowed: false,
      expectedErrorCode: 'FORBIDDEN',
    },
    {
      name: 'moderator CANNOT view audit log',
      actorRoles: ['moderator'],
      action: 'VIEW_AUDIT_LOG',
      expectedAllowed: false,
      expectedErrorCode: 'FORBIDDEN',
    },
    {
      name: 'moderator can suspend viewer',
      actorRoles: ['moderator'],
      action: 'SUSPEND_USER',
      targetRoles: ['viewer'],
      expectedAllowed: true,
    },
    {
      name: 'moderator can suspend creator',
      actorRoles: ['moderator'],
      action: 'SUSPEND_USER',
      targetRoles: ['creator', 'viewer'],
      expectedAllowed: true,
    },
    {
      name: 'moderator CANNOT suspend another moderator',
      actorRoles: ['moderator'],
      action: 'SUSPEND_USER',
      targetRoles: ['moderator'],
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },
    {
      name: 'moderator CANNOT suspend admin',
      actorRoles: ['moderator'],
      action: 'SUSPEND_USER',
      targetRoles: ['admin'],
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },
    {
      name: 'moderator CANNOT suspend self',
      actorRoles: ['moderator'],
      action: 'SUSPEND_USER',
      targetRoles: ['moderator'],
      isSelf: true,
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },
    {
      name: 'moderator can unsuspend viewer',
      actorRoles: ['moderator'],
      action: 'UNSUSPEND_USER',
      targetRoles: ['viewer'],
      expectedAllowed: true,
    },
    {
      name: 'moderator CANNOT unsuspend another moderator',
      actorRoles: ['moderator'],
      action: 'UNSUSPEND_USER',
      targetRoles: ['moderator'],
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },
    {
      name: 'moderator CANNOT unsuspend admin',
      actorRoles: ['moderator'],
      action: 'UNSUSPEND_USER',
      targetRoles: ['admin'],
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },

    // 3. Admin actions
    {
      name: 'admin can list users',
      actorRoles: ['admin'],
      action: 'LIST_USERS',
      expectedAllowed: true,
    },
    {
      name: 'admin can get user',
      actorRoles: ['admin'],
      action: 'GET_USER',
      expectedAllowed: true,
    },
    {
      name: 'admin can change roles of viewer',
      actorRoles: ['admin'],
      action: 'CHANGE_ROLES',
      targetRoles: ['viewer'],
      expectedAllowed: true,
    },
    {
      name: 'admin can change roles of moderator',
      actorRoles: ['admin'],
      action: 'CHANGE_ROLES',
      targetRoles: ['moderator', 'viewer'],
      expectedAllowed: true,
    },
    {
      name: 'admin CANNOT change roles of another admin',
      actorRoles: ['admin'],
      action: 'CHANGE_ROLES',
      targetRoles: ['admin', 'viewer'],
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },
    {
      name: 'admin CANNOT change own roles',
      actorRoles: ['admin'],
      action: 'CHANGE_ROLES',
      targetRoles: ['admin'],
      isSelf: true,
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },
    {
      name: 'admin can suspend viewer',
      actorRoles: ['admin'],
      action: 'SUSPEND_USER',
      targetRoles: ['viewer'],
      expectedAllowed: true,
    },
    {
      name: 'admin can suspend moderator',
      actorRoles: ['admin'],
      action: 'SUSPEND_USER',
      targetRoles: ['moderator'],
      expectedAllowed: true,
    },
    {
      name: 'admin CANNOT suspend another admin',
      actorRoles: ['admin'],
      action: 'SUSPEND_USER',
      targetRoles: ['admin'],
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },
    {
      name: 'admin CANNOT suspend self',
      actorRoles: ['admin'],
      action: 'SUSPEND_USER',
      targetRoles: ['admin'],
      isSelf: true,
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },
    {
      name: 'admin can unsuspend moderator',
      actorRoles: ['admin'],
      action: 'UNSUSPEND_USER',
      targetRoles: ['moderator'],
      expectedAllowed: true,
    },
    {
      name: 'admin CANNOT unsuspend another admin',
      actorRoles: ['admin'],
      action: 'UNSUSPEND_USER',
      targetRoles: ['admin'],
      expectedAllowed: false,
      expectedErrorCode: 'CANNOT_MODERATE_TARGET',
    },
    {
      name: 'admin can view audit log',
      actorRoles: ['admin'],
      action: 'VIEW_AUDIT_LOG',
      expectedAllowed: true,
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const res = checkRbacPermission({
        actorRoles: tc.actorRoles,
        action: tc.action,
        targetRoles: tc.targetRoles,
        isSelf: tc.isSelf,
      });

      expect(res.allowed).toBe(tc.expectedAllowed);
      if (!tc.expectedAllowed) {
        expect(res.errorCode).toBe(tc.expectedErrorCode);
        expect(() =>
          enforceRbac({
            actorRoles: tc.actorRoles,
            action: tc.action,
            targetRoles: tc.targetRoles,
            isSelf: tc.isSelf,
          }),
        ).toThrow();
      }
    });
  }
});
