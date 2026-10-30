import { Kysely, PostgresDialect } from 'kysely';
import type {
  Database,
  ConversationKind,
  MemberRole,
  MemberState,
  MessageKind,
} from '../../src/db/types.js';

export interface MockStore {
  devices: Array<{
    id: string;
    user_id: string;
    display_name: string;
    curve25519_key: string;
    ed25519_key: string;
    signature: string;
    fallback_key_id: string | null;
    fallback_key: string | null;
    fallback_signature: string | null;
    created_at: Date;
    last_seen_at: Date;
    deleted_at: Date | null;
  }>;
  one_time_keys: Array<{
    device_id: string;
    key_id: string;
    public_key: string;
    signature: string;
    created_at: Date;
  }>;
  conversations: Array<{
    id: string;
    kind: ConversationKind;
    title: string | null;
    created_by: string;
    direct_key: string | null;
    last_seq: string;
    last_message_at: Date | null;
    created_at: Date;
  }>;
  members: Array<{
    conversation_id: string;
    user_id: string;
    role: MemberRole;
    state: MemberState;
    joined_seq: string;
    left_seq: string | null;
    last_read_seq: string;
    muted_until: Date | null;
    created_at: Date;
    updated_at: Date;
  }>;
  messages: Array<{
    conversation_id: string;
    seq: string;
    id: string;
    kind: MessageKind;
    sender_id: string | null;
    sender_device_id: string | null;
    client_msg_id: string | null;
    megolm_session_id: string | null;
    ciphertext: string | null;
    system_body: unknown;
    deleted_at: Date | null;
    created_at: Date;
  }>;
  to_device: Array<{
    id: string;
    recipient_device_id: string;
    sender_id: string;
    sender_device_id: string;
    ciphertext: string;
    created_at: Date;
  }>;
  public_profiles: Array<{
    id: string;
    handle: string;
    display_name: string;
    avatar_key: string | null;
    bio?: string | null;
    status?: string;
  }>;
  blocks: Array<{
    blocker_id: string;
    blocked_id: string;
  }>;
  subscriptions: Array<{
    subscriber_id: string;
    channel_id: string;
  }>;
  toDeviceSequence: number;
}

export function createMockStore(): MockStore {
  return {
    devices: [],
    one_time_keys: [],
    conversations: [],
    members: [],
    messages: [],
    to_device: [],
    public_profiles: [],
    blocks: [],
    subscriptions: [],
    toDeviceSequence: 1,
  };
}

export function createMockDb(store: MockStore): Kysely<Database> {
  const mockClient = {
    async query(sqlText: string, params: unknown[] = []) {
      const sqlLower = sqlText.toLowerCase().trim();

      // Transaction / Advisory lock commands
      if (
        sqlLower === 'begin' ||
        sqlLower === 'commit' ||
        sqlLower === 'rollback' ||
        sqlLower.includes('pg_advisory_xact_lock') ||
        sqlLower.includes('pg_try_advisory_lock') ||
        sqlLower.includes('pg_advisory_unlock') ||
        sqlLower === 'select 1'
      ) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }

      // ----------------------------------------------------
      // chat.devices queries
      // ----------------------------------------------------
      // SELECT chat.devices list for user
      if (
        sqlLower.includes('from "chat"."devices"') &&
        sqlLower.includes('"user_id" =') &&
        sqlLower.includes('"deleted_at" is null') &&
        sqlLower.includes('order by "created_at" desc')
      ) {
        const userId = String(params[0]);
        const rows = store.devices
          .filter((d) => d.user_id === userId && d.deleted_at === null)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return { rows, rowCount: rows.length };
      }

      // SELECT chat.devices count for user
      if (
        sqlLower.includes('count(*)') &&
        sqlLower.includes('from "chat"."devices"') &&
        sqlLower.includes('"user_id" =') &&
        sqlLower.includes('"deleted_at" is null')
      ) {
        const userId = String(params[0]);
        const count = store.devices.filter(
          (d) => d.user_id === userId && d.deleted_at === null,
        ).length;
        return { rows: [{ count: String(count) }], rowCount: 1 };
      }

      // SELECT chat.devices by id & user_id
      if (
        sqlLower.includes('from "chat"."devices"') &&
        sqlLower.includes('"id" =') &&
        sqlLower.includes('"user_id" =')
      ) {
        const id = String(params[0]);
        const userId = String(params[1]);
        const dev = store.devices.find((d) => d.id === id && d.user_id === userId);
        return { rows: dev ? [dev] : [], rowCount: dev ? 1 : 0 };
      }

      // SELECT chat.devices by id
      if (sqlLower.includes('from "chat"."devices"') && sqlLower.includes('"id" =')) {
        const id = String(params[0]);
        const dev = store.devices.find((d) => d.id === id);
        return { rows: dev ? [dev] : [], rowCount: dev ? 1 : 0 };
      }

      // SELECT chat.devices by curve25519_key
      if (sqlLower.includes('from "chat"."devices"') && sqlLower.includes('"curve25519_key" =')) {
        const key = String(params[0]);
        const dev = store.devices.find((d) => d.curve25519_key === key);
        return { rows: dev ? [dev] : [], rowCount: dev ? 1 : 0 };
      }

      // Query devices for multiple users
      if (
        sqlLower.includes('from "chat"."devices"') &&
        sqlLower.includes('"user_id" in') &&
        sqlLower.includes('"deleted_at" is null')
      ) {
        const userIds = params as string[];
        const rows = store.devices
          .filter((d) => userIds.includes(d.user_id) && d.deleted_at === null)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        return { rows, rowCount: rows.length };
      }

      // INSERT into chat.devices
      if (sqlLower.includes('insert into "chat"."devices"')) {
        const now = new Date();
        const newDevice = {
          id: String(params[0]),
          user_id: String(params[1]),
          display_name: String(params[2]),
          curve25519_key: String(params[3]),
          ed25519_key: String(params[4]),
          signature: String(params[5]),
          fallback_key_id: params[6] ? String(params[6]) : null,
          fallback_key: params[7] ? String(params[7]) : null,
          fallback_signature: params[8] ? String(params[8]) : null,
          created_at: now,
          last_seen_at: now,
          deleted_at: null,
        };
        store.devices.push(newDevice);
        return { rows: [newDevice], rowCount: 1 };
      }

      // UPDATE chat.devices (update display_name and fallback key)
      if (sqlLower.includes('update "chat"."devices"') && sqlLower.includes('display_name')) {
        const displayName = String(params[0]);
        const fallbackKeyId = params[1] ? String(params[1]) : null;
        const fallbackKey = params[2] ? String(params[2]) : null;
        const fallbackSig = params[3] ? String(params[3]) : null;
        const id = String(params[5]);

        const dev = store.devices.find((d) => d.id === id);
        if (dev) {
          dev.display_name = displayName;
          dev.fallback_key_id = fallbackKeyId;
          dev.fallback_key = fallbackKey;
          dev.fallback_signature = fallbackSig;
          dev.last_seen_at = new Date();
          return { rows: [dev], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // UPDATE chat.devices set deleted_at
      if (sqlLower.includes('update "chat"."devices"') && sqlLower.includes('deleted_at')) {
        const id = String(params[1]);
        const dev = store.devices.find((d) => d.id === id);
        if (dev) {
          dev.deleted_at = new Date();
          return { rows: [dev], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // UPDATE chat.devices set last_seen_at
      if (
        sqlLower.includes('update chat.devices') &&
        sqlLower.includes('set last_seen_at = now()')
      ) {
        const id = String(params[0]);
        const dev = store.devices.find((d) => d.id === id);
        if (dev) {
          dev.last_seen_at = new Date();
          return { rows: [dev], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Eligible devices query for claimKeys
      if (
        sqlLower.includes('from chat.devices d') &&
        sqlLower.includes('join auth.public_profiles p on p.id = d.user_id') &&
        sqlLower.includes('d.id = any(')
      ) {
        const deviceIds = params[0] as string[];
        const callerId = String(params[1]);

        const rows = store.devices
          .filter((d) => {
            if (!deviceIds.includes(d.id) || d.deleted_at !== null) return false;
            const profile = store.public_profiles.find(
              (p) => p.id === d.user_id && p.status === 'ACTIVE',
            );
            if (!profile) return false;

            // Block check
            if (d.user_id !== callerId) {
              const blocked = store.blocks.some(
                (b) =>
                  (b.blocker_id === callerId && b.blocked_id === d.user_id) ||
                  (b.blocker_id === d.user_id && b.blocked_id === callerId),
              );
              if (blocked) return false;
            }
            return true;
          })
          .map((d) => ({
            id: d.id,
            user_id: d.user_id,
            curve25519_key: d.curve25519_key,
            ed25519_key: d.ed25519_key,
            fallback_key_id: d.fallback_key_id,
            fallback_key: d.fallback_key,
            fallback_signature: d.fallback_signature,
          }));

        return { rows, rowCount: rows.length };
      }

      // Valid recipient devices query for sendToDevice
      if (
        sqlLower.includes('from chat.devices d') &&
        sqlLower.includes('d.id = any(') &&
        sqlLower.includes('from social.blocks b')
      ) {
        const deviceIds = params[0] as string[];
        const callerId = String(params[1]);

        const rows = store.devices
          .filter((d) => {
            if (!deviceIds.includes(d.id) || d.deleted_at !== null) return false;

            if (d.user_id === callerId) return true;

            // Block check
            const blocked = store.blocks.some(
              (b) =>
                (b.blocker_id === callerId && b.blocked_id === d.user_id) ||
                (b.blocker_id === d.user_id && b.blocked_id === callerId),
            );
            if (blocked) return false;

            // Shared conversation check
            const sharedConv = store.members.some((m1) => {
              if (m1.user_id !== callerId || (m1.state !== 'ACTIVE' && m1.state !== 'REQUESTED')) {
                return false;
              }
              return store.members.some(
                (m2) =>
                  m2.conversation_id === m1.conversation_id &&
                  m2.user_id === d.user_id &&
                  (m2.state === 'ACTIVE' || m2.state === 'REQUESTED'),
              );
            });

            return sharedConv;
          })
          .map((d) => ({ id: d.id, user_id: d.user_id }));

        return { rows, rowCount: rows.length };
      }

      // Shared users query for DEVICES hint
      if (
        sqlLower.includes('from chat.members m1') &&
        sqlLower.includes('join chat.members m2 on m2.conversation_id = m1.conversation_id')
      ) {
        const callerId = String(params[0]);
        const callerConvs = store.members
          .filter(
            (m) => m.user_id === callerId && (m.state === 'ACTIVE' || m.state === 'REQUESTED'),
          )
          .map((m) => m.conversation_id);

        const otherUsers = [
          ...new Set(
            store.members
              .filter(
                (m) =>
                  callerConvs.includes(m.conversation_id) &&
                  m.user_id !== callerId &&
                  (m.state === 'ACTIVE' || m.state === 'REQUESTED'),
              )
              .map((m) => m.user_id),
          ),
        ];

        return {
          rows: otherUsers.map((uid) => ({ user_id: uid })),
          rowCount: otherUsers.length,
        };
      }

      // ----------------------------------------------------
      // chat.one_time_keys queries
      // ----------------------------------------------------
      // SELECT count(*) of OTKs for device
      if (
        sqlLower.includes('count(*)') &&
        sqlLower.includes('from "chat"."one_time_keys"') &&
        sqlLower.includes('"device_id" =')
      ) {
        const deviceId = String(params[0]);
        const count = store.one_time_keys.filter((k) => k.device_id === deviceId).length;
        return { rows: [{ count: String(count) }], rowCount: 1 };
      }

      // SELECT existing OTK key_ids for device
      if (
        sqlLower.includes('from "chat"."one_time_keys"') &&
        sqlLower.includes('"device_id" =') &&
        sqlLower.includes('"key_id" in')
      ) {
        const deviceId = String(params[0]);
        const keyIds = params.slice(1) as string[];
        const rows = store.one_time_keys
          .filter((k) => k.device_id === deviceId && keyIds.includes(k.key_id))
          .map((k) => ({ key_id: k.key_id }));
        return { rows, rowCount: rows.length };
      }

      // INSERT into chat.one_time_keys
      if (sqlLower.includes('insert into "chat"."one_time_keys"')) {
        for (let i = 0; i < params.length; i += 4) {
          const deviceId = String(params[i]);
          const keyId = String(params[i + 1]);
          const pub = String(params[i + 2]);
          const sig = String(params[i + 3]);

          const existing = store.one_time_keys.find(
            (k) => k.device_id === deviceId && k.key_id === keyId,
          );
          if (!existing) {
            store.one_time_keys.push({
              device_id: deviceId,
              key_id: keyId,
              public_key: pub,
              signature: sig,
              created_at: new Date(),
            });
          }
        }
        return { rows: [], rowCount: Math.floor(params.length / 4) };
      }

      // Atomic claim DELETE FROM chat.one_time_keys
      if (sqlLower.includes('delete from chat.one_time_keys') && sqlLower.includes('limit 1')) {
        const deviceId = String(params[0]);
        const idx = store.one_time_keys.findIndex((k) => k.device_id === deviceId);
        if (idx !== -1) {
          const [popped] = store.one_time_keys.splice(idx, 1);
          return {
            rows: [
              {
                key_id: popped.key_id,
                public_key: popped.public_key,
                signature: popped.signature,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // DELETE FROM chat.one_time_keys WHERE device_id = $1
      if (
        sqlLower.includes('delete from "chat"."one_time_keys"') &&
        sqlLower.includes('"device_id" =')
      ) {
        const deviceId = String(params[0]);
        store.one_time_keys = store.one_time_keys.filter((k) => k.device_id !== deviceId);
        return { rows: [], rowCount: 1 };
      }

      // ----------------------------------------------------
      // chat.to_device queries
      // ----------------------------------------------------
      // INSERT into chat.to_device
      if (sqlLower.includes('insert into "chat"."to_device"')) {
        for (let i = 0; i < params.length; i += 4) {
          const recipient_device_id = String(params[i]);
          const sender_id = String(params[i + 1]);
          const sender_device_id = String(params[i + 2]);
          const ciphertext = String(params[i + 3]);
          const id = String(store.toDeviceSequence++);
          store.to_device.push({
            id,
            recipient_device_id,
            sender_id,
            sender_device_id,
            ciphertext,
            created_at: new Date(),
          });
        }
        return { rows: [], rowCount: Math.floor(params.length / 4) };
      }

      // SELECT chat.to_device with after
      if (
        sqlLower.includes('from chat.to_device') &&
        sqlLower.includes('recipient_device_id =') &&
        sqlLower.includes('id >')
      ) {
        const deviceId = String(params[0]);
        const afterId = BigInt(String(params[1]));
        const limit = Number(params[2]);

        const rows = store.to_device
          .filter((t) => t.recipient_device_id === deviceId && BigInt(t.id) > afterId)
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
          .slice(0, limit);

        return { rows, rowCount: rows.length };
      }

      // SELECT chat.to_device without after
      if (sqlLower.includes('from chat.to_device') && sqlLower.includes('recipient_device_id =')) {
        const deviceId = String(params[0]);
        const limit = Number(params[1]);

        const rows = store.to_device
          .filter((t) => t.recipient_device_id === deviceId)
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
          .slice(0, limit);

        return { rows, rowCount: rows.length };
      }

      // DELETE chat.to_device by recipient_device_id and id <= up_to
      if (
        sqlLower.includes('delete from chat.to_device') &&
        sqlLower.includes('recipient_device_id =') &&
        sqlLower.includes('id <=')
      ) {
        const deviceId = String(params[0]);
        const upTo = BigInt(String(params[1]));
        const beforeLen = store.to_device.length;
        store.to_device = store.to_device.filter(
          (t) => !(t.recipient_device_id === deviceId && BigInt(t.id) <= upTo),
        );
        return { rows: [], rowCount: beforeLen - store.to_device.length };
      }

      // DELETE chat.to_device by recipient_device_id
      if (
        sqlLower.includes('delete from "chat"."to_device"') &&
        sqlLower.includes('"recipient_device_id" =')
      ) {
        const deviceId = String(params[0]);
        store.to_device = store.to_device.filter((t) => t.recipient_device_id !== deviceId);
        return { rows: [], rowCount: 1 };
      }

      // ----------------------------------------------------
      // chat.conversations queries
      // ----------------------------------------------------
      // SELECT chat.conversations by direct_key
      if (sqlLower.includes('from "chat"."conversations"') && sqlLower.includes('"direct_key" =')) {
        const directKey = String(params[0]);
        const conv = store.conversations.find((c) => c.direct_key === directKey);
        return { rows: conv ? [conv] : [], rowCount: conv ? 1 : 0 };
      }

      // SELECT chat.conversations by id
      if (sqlLower.includes('from "chat"."conversations"') && sqlLower.includes('"id" =')) {
        const id = String(params[0]);
        const conv = store.conversations.find((c) => c.id === id);
        return { rows: conv ? [conv] : [], rowCount: conv ? 1 : 0 };
      }

      // INSERT into chat.conversations
      if (sqlLower.includes('insert into "chat"."conversations"')) {
        const conv = {
          id: String(params[0]),
          kind: params[1] as ConversationKind,
          title: params[2] ? String(params[2]) : null,
          created_by: String(params[3]),
          direct_key: params[4] ? String(params[4]) : null,
          last_seq: String(params[5]),
          last_message_at: new Date(String(params[6])),
          created_at: new Date(),
        };
        store.conversations.push(conv);
        return { rows: [conv], rowCount: 1 };
      }

      // UPDATE chat.conversations title and last_seq
      if (sqlLower.includes('update "chat"."conversations"') && sqlLower.includes('"title" =')) {
        const title = String(params[0]);
        const lastSeq = String(params[1]);
        const lastMessageAt = new Date(String(params[2]));
        const id = String(params[3]);

        const conv = store.conversations.find((c) => c.id === id);
        if (conv) {
          conv.title = title;
          conv.last_seq = lastSeq;
          conv.last_message_at = lastMessageAt;
          return { rows: [conv], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // UPDATE chat.conversations last_seq
      if (sqlLower.includes('update "chat"."conversations"') && sqlLower.includes('"last_seq" =')) {
        const lastSeq = String(params[0]);
        const lastMessageAt = new Date(String(params[1]));
        const id = String(params[2]);

        const conv = store.conversations.find((c) => c.id === id);
        if (conv) {
          conv.last_seq = lastSeq;
          conv.last_message_at = lastMessageAt;
          return { rows: [conv], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // List conversations for user query
      if (
        sqlLower.includes('from chat.members m') &&
        sqlLower.includes('join chat.conversations c on c.id = m.conversation_id')
      ) {
        const userId = String(params[0]);
        const state = String(params[1]);
        const limit = Number(params[params.length - 1]);

        const myMemberships = store.members.filter(
          (m) => m.user_id === userId && m.state === state,
        );

        const rows: Array<Record<string, unknown>> = [];
        for (const mem of myMemberships) {
          const conv = store.conversations.find((c) => c.id === mem.conversation_id);
          if (conv) {
            rows.push({
              id: conv.id,
              kind: conv.kind,
              title: conv.title,
              last_seq: conv.last_seq,
              last_message_at: conv.last_message_at,
              created_at: conv.created_at,
              my_role: mem.role,
              my_state: mem.state,
              my_joined_seq: mem.joined_seq,
              my_last_read_seq: mem.last_read_seq,
              my_muted_until: mem.muted_until,
            });
          }
        }

        rows.sort((a, b) => {
          const aTime =
            (a.last_message_at as Date | null)?.getTime() ?? (a.created_at as Date).getTime();
          const bTime =
            (b.last_message_at as Date | null)?.getTime() ?? (b.created_at as Date).getTime();
          if (aTime !== bTime) return bTime - aTime;
          return String(b.id).localeCompare(String(a.id));
        });

        return { rows: rows.slice(0, limit), rowCount: rows.length };
      }

      // ----------------------------------------------------
      // chat.members queries
      // ----------------------------------------------------
      // SELECT chat.members by conversation_id and user_id
      if (
        sqlLower.includes('from "chat"."members"') &&
        sqlLower.includes('"conversation_id" =') &&
        sqlLower.includes('"user_id" =')
      ) {
        const convId = String(params[0]);
        const userId = String(params[1]);
        const mem = store.members.find((m) => m.conversation_id === convId && m.user_id === userId);
        return { rows: mem ? [mem] : [], rowCount: mem ? 1 : 0 };
      }

      // SELECT chat.members by conversation_id in (...)
      if (sqlLower.includes('from "chat"."members"') && sqlLower.includes('"conversation_id" in')) {
        const convIds = params.slice(0, -2) as string[];
        const rows = store.members.filter((m) => convIds.includes(m.conversation_id));
        return { rows, rowCount: rows.length };
      }

      // SELECT chat.members by conversation_id
      if (sqlLower.includes('from "chat"."members"') && sqlLower.includes('"conversation_id" =')) {
        const convId = String(params[0]);
        const rows = store.members.filter((m) => m.conversation_id === convId);
        return { rows, rowCount: rows.length };
      }

      // INSERT into chat.members
      if (sqlLower.includes('insert into "chat"."members"')) {
        for (let i = 0; i < params.length; i += 6) {
          const convId = String(params[i]);
          const userId = String(params[i + 1]);
          const role = params[i + 2] as MemberRole;
          const state = params[i + 3] as MemberState;
          const joinedSeq = String(params[i + 4]);
          const lastReadSeq = String(params[i + 5]);
          const now = new Date();

          store.members.push({
            conversation_id: convId,
            user_id: userId,
            role,
            state,
            joined_seq: joinedSeq,
            left_seq: null,
            last_read_seq: lastReadSeq,
            muted_until: null,
            created_at: now,
            updated_at: now,
          });
        }
        return { rows: [], rowCount: Math.floor(params.length / 6) };
      }

      // UPDATE chat.members (state, role, left_seq, last_read_seq, muted_until)
      if (sqlLower.includes('update "chat"."members"')) {
        const convId = String(params[params.length - 2]);
        const userId = String(params[params.length - 1]);
        const mem = store.members.find((m) => m.conversation_id === convId && m.user_id === userId);

        if (mem) {
          if (sqlLower.includes('"last_read_seq" =')) {
            mem.last_read_seq = String(params[0]);
          }
          if (sqlLower.includes('"state" =')) {
            mem.state = params[0] as MemberState;
          }
          if (sqlLower.includes('"role" =')) {
            mem.role = params[0] as MemberRole;
          }
          if (sqlLower.includes('"muted_until" =')) {
            mem.muted_until = params[0] ? new Date(String(params[0])) : null;
          }
          if (sqlLower.includes('"left_seq" =')) {
            mem.left_seq = params[1] ? String(params[1]) : null;
          }
          mem.updated_at = new Date();
          return { rows: [mem], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Successor query on owner leave
      if (
        sqlLower.includes('from chat.members') &&
        sqlLower.includes("state = 'active'") &&
        sqlLower.includes('order by (case when role =')
      ) {
        const convId = String(params[0]);
        const callerId = String(params[1]);

        const candidates = store.members.filter(
          (m) => m.conversation_id === convId && m.state === 'ACTIVE' && m.user_id !== callerId,
        );

        candidates.sort((a, b) => {
          const aAdmin = a.role === 'ADMIN' ? 0 : 1;
          const bAdmin = b.role === 'ADMIN' ? 0 : 1;
          if (aAdmin !== bAdmin) return aAdmin - bAdmin;
          return a.created_at.getTime() - b.created_at.getTime();
        });

        const chosen = candidates[0];
        return {
          rows: chosen ? [{ user_id: chosen.user_id }] : [],
          rowCount: chosen ? 1 : 0,
        };
      }

      // ----------------------------------------------------
      // chat.messages queries
      // ----------------------------------------------------
      // SELECT chat.messages by sender_id and client_msg_id (idempotency check)
      if (
        sqlLower.includes('from "chat"."messages"') &&
        sqlLower.includes('"sender_id" =') &&
        sqlLower.includes('"client_msg_id" =')
      ) {
        const senderId = String(params[0]);
        const clientMsgId = String(params[1]);
        const msg = store.messages.find(
          (m) => m.sender_id === senderId && m.client_msg_id === clientMsgId,
        );
        return { rows: msg ? [msg] : [], rowCount: msg ? 1 : 0 };
      }

      // SELECT chat.messages by conversation_id and seq
      if (
        sqlLower.includes('from "chat"."messages"') &&
        sqlLower.includes('"conversation_id" =') &&
        sqlLower.includes('"seq" =')
      ) {
        const convId = String(params[0]);
        const seq = String(params[1]);
        const msg = store.messages.find((m) => m.conversation_id === convId && m.seq === seq);
        return { rows: msg ? [msg] : [], rowCount: msg ? 1 : 0 };
      }

      // INSERT into chat.messages
      if (sqlLower.includes('insert into "chat"."messages"')) {
        const msg = {
          conversation_id: String(params[0]),
          seq: String(params[1]),
          id: String(params[2]),
          kind: params[3] as MessageKind,
          sender_id: params[4] ? String(params[4]) : null,
          sender_device_id: params[5] ? String(params[5]) : null,
          client_msg_id: params[6] ? String(params[6]) : null,
          megolm_session_id: params[7] ? String(params[7]) : null,
          ciphertext: params[8] ? String(params[8]) : null,
          system_body: params[9] ? JSON.parse(String(params[9])) : null,
          deleted_at: null,
          created_at: new Date(),
        };
        store.messages.push(msg);
        return { rows: [msg], rowCount: 1 };
      }

      // UPDATE chat.messages tombstone (ciphertext = null, deleted_at = now())
      if (sqlLower.includes('update "chat"."messages"') && sqlLower.includes('deleted_at')) {
        const convId = String(params[2]);
        const seq = String(params[3]);
        const msg = store.messages.find((m) => m.conversation_id === convId && m.seq === seq);
        if (msg) {
          msg.ciphertext = null;
          msg.deleted_at = new Date();
          return { rows: [msg], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Unread count subquery for single conversation
      if (sqlLower.includes('from chat.messages msg') && sqlLower.includes('msg.seq > greatest(')) {
        const convId = String(params[0]);
        const callerId = String(params[3]);
        const lastReadSeq = BigInt(String(params[1]));
        const joinedSeq = BigInt(String(params[2]));
        const threshold = lastReadSeq > joinedSeq - 1n ? lastReadSeq : joinedSeq - 1n;

        const count = store.messages.filter(
          (m) =>
            m.conversation_id === convId && BigInt(m.seq) > threshold && m.sender_id !== callerId,
        ).length;

        return { rows: [{ count: String(Math.min(99, count)) }], rowCount: 1 };
      }

      // Unread count batch for list conversations
      if (
        sqlLower.includes('from chat.members m') &&
        sqlLower.includes('join chat.messages msg on msg.conversation_id = m.conversation_id')
      ) {
        const callerId = String(params[0]);
        const convIds = params[1] as string[];

        const rows: Array<{ conversation_id: string; unread_count: string }> = [];
        for (const cid of convIds) {
          const mem = store.members.find(
            (m) => m.conversation_id === cid && m.user_id === callerId,
          );
          if (!mem) continue;
          const lastReadSeq = BigInt(mem.last_read_seq);
          const joinedSeq = BigInt(mem.joined_seq);
          const threshold = lastReadSeq > joinedSeq - 1n ? lastReadSeq : joinedSeq - 1n;

          const count = store.messages.filter(
            (m) =>
              m.conversation_id === cid && BigInt(m.seq) > threshold && m.sender_id !== callerId,
          ).length;

          rows.push({
            conversation_id: cid,
            unread_count: String(Math.min(99, count)),
          });
        }
        return { rows, rowCount: rows.length };
      }

      // List messages with after_seq
      if (sqlLower.includes('from chat.messages') && sqlLower.includes('seq >')) {
        const convId = String(params[0]);
        const afterVal = BigInt(String(params[1]));
        const minSeq = BigInt(String(params[2]));
        const maxSeq = BigInt(String(params[3]));
        const limit = Number(params[4]);

        const rows = store.messages
          .filter((m) => {
            if (m.conversation_id !== convId) return false;
            const s = BigInt(m.seq);
            return s > afterVal && s >= minSeq && s <= maxSeq;
          })
          .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
          .slice(0, limit);

        return { rows, rowCount: rows.length };
      }

      // List messages with before_seq
      if (sqlLower.includes('from chat.messages') && sqlLower.includes('seq <')) {
        const convId = String(params[0]);
        const beforeVal = BigInt(String(params[1]));
        const minSeq = BigInt(String(params[2]));
        const maxSeq = BigInt(String(params[3]));
        const limit = Number(params[4]);

        const rows = store.messages
          .filter((m) => {
            if (m.conversation_id !== convId) return false;
            const s = BigInt(m.seq);
            return s < beforeVal && s >= minSeq && s <= maxSeq;
          })
          .sort((a, b) => (BigInt(b.seq) < BigInt(a.seq) ? -1 : 1))
          .slice(0, limit);

        return { rows, rowCount: rows.length };
      }

      // List messages newest page
      if (sqlLower.includes('from chat.messages') && sqlLower.includes('seq >=')) {
        const convId = String(params[0]);
        const minSeq = BigInt(String(params[1]));
        const maxSeq = BigInt(String(params[2]));
        const limit = Number(params[3]);

        const rows = store.messages
          .filter((m) => {
            if (m.conversation_id !== convId) return false;
            const s = BigInt(m.seq);
            return s >= minSeq && s <= maxSeq;
          })
          .sort((a, b) => (BigInt(b.seq) < BigInt(a.seq) ? -1 : 1))
          .slice(0, limit);

        return { rows, rowCount: rows.length };
      }

      // ----------------------------------------------------
      // External schemas: auth.public_profiles, social.blocks, social.subscriptions
      // ----------------------------------------------------
      // SELECT auth.public_profiles by in (...)
      if (sqlLower.includes('from "auth"."public_profiles"') && sqlLower.includes('"id" in')) {
        const userIds = params as string[];
        const rows = store.public_profiles
          .filter(
            (p) => userIds.includes(p.id) && (p.status === undefined || p.status === 'ACTIVE'),
          )
          .map((p) => ({
            id: p.id,
            handle: p.handle,
            display_name: p.display_name,
            avatar_key: p.avatar_key,
          }));
        return { rows, rowCount: rows.length };
      }

      // SELECT auth.public_profiles by id = $1
      if (sqlLower.includes('from "auth"."public_profiles"') && sqlLower.includes('"id" =')) {
        const id = String(params[0]);
        const profile = store.public_profiles.find(
          (p) => p.id === id && (p.status === undefined || p.status === 'ACTIVE'),
        );
        return {
          rows: profile
            ? [
                {
                  id: profile.id,
                  handle: profile.handle,
                  display_name: profile.display_name,
                  avatar_key: profile.avatar_key,
                },
              ]
            : [],
          rowCount: profile ? 1 : 0,
        };
      }

      // SELECT from social.blocks (two-way check)
      if (sqlLower.includes('from social.blocks')) {
        const callerId = String(params[0]);
        const otherId = params[1];

        if (Array.isArray(otherId)) {
          const otherUids = otherId as string[];
          const rows = store.blocks.filter(
            (b) =>
              (b.blocker_id === callerId && otherUids.includes(b.blocked_id)) ||
              (otherUids.includes(b.blocker_id) && b.blocked_id === callerId),
          );
          return { rows, rowCount: rows.length };
        } else {
          const targetId = String(otherId);
          const found = store.blocks.some(
            (b) =>
              (b.blocker_id === callerId && b.blocked_id === targetId) ||
              (b.blocker_id === targetId && b.blocked_id === callerId),
          );
          return { rows: found ? [{ 1: 1 }] : [], rowCount: found ? 1 : 0 };
        }
      }

      // SELECT from social.subscriptions
      if (sqlLower.includes('from social.subscriptions')) {
        const subId = params[0];
        const channelId = String(params[1]);

        if (Array.isArray(subId)) {
          const subIds = subId as string[];
          const rows = store.subscriptions
            .filter((s) => subIds.includes(s.subscriber_id) && s.channel_id === channelId)
            .map((s) => ({ subscriber_id: s.subscriber_id }));
          return { rows, rowCount: rows.length };
        } else {
          const targetSubscriber = String(subId);
          const found = store.subscriptions.some(
            (s) => s.subscriber_id === targetSubscriber && s.channel_id === channelId,
          );
          return { rows: found ? [{ 1: 1 }] : [], rowCount: found ? 1 : 0 };
        }
      }

      // Default fallback
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const mockPool = {
    async connect() {
      return mockClient;
    },
    async query(sqlText: string, params: unknown[] = []) {
      return mockClient.query(sqlText, params);
    },
    on() {},
    end: async () => {},
  };

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: mockPool as unknown as import('pg').Pool,
    }),
  });
}
