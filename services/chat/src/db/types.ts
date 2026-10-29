import type { ColumnType, Generated } from 'kysely';

export type ConversationKind = 'DIRECT' | 'GROUP';
export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type MemberState = 'ACTIVE' | 'REQUESTED' | 'LEFT';
export type MessageKind = 'ENCRYPTED' | 'SYSTEM';

export interface DevicesTable {
  id: string;
  user_id: string;
  display_name: string;
  curve25519_key: string;
  ed25519_key: string;
  signature: string;
  fallback_key_id: string | null;
  fallback_key: string | null;
  fallback_signature: string | null;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface OneTimeKeysTable {
  device_id: string;
  key_id: string;
  public_key: string;
  signature: string;
  created_at: Generated<Date>;
}

export interface ConversationsTable {
  id: Generated<string>;
  kind: ConversationKind;
  title: string | null;
  created_by: string;
  direct_key: string | null;
  last_seq: Generated<string>;
  last_message_at: Date | null;
  created_at: Generated<Date>;
}

export interface MembersTable {
  conversation_id: string;
  user_id: string;
  role: MemberRole;
  state: MemberState;
  joined_seq: string;
  left_seq: string | null;
  last_read_seq: Generated<string>;
  muted_until: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MessagesTable {
  conversation_id: string;
  seq: string;
  id: Generated<string>;
  kind: MessageKind;
  sender_id: string | null;
  sender_device_id: string | null;
  client_msg_id: string | null;
  megolm_session_id: string | null;
  ciphertext: string | null;
  system_body: ColumnType<
    Record<string, unknown> | null,
    string | Record<string, unknown> | null,
    string | Record<string, unknown> | null
  >;
  deleted_at: Date | null;
  created_at: Generated<Date>;
}

export interface ToDeviceTable {
  id: Generated<string>;
  recipient_device_id: string;
  sender_id: string;
  sender_device_id: string;
  ciphertext: string;
  created_at: Generated<Date>;
}

export interface PublicProfilesTable {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  status: string;
}

export interface BlocksTable {
  blocker_id: string;
  blocked_id: string;
}

export interface SubscriptionsTable {
  subscriber_id: string;
  channel_id: string;
}

export interface Database {
  'chat.devices': DevicesTable;
  'chat.one_time_keys': OneTimeKeysTable;
  'chat.conversations': ConversationsTable;
  'chat.members': MembersTable;
  'chat.messages': MessagesTable;
  'chat.to_device': ToDeviceTable;
  'auth.public_profiles': PublicProfilesTable;
  'social.blocks': BlocksTable;
  'social.subscriptions': SubscriptionsTable;
}
