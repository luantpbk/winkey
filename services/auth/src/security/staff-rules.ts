import type { Role, Database } from '../db/types.js';
import type { Kysely } from 'kysely';

const STAFF_ROLES: Set<Role> = new Set(['moderator', 'admin']);

export interface EffectiveRolesResult {
  effectiveRoles: Role[];
  staffRolesPendingMfa: Role[];
}

export function computeEffectiveRoles(
  dbRoles: Role[],
  hasMfaEnabled: boolean,
  staffMfaRequired = true,
): EffectiveRolesResult {
  if (!staffMfaRequired || hasMfaEnabled) {
    return {
      effectiveRoles: [...dbRoles],
      staffRolesPendingMfa: [],
    };
  }

  const effectiveRoles = dbRoles.filter((r) => !STAFF_ROLES.has(r));
  const staffRolesPendingMfa = dbRoles.filter((r) => STAFF_ROLES.has(r));

  return {
    effectiveRoles,
    staffRolesPendingMfa,
  };
}

export async function checkUserMfaEnabled(
  db: Kysely<Database>,
  userId: string,
  totpEnabledAt?: Date | null,
): Promise<boolean> {
  if (totpEnabledAt) {
    return true;
  }
  const passkey = await db
    .selectFrom('auth.passkeys')
    .select('id')
    .where('user_id', '=', userId)
    .executeTakeFirst();

  return Boolean(passkey);
}
