import { Kysely, PostgresDialect } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, Role, UserStatus } from '../../src/db/types.js';

export interface MockStore {
  users: Array<{
    id: string;
    email: string;
    email_verified_at: Date | null;
    password_hash: string | null;
    handle: string;
    display_name: string;
    avatar_key: string | null;
    bio?: string | null;
    links?: any;
    banner_key?: string | null;
    is_private?: boolean;
    roles: Role[];
    status: UserStatus;
    suspended_until: Date | null;
    suspension_reason: string | null;
    totp_secret_enc?: Buffer | null;
    totp_key_id?: string | null;
    totp_last_step?: bigint | null;
    totp_enabled_at?: Date | null;
    created_at: Date;
    updated_at: Date;
  }>;
  refresh_tokens: Array<{
    id: string;
    user_id: string;
    family_id: string;
    token_hash: Buffer;
    parent_id: string | null;
    issued_at: Date;
    expires_at: Date;
    rotated_at: Date | null;
    revoked_at: Date | null;
    user_agent: string | null;
    ip: string | null;
  }>;
  oauth_identities: Array<{
    provider: string;
    subject: string;
    user_id: string;
    email: string | null;
    created_at: Date;
  }>;
  outbox: Array<{
    id: string;
    event_id: string;
    subject: string;
    payload: any;
    created_at: Date;
    published_at: Date | null;
  }>;
  audit_log: Array<{
    id: string;
    actor_id: string;
    action: string;
    target_user_id: string | null;
    details: any;
    created_at: Date;
  }>;
  email_tokens: Array<{
    id: string;
    user_id: string;
    purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD';
    token_hash: Buffer;
    email: string;
    created_at: Date;
    expires_at: Date;
    used_at: Date | null;
  }>;
  mail_queue: Array<{
    id: string;
    user_id: string | null;
    to_email: string;
    template:
      'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'PASSWORD_CHANGED' | 'NEW_SIGN_IN' | 'STEP_UP_CODE';
    locale: 'vi' | 'en';
    params: any;
    created_at: Date;
    attempts: number;
    next_attempt_at: Date;
    sent_at: Date | null;
    dead_at: Date | null;
    last_error: string | null;
  }>;
  creator_requests: Array<{
    id: string;
    user_id: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    message: string;
    decision_note: string | null;
    decided_by: string | null;
    decided_at: Date | null;
    created_at: Date;
  }>;
  sessions: Array<{
    id: string;
    user_id: string;
    family_id: string;
    device_label: string | null;
    country: string | null;
    ip_hash: Buffer | null;
    amr: string[];
    step_up_at: Date | null;
    last_used_at: Date;
    revoked_at: Date | null;
    revoke_reason: string | null;
    created_at: Date;
    expires_at: Date;
  }>;
  recovery_codes: Array<{
    id: string;
    user_id: string;
    code_hash: string;
    created_at: Date;
    used_at: Date | null;
  }>;
  passkeys: Array<{
    id: string;
    user_id: string;
    name: string;
    credential_id: Buffer;
    public_key: Buffer;
    sign_count: number;
    transports: string[];
    backup_eligible: boolean;
    backup_state: boolean;
    created_at: Date;
    last_used_at: Date;
  }>;
  security_events: Array<{
    id: string;
    user_id: string;
    kind: string;
    session_id: string | null;
    details: any;
    ip_hash: Buffer | null;
    country: string | null;
    created_at: Date;
  }>;
  ready_images: Array<{
    id: string;
    owner_id: string;
    purpose: 'AVATAR' | 'BANNER' | 'POST';
    image_key: string;
    thumb_key: string | null;
    width: number | null;
    height: number | null;
  }>;
  images: Array<{
    id: string;
    owner_id: string;
    purpose: 'AVATAR' | 'BANNER' | 'POST';
    status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';
    content_type: string;
    size_bytes: number;
    raw_bucket: string;
    raw_key: string;
    image_key: string | null;
    thumb_key: string | null;
    width: number | null;
    height: number | null;
    output_bytes: number | null;
    error: string | null;
    created_at: Date;
    updated_at: Date;
  }>;
}

export function createMockStore(): MockStore {
  return {
    users: [],
    refresh_tokens: [],
    oauth_identities: [],
    outbox: [],
    audit_log: [],
    email_tokens: [],
    mail_queue: [],
    creator_requests: [],
    sessions: [],
    recovery_codes: [],
    passkeys: [],
    security_events: [],
    ready_images: [],
    images: [],
  };
}

export function createMockDb(store: MockStore = createMockStore()): {
  db: Kysely<Database>;
  store: MockStore;
} {
  let idCounter = 1;

  const mockClient = {
    async query(sqlText: string, params: any[] = []) {
      const res = await mockClient.executeMockQuery(sqlText, params);
      const cmd = sqlText.trim().split(/\s+/)[0]?.toUpperCase() || 'SELECT';
      return {
        ...res,
        command: (res as any).command ?? cmd,
        rowCount: res.rowCount ?? (res.rows ? res.rows.length : 0),
      };
    },

    async executeMockQuery(sqlText: string, params: any[] = []) {
      const sql = sqlText.trim();

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      // 1. INSERT INTO "auth"."users"
      if (sql.includes('insert into "auth"."users"')) {
        const colMatch = sql.match(/insert into "auth"."users"\s*\(([^)]+)\)/i);
        const colMap: Record<string, any> = {};
        if (colMatch) {
          const cols = colMatch[1].split(',').map((c) => c.trim().replace(/"/g, ''));
          cols.forEach((col, idx) => {
            colMap[col] = params[idx];
          });
        }

        const id = colMap['id'] ?? params[0];
        const email = colMap['email'] ?? params[1];
        const password_hash =
          colMap['password_hash'] !== undefined ? colMap['password_hash'] : params[2];
        const handle = colMap['handle'] ?? params[3];
        const display_name = colMap['display_name'] ?? params[4];
        const avatar_key = colMap['avatar_key'] ? String(colMap['avatar_key']) : null;
        const email_verified_at = colMap['email_verified_at']
          ? new Date(colMap['email_verified_at'])
          : null;
        const roles = Array.isArray(colMap['roles'])
          ? colMap['roles']
          : Array.isArray(params[6])
            ? params[6]
            : ['viewer', 'creator'];
        const status = (colMap['status'] as UserStatus) || (params[7] as UserStatus) || 'ACTIVE';

        // Check unique constraint on email
        if (store.users.some((u) => u.email.toLowerCase() === String(email).toLowerCase())) {
          const err: any = new Error(
            'duplicate key value violates unique constraint "users_email_key"',
          );
          err.code = '23505';
          err.constraint = 'users_email_key';
          throw err;
        }

        // Check unique constraint on handle
        if (store.users.some((u) => u.handle.toLowerCase() === String(handle).toLowerCase())) {
          const err: any = new Error(
            'duplicate key value violates unique constraint "users_handle_key"',
          );
          err.code = '23505';
          err.constraint = 'users_handle_key';
          throw err;
        }

        const bio =
          colMap['bio'] !== undefined ? (colMap['bio'] ? String(colMap['bio']) : null) : null;
        let links: any = [];
        if (colMap['links'] !== undefined) {
          try {
            links =
              typeof colMap['links'] === 'string' ? JSON.parse(colMap['links']) : colMap['links'];
          } catch {
            links = [];
          }
        }
        const banner_key = colMap['banner_key'] ? String(colMap['banner_key']) : null;
        const is_private =
          colMap['is_private'] !== undefined ? Boolean(colMap['is_private']) : false;

        const newUser = {
          id: String(id),
          email: String(email).toLowerCase(),
          email_verified_at,
          password_hash: password_hash ? String(password_hash) : null,
          handle: String(handle),
          display_name: String(display_name),
          avatar_key: avatar_key ? String(avatar_key) : null,
          bio,
          links,
          banner_key,
          is_private,
          roles: Array.isArray(roles) ? roles : ['viewer', 'creator'],
          status: (status as UserStatus) || 'ACTIVE',
          suspended_until: null,
          suspension_reason: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        store.users.push(newUser);

        return { rows: [newUser], rowCount: 1 };
      }

      // 2. INSERT INTO "auth"."refresh_tokens"
      if (sql.includes('insert into "auth"."refresh_tokens"')) {
        const [id, user_id, family_id, token_hash, parent_id, expires_at, user_agent, ip] = params;

        const newRefreshToken = {
          id: String(id),
          user_id: String(user_id),
          family_id: String(family_id),
          token_hash: Buffer.isBuffer(token_hash) ? token_hash : Buffer.from(token_hash),
          parent_id: parent_id ? String(parent_id) : null,
          issued_at: new Date(),
          expires_at: new Date(expires_at),
          rotated_at: null,
          revoked_at: null,
          user_agent: user_agent ? String(user_agent) : null,
          ip: ip ? String(ip) : null,
        };
        store.refresh_tokens.push(newRefreshToken);

        return { rows: [newRefreshToken], rowCount: 1 };
      }

      // 3. INSERT INTO "auth"."outbox"
      if (
        sql.includes('INSERT INTO "auth"."outbox"') ||
        sql.includes('insert into "auth"."outbox"')
      ) {
        const [event_id, subject, payload] = params;
        const newEvent = {
          id: String(idCounter++),
          event_id: String(event_id),
          subject: String(subject),
          payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
          created_at: new Date(),
          published_at: null,
        };
        store.outbox.push(newEvent);
        return { rows: [newEvent], rowCount: 1 };
      }

      // 4. INSERT INTO "auth"."oauth_identities"
      if (sql.includes('insert into "auth"."oauth_identities"')) {
        const [provider, subject, user_id, email] = params;
        const identity = {
          provider: String(provider),
          subject: String(subject),
          user_id: String(user_id),
          email: email ? String(email).toLowerCase() : null,
          created_at: new Date(),
        };
        store.oauth_identities.push(identity);
        return { rows: [identity], rowCount: 1 };
      }

      // 4b. INSERT INTO "auth"."audit_log"
      if (
        sql.includes('insert into "auth"."audit_log"') ||
        sql.includes('INSERT INTO "auth"."audit_log"')
      ) {
        const [id, actor_id, action, target_user_id, details] = params;
        const entry = {
          id: String(id),
          actor_id: String(actor_id),
          action: String(action),
          target_user_id: target_user_id ? String(target_user_id) : null,
          details: typeof details === 'string' ? JSON.parse(details) : details,
          created_at: new Date(),
        };
        store.audit_log.push(entry);
        return { rows: [entry], rowCount: 1 };
      }

      // 4c. INSERT INTO "auth"."email_tokens"
      if (sql.includes('insert into "auth"."email_tokens"')) {
        const [id, user_id, purpose, token_hash, email, expires_at] = params;
        const entry = {
          id: String(id),
          user_id: String(user_id),
          purpose: purpose as any,
          token_hash: Buffer.isBuffer(token_hash) ? token_hash : Buffer.from(token_hash),
          email: String(email).toLowerCase(),
          created_at: new Date(),
          expires_at: new Date(expires_at),
          used_at: null,
        };
        store.email_tokens.push(entry);
        return { rows: [entry], rowCount: 1 };
      }

      // 4d. INSERT INTO "auth"."mail_queue"
      if (sql.includes('insert into "auth"."mail_queue"')) {
        const [user_id, to_email, template, locale, paramsVal] = params;
        const entry = {
          id: String(idCounter++),
          user_id: user_id ? String(user_id) : null,
          to_email: String(to_email),
          template: template as any,
          locale: (locale || 'vi') as any,
          params: typeof paramsVal === 'string' ? JSON.parse(paramsVal) : paramsVal,
          created_at: new Date(),
          attempts: 0,
          next_attempt_at: new Date(),
          sent_at: null,
          dead_at: null,
          last_error: null,
        };
        store.mail_queue.push(entry);
        return { rows: [entry], rowCount: 1 };
      }

      // 4e. INSERT INTO "auth"."creator_requests"
      if (sql.includes('insert into "auth"."creator_requests"')) {
        const colMatch = sql.match(/insert into "auth"."creator_requests"\s*\(([^)]+)\)/i);
        const colMap: Record<string, any> = {};
        if (colMatch) {
          const cols = colMatch[1].split(',').map((c) => c.trim().replace(/"/g, ''));
          cols.forEach((col, idx) => {
            colMap[col] = params[idx];
          });
        }
        const id = colMap['id'] || params[0];
        const user_id = colMap['user_id'] || params[1];
        const status = colMap['status'] || params[2] || 'PENDING';
        const message = colMap['message'] || params[3];
        const decision_note = colMap['decision_note'] || params[4] || null;
        const decided_by = colMap['decided_by'] || params[5] || null;
        const decided_at = colMap['decided_at'] ? new Date(colMap['decided_at']) : null;

        if (
          status === 'PENDING' &&
          store.creator_requests.some((r) => r.user_id === user_id && r.status === 'PENDING')
        ) {
          const err: any = new Error(
            'duplicate key value violates unique constraint "creator_requests_one_pending"',
          );
          err.code = '23505';
          err.constraint = 'creator_requests_one_pending';
          throw err;
        }

        const newReq = {
          id: String(id),
          user_id: String(user_id),
          status: status as any,
          message: String(message),
          decision_note: decision_note ? String(decision_note) : null,
          decided_by: decided_by ? String(decided_by) : null,
          decided_at,
          created_at: new Date(),
        };
        store.creator_requests.push(newReq);
        return { rows: [newReq], rowCount: 1 };
      }

      // 4f. pg_advisory_xact_lock
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      }

      // 4g. SELECT FROM "auth"."creator_requests"
      if (sql.includes('count(*)') && sql.includes('"auth"."creator_requests"')) {
        const cnt = store.creator_requests.filter((r) => r.status === 'PENDING').length;
        return { rows: [{ count: cnt }], rowCount: 1 };
      }

      if (sql.includes('select') && sql.includes('"auth"."creator_requests"')) {
        let matching = store.creator_requests.map((cr) => {
          const user = store.users.find((u) => u.id === cr.user_id);
          const decider = cr.decided_by ? store.users.find((u) => u.id === cr.decided_by) : null;
          return {
            id: cr.id,
            status: cr.status,
            message: cr.message,
            decision_note: cr.decision_note,
            created_at: cr.created_at,
            decided_at: cr.decided_at,
            created_at_iso: cr.created_at.toISOString(),
            decided_at_iso: cr.decided_at ? cr.decided_at.toISOString() : null,
            user_id: cr.user_id,
            user_email: user?.email || '',
            user_email_verified_at: user?.email_verified_at || null,
            user_handle: user?.handle || '',
            user_display_name: user?.display_name || '',
            user_avatar_key: user?.avatar_key || null,
            user_roles: user?.roles || ['viewer'],
            user_status: user?.status || 'ACTIVE',
            user_suspended_until: user?.suspended_until || null,
            user_suspension_reason: user?.suspension_reason || null,
            user_created_at_iso: user?.created_at
              ? user.created_at.toISOString()
              : new Date().toISOString(),
            decider_id: decider?.id || null,
            decider_handle: decider?.handle || null,
            decider_display_name: decider?.display_name || null,
            decider_avatar_key: decider?.avatar_key || null,
          };
        });

        if (sql.includes('"user_id" = $1')) {
          matching = matching.filter((cr) => cr.user_id === String(params[0]));
        }
        if (sql.includes('"cr"."id" = $1') || sql.includes('"id" = $1')) {
          matching = matching.filter((cr) => cr.id === String(params[0]));
        }
        if (sql.includes('"cr"."status" = $1')) {
          matching = matching.filter((cr) => cr.status === String(params[0]));
        }

        // Ordering
        if (sql.includes('"cr"."created_at" asc')) {
          matching.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        } else if (sql.includes('"created_at" desc')) {
          matching.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        } else if (sql.includes('"cr"."decided_at" desc')) {
          matching.sort((a, b) => (b.decided_at?.getTime() ?? 0) - (a.decided_at?.getTime() ?? 0));
        }

        return { rows: matching, rowCount: matching.length };
      }

      // 5. SELECT FROM "auth"."users"
      if (sql.includes('count(*)') && sql.includes('"auth"."users"')) {
        const cnt = store.users.filter(
          (u) => u.roles.includes('admin') && u.status !== 'DELETED',
        ).length;
        return { rows: [{ cnt }], rowCount: 1 };
      }

      if (sql.includes('select') && sql.includes('"auth"."users"')) {
        let matching = store.users.map((u) => ({
          ...u,
          created_at_iso: u.created_at.toISOString(),
        }));
        if (sql.includes('"email" = $1')) {
          matching = matching.filter((u) => u.email === String(params[0]).toLowerCase());
        }
        if (sql.includes('"id" = $1')) {
          matching = matching.filter((u) => u.id === String(params[0]));
        }
        if (sql.includes('"handle" = $1')) {
          matching = matching.filter((u) => u.handle === String(params[0]));
        }
        return { rows: matching, rowCount: matching.length };
      }

      // 5b. SELECT FROM "auth"."audit_log"
      if (sql.includes('select') && sql.includes('"auth"."audit_log"')) {
        let matching = store.audit_log.map((a) => {
          const actor = store.users.find((u) => u.id === a.actor_id);
          return {
            id: a.id,
            actor_id: a.actor_id,
            action: a.action,
            target_user_id: a.target_user_id,
            details: a.details,
            created_at_iso: a.created_at.toISOString(),
            actor_handle: actor?.handle || 'actor_handle',
            actor_display_name: actor?.display_name || 'Actor Name',
            actor_avatar_key: actor?.avatar_key || null,
          };
        });
        if (sql.includes('"target_user_id" = $1')) {
          matching = matching.filter((a) => a.target_user_id === String(params[0]));
        }
        return { rows: matching, rowCount: matching.length };
      }

      // 6. SELECT FROM "auth"."public_profiles"
      if (sql.includes('select') && sql.includes('"auth"."public_profiles"')) {
        let matching = store.users
          .filter((u) => u.status === 'ACTIVE')
          .map((u) => ({
            id: u.id,
            handle: u.handle,
            display_name: u.display_name,
            avatar_key: u.avatar_key,
            bio: u.bio ?? null,
            links: u.links ?? [],
            banner_key: u.banner_key ?? null,
            is_private: Boolean(u.is_private),
            created_at: u.created_at,
          }));

        if (sql.includes('"handle" = $1')) {
          matching = matching.filter((u) => u.handle === String(params[0]));
        }
        return { rows: matching, rowCount: matching.length };
      }

      // 6b. SELECT FROM "media"."ready_images"
      if (
        sql.includes('select') &&
        (sql.includes('"media"."ready_images"') || sql.includes('media.ready_images'))
      ) {
        const allReady = [
          ...store.ready_images,
          ...store.images
            .filter((img) => img.status === 'READY' && img.image_key !== null)
            .map((img) => ({
              id: img.id,
              owner_id: img.owner_id,
              purpose: img.purpose,
              image_key: img.image_key!,
              thumb_key: img.thumb_key,
              width: img.width,
              height: img.height,
            })),
        ];

        let matching = allReady;
        const colMatch = sql.match(/"id"\s*=\s*\$(\d+)/);
        if (colMatch) {
          const idVal = String(params[parseInt(colMatch[1], 10) - 1]);
          matching = matching.filter((r) => r.id === idVal);
        }
        const ownerMatch = sql.match(/"owner_id"\s*=\s*\$(\d+)/);
        if (ownerMatch) {
          const oVal = String(params[parseInt(ownerMatch[1], 10) - 1]);
          matching = matching.filter((r) => r.owner_id === oVal);
        }
        const purposeMatch = sql.match(/"purpose"\s*=\s*\$(\d+)/);
        if (purposeMatch) {
          const pVal = String(params[parseInt(purposeMatch[1], 10) - 1]);
          matching = matching.filter((r) => r.purpose === pVal);
        }

        return { rows: matching, rowCount: matching.length };
      }

      // 6c. INSERT INTO "media"."images"
      if (
        sql.includes('insert into "media"."images"') ||
        sql.includes('insert into media.images')
      ) {
        const colMatch = sql.match(/insert into ["a-z_.]+\s*\(([^)]+)\)/i);
        const colMap: Record<string, any> = {};
        if (colMatch) {
          const cols = colMatch[1].split(',').map((c) => c.trim().replace(/"/g, ''));
          cols.forEach((col, idx) => {
            colMap[col] = params[idx];
          });
        }
        const newImg = {
          id: String(colMap['id'] ?? params[0]),
          owner_id: String(colMap['owner_id'] ?? params[1]),
          purpose: colMap['purpose'] ?? params[2],
          status: colMap['status'] ?? 'UPLOADING',
          content_type: colMap['content_type'] ?? 'image/jpeg',
          size_bytes: Number(colMap['size_bytes'] ?? 1024),
          raw_bucket: colMap['raw_bucket'] ?? 'raw',
          raw_key: colMap['raw_key'] ?? 'raw_key',
          image_key: colMap['image_key'] ?? null,
          thumb_key: colMap['thumb_key'] ?? null,
          width: colMap['width'] ?? 100,
          height: colMap['height'] ?? 100,
          output_bytes: colMap['output_bytes'] ?? 100,
          error: colMap['error'] ?? null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        store.images.push(newImg);
        if (newImg.status === 'READY' && newImg.image_key) {
          store.ready_images.push({
            id: newImg.id,
            owner_id: newImg.owner_id,
            purpose: newImg.purpose,
            image_key: newImg.image_key,
            thumb_key: newImg.thumb_key,
            width: newImg.width,
            height: newImg.height,
          });
        }
        return { rows: [newImg], rowCount: 1 };
      }

      // 7. SELECT FROM "auth"."refresh_tokens"
      if (sql.includes('select') && sql.includes('"auth"."refresh_tokens"')) {
        let matching = [...store.refresh_tokens];
        if (sql.includes('"token_hash" = $1')) {
          const targetHash = Buffer.isBuffer(params[0]) ? params[0] : Buffer.from(params[0]);
          matching = matching.filter((t) => t.token_hash.equals(targetHash));
        }
        if (sql.includes('"family_id" = $1')) {
          matching = matching.filter((t) => t.family_id === String(params[0]));
        }
        return { rows: matching, rowCount: matching.length };
      }

      // 8. SELECT FROM "auth"."oauth_identities"
      if (sql.includes('select') && sql.includes('"auth"."oauth_identities"')) {
        let matching = [...store.oauth_identities];
        if (sql.includes('"provider" = $1') && sql.includes('"subject" = $2')) {
          matching = matching.filter(
            (i) => i.provider === String(params[0]) && i.subject === String(params[1]),
          );
        }
        return { rows: matching, rowCount: matching.length };
      }

      // 8b. DELETE FROM "auth"."oauth_identities"
      if (sql.includes('delete from "auth"."oauth_identities"')) {
        const userId = String(params[0]);
        const before = store.oauth_identities.length;
        store.oauth_identities = store.oauth_identities.filter((o) => o.user_id !== userId);
        return { rows: [], rowCount: before - store.oauth_identities.length };
      }

      // 8c. SELECT FROM "auth"."email_tokens"
      if (sql.includes('select') && sql.includes('"auth"."email_tokens"')) {
        let matching = [...store.email_tokens];
        if (sql.includes('"user_id" = $1') && sql.includes('"purpose" = $2')) {
          const userId = String(params[0]);
          const purpose = String(params[1]);
          matching = matching.filter((t) => t.user_id === userId && t.purpose === purpose);
          if (sql.includes('"created_at" > $3')) {
            const since = new Date(params[2]);
            matching = matching.filter((t) => t.created_at > since);
          }
          if (sql.includes('count(*)')) {
            return { rows: [{ cnt: matching.length }], rowCount: 1 };
          }
          if (sql.includes('order by "created_at" asc')) {
            matching.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
          }
          return { rows: matching, rowCount: matching.length };
        }
        if (sql.includes('"token_hash" = $1')) {
          const targetHash = Buffer.isBuffer(params[0]) ? params[0] : Buffer.from(params[0]);
          matching = matching.filter((t) => t.token_hash.equals(targetHash));
          return { rows: matching, rowCount: matching.length };
        }
        return { rows: matching, rowCount: matching.length };
      }

      // 8d. SELECT FROM "auth"."mail_queue"
      if (
        (sql.includes('select') || sql.includes('SELECT')) &&
        (sql.includes('"auth"."mail_queue"') || sql.includes('auth.mail_queue'))
      ) {
        if (sql.includes('count(*)')) {
          const cnt = store.mail_queue.filter(
            (m) => m.sent_at === null && m.dead_at === null,
          ).length;
          return { rows: [{ cnt }], rowCount: 1 };
        }
        let matching = store.mail_queue.filter((m) => m.sent_at === null && m.dead_at === null);
        if (sql.toLowerCase().includes('next_attempt_at <=')) {
          const maxDate = new Date(params[0]);
          matching = matching.filter((m) => m.next_attempt_at <= maxDate);
        }
        matching.sort((a, b) => a.next_attempt_at.getTime() - b.next_attempt_at.getTime());
        return { rows: matching, rowCount: matching.length };
      }

      // 8e. UPDATE "auth"."email_tokens"
      if (sql.includes('update "auth"."email_tokens"')) {
        let updatedCount = 0;
        if (sql.includes('"token_hash" =')) {
          const targetHash = Buffer.isBuffer(params[0]) ? params[0] : Buffer.from(params[0]);
          const purpose = params.length > 1 ? String(params[1]) : undefined;
          const token = store.email_tokens.find((t) => {
            if (!t.token_hash.equals(targetHash)) return false;
            if (purpose && t.purpose !== purpose) return false;
            if (sql.includes('"used_at" is null') && t.used_at !== null) return false;
            if (sql.includes('"expires_at" >') && t.expires_at <= new Date()) return false;
            return true;
          });
          if (token) {
            token.used_at = new Date();
            updatedCount++;
            if (sql.toLowerCase().includes('returning')) {
              return { rows: [{ user_id: token.user_id, email: token.email }], rowCount: 1 };
            }
          }
          return { rows: [], rowCount: updatedCount };
        }

        if (
          sql.includes('"user_id" =') &&
          sql.includes('"purpose" =') &&
          sql.includes('"used_at" is null')
        ) {
          const usedAt = params[0] ? new Date(params[0]) : new Date();
          const userId = String(params[1]);
          const purpose = String(params[2]);
          for (const token of store.email_tokens) {
            if (token.user_id === userId && token.purpose === purpose && token.used_at === null) {
              token.used_at = usedAt;
              updatedCount++;
            }
          }
        } else if (sql.includes('"id" =')) {
          const usedAt = params[0] ? new Date(params[0]) : new Date();
          const tokenId = String(params[1]);
          const token = store.email_tokens.find((t) => t.id === tokenId);
          if (token) {
            token.used_at = usedAt;
            updatedCount++;
          }
        }
        return { rows: [], rowCount: updatedCount };
      }

      // 8f. UPDATE "auth"."mail_queue"
      if (sql.includes('update "auth"."mail_queue"') || sql.includes('update auth.mail_queue')) {
        let updatedCount = 0;
        const idParam = String(params[params.length - 1]);
        const entry = store.mail_queue.find((m) => m.id === idParam);
        if (entry) {
          const matchAttempts = sql.match(/"attempts"\s*=\s*\$(\d+)/);
          if (matchAttempts) {
            entry.attempts = Number(params[parseInt(matchAttempts[1], 10) - 1]);
          }
          const matchDeadAt = sql.match(/"dead_at"\s*=\s*\$(\d+)/);
          if (matchDeadAt) {
            entry.dead_at = new Date(params[parseInt(matchDeadAt[1], 10) - 1]);
          }
          const matchNext = sql.match(/"next_attempt_at"\s*=\s*\$(\d+)/);
          if (matchNext) {
            entry.next_attempt_at = new Date(params[parseInt(matchNext[1], 10) - 1]);
          }
          const matchLastError = sql.match(/"last_error"\s*=\s*\$(\d+)/);
          if (matchLastError) {
            const lIdx = parseInt(matchLastError[1], 10) - 1;
            entry.last_error = params[lIdx] ? String(params[lIdx]) : null;
          }
          const matchSentAt = sql.match(/"sent_at"\s*=\s*\$(\d+)/);
          if (matchSentAt) {
            entry.sent_at = new Date(params[parseInt(matchSentAt[1], 10) - 1]);
          }
          if (sql.includes('"params" = null') || sql.match(/"params"\s*=\s*\$(\d+)/)) {
            entry.params = null;
          }
          updatedCount++;
        }
        return { rows: [], rowCount: updatedCount };
      }

      // 8g. DELETE FROM "auth"."email_tokens"
      if (sql.includes('delete from "auth"."email_tokens"')) {
        const userId = String(params[0]);
        const before = store.email_tokens.length;
        store.email_tokens = store.email_tokens.filter(
          (t) => !(t.user_id === userId && t.used_at === null),
        );
        return { rows: [], rowCount: before - store.email_tokens.length };
      }

      // 8h. DELETE FROM "auth"."mail_queue"
      if (sql.includes('delete from "auth"."mail_queue"')) {
        if (sql.includes('"user_id" =')) {
          const userId = String(params[0]);
          const before = store.mail_queue.length;
          store.mail_queue = store.mail_queue.filter(
            (m) => !(m.user_id === userId && m.sent_at === null && m.dead_at === null),
          );
          return { rows: [], rowCount: before - store.mail_queue.length };
        }
        if (sql.includes('"created_at" <')) {
          const cutoff = new Date(params[0]);
          const before = store.mail_queue.length;
          store.mail_queue = store.mail_queue.filter((m) => m.created_at >= cutoff);
          return { rows: [], rowCount: before - store.mail_queue.length };
        }
      }

      // 8i. UPDATE "auth"."creator_requests"
      if (sql.includes('update "auth"."creator_requests"')) {
        let updatedCount = 0;
        const reqId = String(params[params.length - 1]);
        const req = store.creator_requests.find((r) => r.id === reqId);
        if (req) {
          const matchStatus = sql.match(/"status"\s*=\s*\$(\d+)/);
          if (matchStatus) {
            req.status = params[parseInt(matchStatus[1], 10) - 1];
          }
          const matchNote = sql.match(/"decision_note"\s*=\s*\$(\d+)/);
          if (matchNote) {
            const val = params[parseInt(matchNote[1], 10) - 1];
            req.decision_note = val ? String(val) : null;
          }
          const matchDecidedBy = sql.match(/"decided_by"\s*=\s*\$(\d+)/);
          if (matchDecidedBy) {
            const val = params[parseInt(matchDecidedBy[1], 10) - 1];
            req.decided_by = val ? String(val) : null;
          }
          const matchDecidedAt = sql.match(/"decided_at"\s*=\s*\$(\d+)/);
          if (matchDecidedAt) {
            const val = params[parseInt(matchDecidedAt[1], 10) - 1];
            req.decided_at = val ? new Date(val) : new Date();
          }
          updatedCount++;
        }
        return { rows: req ? [req] : [], rowCount: updatedCount };
      }

      // 9. UPDATE "auth"."refresh_tokens"
      if (sql.includes('update "auth"."refresh_tokens"')) {
        let updatedCount = 0;

        // Family revocation: SET revoked_at = now() WHERE family_id = ...
        if (
          sql.includes('"revoked_at" =') &&
          sql.includes('"family_id" =') &&
          !sql.includes('"family_id" !=')
        ) {
          const familyId = String(params.length > 1 ? params[1] : params[0]);
          for (const token of store.refresh_tokens) {
            if (token.family_id === familyId && !token.revoked_at) {
              token.revoked_at = new Date();
              updatedCount++;
            }
          }
        } else if (sql.includes('"revoked_at" =') && sql.includes('"user_id" =')) {
          const userId = String(params[1]);
          let exceptFamily: string | null = null;
          if (sql.includes('"family_id" !=') || sql.includes('"family_id" <>')) {
            exceptFamily = String(params[2]);
          }
          const returningRows: Array<{ family_id: string }> = [];
          for (const token of store.refresh_tokens) {
            if (token.user_id === userId && !token.revoked_at) {
              if (exceptFamily && token.family_id === exceptFamily) {
                continue;
              }
              token.revoked_at = new Date();
              updatedCount++;
              returningRows.push({ family_id: token.family_id });
            }
          }
          if (sql.toLowerCase().includes('returning')) {
            return { rows: returningRows, rowCount: updatedCount };
          }
        } else if (sql.includes('"rotated_at" =') && sql.includes('"id" =')) {
          const tokenId = String(params.length > 1 ? params[1] : params[0]);
          const token = store.refresh_tokens.find((t) => t.id === tokenId);
          if (token) {
            token.rotated_at = new Date();
            updatedCount++;
          }
        }

        return { rows: [], rowCount: updatedCount };
      }

      // 10. UPDATE "auth"."users"
      if (sql.includes('update "auth"."users"')) {
        let updatedCount = 0;
        const userId = String(params[params.length - 1]);
        const user = store.users.find((u) => u.id === userId);
        if (user) {
          const matchHandle = sql.match(/"handle"\s*=\s*\$(\d+)/);
          if (matchHandle) {
            const handleVal = String(params[parseInt(matchHandle[1], 10) - 1]);
            if (
              store.users.some(
                (u) => u.id !== user.id && u.handle.toLowerCase() === handleVal.toLowerCase(),
              )
            ) {
              const err: any = new Error(
                'duplicate key value violates unique constraint "users_handle_key"',
              );
              err.code = '23505';
              err.constraint = 'users_handle_key';
              throw err;
            }
            user.handle = handleVal;
          }

          const matchDisplayName = sql.match(/"display_name"\s*=\s*\$(\d+)/);
          if (matchDisplayName) {
            user.display_name = String(params[parseInt(matchDisplayName[1], 10) - 1]);
          }

          const matchPasswordHash = sql.match(/"password_hash"\s*=\s*\$(\d+)/);
          if (matchPasswordHash) {
            const pIdx = parseInt(matchPasswordHash[1], 10) - 1;
            user.password_hash = params[pIdx] ? String(params[pIdx]) : null;
          }

          const matchEmail = sql.match(/"email"\s*=\s*\$(\d+)/);
          if (matchEmail) {
            user.email = String(params[parseInt(matchEmail[1], 10) - 1]);
          }

          const matchAvatarKey = sql.match(/"avatar_key"\s*=\s*\$(\d+)/);
          if (matchAvatarKey) {
            const aIdx = parseInt(matchAvatarKey[1], 10) - 1;
            user.avatar_key = params[aIdx] ? String(params[aIdx]) : null;
          }

          const matchBio = sql.match(/"bio"\s*=\s*\$(\d+)/);
          if (matchBio) {
            const bIdx = parseInt(matchBio[1], 10) - 1;
            user.bio = params[bIdx] ? String(params[bIdx]) : null;
          }

          const matchLinks = sql.match(/"links"\s*=\s*\$(\d+)/);
          if (matchLinks) {
            const lIdx = parseInt(matchLinks[1], 10) - 1;
            try {
              user.links =
                typeof params[lIdx] === 'string' ? JSON.parse(params[lIdx]) : (params[lIdx] ?? []);
            } catch {
              user.links = [];
            }
          }

          const matchBannerKey = sql.match(/"banner_key"\s*=\s*\$(\d+)/);
          if (matchBannerKey) {
            const bkIdx = parseInt(matchBannerKey[1], 10) - 1;
            user.banner_key = params[bkIdx] ? String(params[bkIdx]) : null;
          }

          const matchIsPrivate = sql.match(/"is_private"\s*=\s*\$(\d+)/);
          if (matchIsPrivate) {
            const pIdx = parseInt(matchIsPrivate[1], 10) - 1;
            user.is_private = Boolean(params[pIdx]);
          }

          if (sql.includes('"avatar_key" = null')) {
            user.avatar_key = null;
          }
          if (sql.includes('"bio" = null')) {
            user.bio = null;
          }
          if (sql.includes('"links" = null') || sql.includes(`"links" = '[]'`)) {
            user.links = [];
          }
          if (sql.includes('"banner_key" = null')) {
            user.banner_key = null;
          }
          if (sql.includes('"is_private" = false')) {
            user.is_private = false;
          }

          const matchEmailVerifiedCoalesce = sql.match(
            /"email_verified_at"\s*=\s*coalesce\([^,]+,\s*\$(\d+)\)/i,
          );
          if (matchEmailVerifiedCoalesce) {
            const eIdx = parseInt(matchEmailVerifiedCoalesce[1], 10) - 1;
            user.email_verified_at =
              user.email_verified_at ?? (params[eIdx] ? new Date(params[eIdx]) : new Date());
          } else {
            const matchEmailVerified = sql.match(/"email_verified_at"\s*=\s*\$(\d+)/);
            if (matchEmailVerified) {
              const eIdx = parseInt(matchEmailVerified[1], 10) - 1;
              user.email_verified_at = params[eIdx] ? new Date(params[eIdx]) : null;
            }
          }

          const matchStatus = sql.match(/"status"\s*=\s*\$(\d+)/);
          if (matchStatus) {
            user.status = params[parseInt(matchStatus[1], 10) - 1];
          }

          const matchSuspendedUntil = sql.match(/"suspended_until"\s*=\s*\$(\d+)/);
          if (matchSuspendedUntil) {
            const sIdx = parseInt(matchSuspendedUntil[1], 10) - 1;
            user.suspended_until = params[sIdx] ? new Date(params[sIdx]) : null;
          }

          const matchSuspensionReason = sql.match(/"suspension_reason"\s*=\s*\$(\d+)/);
          if (matchSuspensionReason) {
            const rIdx = parseInt(matchSuspensionReason[1], 10) - 1;
            user.suspension_reason = params[rIdx] ? String(params[rIdx]) : null;
          }

          const matchRoles = sql.match(/"roles"\s*=\s*\$(\d+)/);
          if (matchRoles) {
            user.roles = params[parseInt(matchRoles[1], 10) - 1];
          }

          const matchTotpSecret = sql.match(/"totp_secret_enc"\s*=\s*\$(\d+)/);
          if (matchTotpSecret) {
            user.totp_secret_enc = params[parseInt(matchTotpSecret[1], 10) - 1];
          }
          const matchTotpKey = sql.match(/"totp_key_id"\s*=\s*\$(\d+)/);
          if (matchTotpKey) {
            user.totp_key_id = params[parseInt(matchTotpKey[1], 10) - 1];
          }
          const matchTotpEnabled = sql.match(/"totp_enabled_at"\s*=\s*\$(\d+)/);
          if (matchTotpEnabled) {
            const val = params[parseInt(matchTotpEnabled[1], 10) - 1];
            user.totp_enabled_at = val ? new Date(val) : null;
          }
          const matchTotpStep = sql.match(/"totp_last_step"\s*=\s*\$(\d+)/);
          if (matchTotpStep) {
            const rawStep = params[parseInt(matchTotpStep[1], 10) - 1];
            if (rawStep == null) {
              user.totp_last_step = null;
            } else {
              const stepVal = BigInt(rawStep);
              // Replay protection atomic check: WHERE totp_last_step IS NULL OR totp_last_step < $step
              if (user.totp_last_step != null && user.totp_last_step >= stepVal) {
                return { rows: [], rowCount: 0 };
              }
              user.totp_last_step = stepVal;
            }
          }

          user.updated_at = new Date();
          updatedCount++;
        }
        if (sql.toLowerCase().includes('returning')) {
          return { rows: user ? [user] : [], rowCount: updatedCount };
        }
        return { rows: [], rowCount: updatedCount };
      }

      // 11. SESSIONS
      if (sql.includes('insert into "auth"."sessions"')) {
        const colMatch = sql.match(/insert into "auth"."sessions"\s*\(([^)]+)\)/i);
        const colMap: Record<string, any> = {};
        if (colMatch) {
          const cols = colMatch[1].split(',').map((c) => c.trim().replace(/"/g, ''));
          cols.forEach((col, idx) => {
            colMap[col] = params[idx];
          });
        }
        const session = {
          id: colMap['id'] ?? uuidv7(),
          user_id: colMap['user_id'] ?? params[0],
          family_id: colMap['family_id'] ?? params[1],
          device_label: colMap['device_label'] ?? null,
          country: colMap['country'] ?? null,
          ip_hash: colMap['ip_hash'] ?? null,
          amr: colMap['amr'] ?? ['pwd'],
          step_up_at: colMap['step_up_at'] ? new Date(colMap['step_up_at']) : null,
          last_used_at: colMap['last_used_at'] ? new Date(colMap['last_used_at']) : new Date(),
          revoked_at: colMap['revoked_at'] ? new Date(colMap['revoked_at']) : null,
          revoke_reason: colMap['revoke_reason'] ?? null,
          created_at: colMap['created_at'] ? new Date(colMap['created_at']) : new Date(),
          expires_at: colMap['expires_at']
            ? new Date(colMap['expires_at'])
            : new Date(Date.now() + 30 * 86400000),
        };

        const existingIdx = store.sessions.findIndex((s) => s.id === session.id);
        if (existingIdx >= 0) {
          if (sql.toLowerCase().includes('on conflict')) {
            return { rows: [], rowCount: 0 };
          }
          const err: any = new Error(
            'duplicate key value violates unique constraint "sessions_pkey"',
          );
          err.code = '23505';
          throw err;
        }

        store.sessions.push(session);
        return { rows: [session], rowCount: 1 };
      }

      if (sql.includes('select') && sql.includes('"auth"."sessions"')) {
        let matching = [...store.sessions];
        if (sql.includes('"user_id" =')) {
          const uIdx = sql.indexOf('"user_id" =');
          const m = sql.slice(uIdx).match(/"user_id"\s*=\s*\$(\d+)/);
          if (m) {
            const uid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((s) => s.user_id === uid);
          }
        }
        if (sql.includes('"id" =')) {
          const m = sql.match(/"id"\s*=\s*\$(\d+)/);
          if (m) {
            const sid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((s) => s.id === sid);
          }
        }
        if (sql.includes('"id" !=') || sql.includes('"id" <>')) {
          const m = sql.match(/"id"\s*(?:!=|<>)\s*\$(\d+)/);
          if (m) {
            const sid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((s) => s.id !== sid);
          }
        }
        if (sql.includes('"family_id" =')) {
          const m = sql.match(/"family_id"\s*=\s*\$(\d+)/);
          if (m) {
            const fid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((s) => s.family_id === fid);
          }
        }
        if (sql.includes('"revoked_at" is null')) {
          matching = matching.filter((s) => s.revoked_at === null);
        }
        return { rows: matching, rowCount: matching.length };
      }

      if (sql.includes('update "auth"."sessions"')) {
        let updatedCount = 0;
        let matching = [...store.sessions];
        if (sql.includes('"id" =')) {
          const m = sql.match(/"id"\s*=\s*\$(\d+)/);
          if (m) {
            const sid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((s) => s.id === sid);
          }
        }
        if (sql.includes('"id" !=') || sql.includes('"id" <>')) {
          const m = sql.match(/"id"\s*(?:!=|<>)\s*\$(\d+)/);
          if (m) {
            const sid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((s) => s.id !== sid);
          }
        }
        if (sql.includes('"family_id" =')) {
          const m = sql.match(/"family_id"\s*=\s*\$(\d+)/);
          if (m) {
            const fid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((s) => s.family_id === fid);
          }
        }
        if (sql.includes('"user_id" =')) {
          const m = sql.match(/"user_id"\s*=\s*\$(\d+)/);
          if (m) {
            const uid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((s) => s.user_id === uid);
          }
        }
        if (sql.includes('"id" !=') || sql.includes('"id" <>')) {
          const m = sql.match(/"id"\s*(?:!=|<>)\s*\$(\d+)/);
          if (m) {
            const sid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((s) => s.id !== sid);
          }
        }
        if (sql.includes('"revoked_at" is null')) {
          matching = matching.filter((s) => s.revoked_at === null);
        }

        const matchStepUpAt = sql.match(/"step_up_at"\s*=\s*\$(\d+)/);
        const matchLastUsedAt = sql.match(/"last_used_at"\s*=\s*\$(\d+)/);
        const matchRevokedAt = sql.match(/"revoked_at"\s*=\s*\$(\d+)/);
        const matchRevokeReason = sql.match(/"revoke_reason"\s*=\s*\$(\d+)/);

        for (const s of matching) {
          if (matchStepUpAt) {
            s.step_up_at = params[parseInt(matchStepUpAt[1], 10) - 1]
              ? new Date(params[parseInt(matchStepUpAt[1], 10) - 1])
              : new Date();
          }
          if (matchLastUsedAt) {
            s.last_used_at = params[parseInt(matchLastUsedAt[1], 10) - 1]
              ? new Date(params[parseInt(matchLastUsedAt[1], 10) - 1])
              : new Date();
          }
          if (matchRevokedAt) {
            s.revoked_at = params[parseInt(matchRevokedAt[1], 10) - 1]
              ? new Date(params[parseInt(matchRevokedAt[1], 10) - 1])
              : new Date();
          }
          if (matchRevokeReason) {
            s.revoke_reason = String(params[parseInt(matchRevokeReason[1], 10) - 1]);
          }
          updatedCount++;
        }
        return { rows: matching, rowCount: updatedCount };
      }

      // 12. RECOVERY CODES
      if (sql.includes('insert into "auth"."recovery_codes"')) {
        const colMatch = sql.match(/insert into "auth"."recovery_codes"\s*\(([^)]+)\)/i);
        const colMap: Record<string, any> = {};
        if (colMatch) {
          const cols = colMatch[1].split(',').map((c) => c.trim().replace(/"/g, ''));
          cols.forEach((col, idx) => {
            colMap[col] = params[idx];
          });
        }
        const rec = {
          id: colMap['id'] ?? uuidv7(),
          user_id: colMap['user_id'] ?? params[1] ?? params[0],
          code_hash: colMap['code_hash'] ?? params[2] ?? params[1],
          created_at: colMap['created_at'] ? new Date(colMap['created_at']) : new Date(),
          used_at: colMap['used_at'] ? new Date(colMap['used_at']) : null,
        };
        store.recovery_codes.push(rec);
        return { rows: [rec], rowCount: 1 };
      }

      if (sql.includes('select') && sql.includes('"auth"."recovery_codes"')) {
        let matching = [...store.recovery_codes];
        if (sql.includes('"user_id" =')) {
          const uIdx = sql.indexOf('"user_id" =');
          const m = sql.slice(uIdx).match(/"user_id"\s*=\s*\$(\d+)/);
          if (m) {
            const uid = String(params[parseInt(m[1], 10) - 1]);
            matching = matching.filter((r) => r.user_id === uid);
          }
        }
        if (sql.includes('"used_at" is null')) {
          matching = matching.filter((r) => r.used_at === null);
        }
        if (sql.includes('count(')) {
          return { rows: [{ cnt: matching.length, count: matching.length }], rowCount: 1 };
        }
        return { rows: matching, rowCount: matching.length };
      }

      if (sql.includes('update "auth"."recovery_codes"')) {
        let updatedCount = 0;
        const idMatch = sql.match(/"id"\s*=\s*\$(\d+)/);
        if (idMatch) {
          const id = params[parseInt(idMatch[1], 10) - 1];
          const row = store.recovery_codes.find((r) => r.id === id);
          if (row) {
            row.used_at = new Date();
            updatedCount = 1;
          }
        }
        return { rows: [], rowCount: updatedCount };
      }

      if (sql.includes('delete from "auth"."recovery_codes"')) {
        const uid = params[0];
        const before = store.recovery_codes.length;
        store.recovery_codes = store.recovery_codes.filter((r) => r.user_id !== uid);
        return { rows: [], rowCount: before - store.recovery_codes.length };
      }

      // 13. PASSKEYS
      if (sql.includes('select') && sql.includes('"auth"."passkeys"')) {
        let matching = [...store.passkeys];
        if (sql.includes('"user_id" =')) {
          matching = matching.filter((p) => p.user_id === params[0]);
        }
        if (sql.includes('count(')) {
          return { rows: [{ count: matching.length }], rowCount: 1 };
        }
        return { rows: matching, rowCount: matching.length };
      }

      // 14. SECURITY EVENTS
      if (sql.includes('insert into "auth"."security_events"')) {
        const colMatch = sql.match(/insert into "auth"."security_events"\s*\(([^)]+)\)/i);
        const colMap: Record<string, any> = {};
        if (colMatch) {
          const cols = colMatch[1].split(',').map((c) => c.trim().replace(/"/g, ''));
          cols.forEach((col, idx) => {
            colMap[col] = params[idx];
          });
        }
        const event = {
          id: colMap['id'] ?? uuidv7(),
          user_id: colMap['user_id'] ?? params[0],
          kind: colMap['kind'] ?? params[1],
          session_id: colMap['session_id'] ?? null,
          details: colMap['details'] ?? {},
          ip_hash: colMap['ip_hash'] ?? null,
          country: colMap['country'] ?? null,
          created_at: colMap['created_at'] ? new Date(colMap['created_at']) : new Date(),
        };
        store.security_events.push(event);
        return { rows: [event], rowCount: 1 };
      }

      // Default fallback
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  const mockPool = {
    connect: async () => mockClient,
    query: mockClient.query,
  };

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: mockPool as any,
    }),
  });

  return { db, store };
}
