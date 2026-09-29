import type { Generated, ColumnType } from 'kysely';

export type Role = 'viewer' | 'creator' | 'moderator' | 'admin';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export interface UsersTable {
  id: string;
  email: string;
  email_verified_at: ColumnType<Date | null, string | Date | null, string | Date | null>;
  password_hash: string | null;
  handle: string;
  display_name: string;
  avatar_key: string | null;
  roles: Role[];
  status: ColumnType<UserStatus, UserStatus | undefined, UserStatus>;
  suspended_until: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  suspension_reason: string | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
}

export type AuditAction = 'USER_ROLES_CHANGED' | 'USER_SUSPENDED' | 'USER_UNSUSPENDED';

export interface AuditLogTable {
  id: string;
  actor_id: string;
  action: AuditAction;
  target_user_id: string;
  details: unknown;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface OAuthIdentitiesTable {
  provider: string;
  subject: string;
  user_id: string;
  email: string | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface RefreshTokensTable {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: Buffer;
  parent_id: string | null;
  issued_at: ColumnType<Date, string | Date | undefined, never>;
  expires_at: ColumnType<Date, string | Date, string | Date>;
  rotated_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  revoked_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  user_agent: string | null;
  ip: string | null;
}

export interface OutboxTable {
  id: Generated<string>;
  event_id: string;
  subject: string;
  payload: unknown;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  published_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

export interface PublicProfilesTable {
  id: string;
  handle: string;
  display_name: string;
  avatar_key: string | null;
}

export interface Database {
  'auth.users': UsersTable;
  'auth.oauth_identities': OAuthIdentitiesTable;
  'auth.refresh_tokens': RefreshTokensTable;
  'auth.outbox': OutboxTable;
  'auth.public_profiles': PublicProfilesTable;
  'auth.audit_log': AuditLogTable;
}
