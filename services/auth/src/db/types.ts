import type { Generated, ColumnType } from 'kysely';

export type Role = 'viewer' | 'creator' | 'moderator' | 'admin';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export interface ProfileLink {
  url: string;
  label: string;
}

export interface UsersTable {
  id: string;
  email: string;
  email_verified_at: ColumnType<Date | null, string | Date | null, string | Date | null>;
  password_hash: string | null;
  handle: string;
  display_name: string;
  avatar_key: string | null;
  bio: string | null;
  links: ColumnType<ProfileLink[], string | ProfileLink[] | undefined, string | ProfileLink[]>;
  banner_key: string | null;
  is_private: ColumnType<boolean, boolean | undefined, boolean>;
  roles: Role[];
  status: ColumnType<UserStatus, UserStatus | undefined, UserStatus>;
  suspended_until: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  suspension_reason: string | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
  totp_secret_enc: Buffer | null;
  totp_key_id: string | null;
  totp_enabled_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  totp_last_step: ColumnType<number | null, number | null | undefined, number | null>;
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
  bio: string | null;
  links: ColumnType<ProfileLink[], string | ProfileLink[] | undefined, string | ProfileLink[]>;
  banner_key: string | null;
  is_private: boolean;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export type ImagePurpose = 'AVATAR' | 'BANNER' | 'POST';
export type ImageStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';

export interface ReadyImagesTable {
  id: string;
  owner_id: string;
  purpose: ImagePurpose;
  image_key: string;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
}

export interface ImagesTable {
  id: string;
  owner_id: string;
  purpose: ImagePurpose;
  status: ImageStatus;
  content_type: string;
  size_bytes: number | bigint;
  raw_bucket: string;
  raw_key: string;
  image_key: string | null;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  output_bytes: number | bigint | null;
  error: string | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
}

export type EmailTokenPurpose = 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'SESSION_REPORT';

export interface EmailTokensTable {
  id: string;
  user_id: string;
  purpose: EmailTokenPurpose;
  token_hash: Buffer;
  email: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  expires_at: ColumnType<Date, string | Date, string | Date>;
  used_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

export type MailTemplate = 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'PASSWORD_CHANGED' | 'NEW_SIGN_IN';
export type MailLocale = 'vi' | 'en';

export interface MailQueueTable {
  id: Generated<string>;
  user_id: string | null;
  to_email: string;
  template: MailTemplate;
  locale: ColumnType<MailLocale, MailLocale | undefined, MailLocale>;
  params: ColumnType<
    Record<string, unknown> | null,
    string | Record<string, unknown> | null,
    string | Record<string, unknown> | null
  >;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: ColumnType<Date, string | Date | undefined, string | Date>;
  sent_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  dead_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  last_error: string | null;
}

export type CreatorRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface CreatorRequestsTable {
  id: string;
  user_id: string;
  status: ColumnType<CreatorRequestStatus, CreatorRequestStatus | undefined, CreatorRequestStatus>;
  message: string;
  decision_note: ColumnType<string | null, string | null | undefined, string | null>;
  decided_by: ColumnType<string | null, string | null | undefined, string | null>;
  decided_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface RecoveryCodesTable {
  id: string;
  user_id: string;
  code_hash: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  used_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

export interface PasskeysTable {
  id: string;
  user_id: string;
  credential_id: Buffer;
  public_key: Buffer;
  sign_count: ColumnType<number, number | undefined, number>;
  transports: string[];
  aaguid: string | null;
  backup_eligible: boolean;
  backup_state: boolean;
  name: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  last_used_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

export type SessionRevokeReason =
  | 'LOGOUT'
  | 'USER_REVOKED'
  | 'REVOKE_OTHERS'
  | 'REUSE_DETECTED'
  | 'PASSWORD_CHANGED'
  | 'SUSPENDED'
  | 'DELETED'
  | 'REPORTED'
  | 'MFA_DISABLED'
  | 'EXPIRED';

export interface SessionsTable {
  id: string;
  user_id: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  last_used_at: ColumnType<Date, string | Date | undefined, string | Date>;
  device_label: string | null;
  country: string | null;
  ip_hash: Buffer | null;
  amr: string[];
  step_up_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  revoked_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  revoke_reason: SessionRevokeReason | null;
}

export type SecurityEventKind =
  | 'SIGN_IN'
  | 'SIGN_IN_NEW_DEVICE'
  | 'MFA_FAILED'
  | 'TOTP_ENABLED'
  | 'TOTP_DISABLED'
  | 'RECOVERY_CODES_GENERATED'
  | 'RECOVERY_CODE_USED'
  | 'PASSKEY_ADDED'
  | 'PASSKEY_REMOVED'
  | 'SESSION_REVOKED'
  | 'OTHER_SESSIONS_REVOKED'
  | 'SESSION_REPORTED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET'
  | 'STEP_UP';

export interface SecurityEventsTable {
  id: string;
  user_id: string;
  kind: SecurityEventKind;
  session_id: string | null;
  device_label: string | null;
  country: string | null;
  details: unknown;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface Database {
  'auth.users': UsersTable;
  'auth.oauth_identities': OAuthIdentitiesTable;
  'auth.refresh_tokens': RefreshTokensTable;
  'auth.outbox': OutboxTable;
  'auth.public_profiles': PublicProfilesTable;
  'auth.audit_log': AuditLogTable;
  'auth.email_tokens': EmailTokensTable;
  'auth.mail_queue': MailQueueTable;
  'auth.creator_requests': CreatorRequestsTable;
  'auth.recovery_codes': RecoveryCodesTable;
  'auth.passkeys': PasskeysTable;
  'auth.sessions': SessionsTable;
  'auth.security_events': SecurityEventsTable;
  'media.ready_images': ReadyImagesTable;
  'media.images': ImagesTable;
}
