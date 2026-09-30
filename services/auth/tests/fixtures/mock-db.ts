import { Kysely, PostgresDialect } from 'kysely';
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
    roles: Role[];
    status: UserStatus;
    suspended_until: Date | null;
    suspension_reason: string | null;
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
}

export function createMockStore(): MockStore {
  return {
    users: [],
    refresh_tokens: [],
    oauth_identities: [],
    outbox: [],
    audit_log: [],
  };
}

export function createMockDb(store: MockStore = createMockStore()): {
  db: Kysely<Database>;
  store: MockStore;
} {
  let idCounter = 1;

  const mockClient = {
    async query(sqlText: string, params: any[] = []) {
      const sql = sqlText.trim();

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      // 1. INSERT INTO "auth"."users"
      if (sql.includes('insert into "auth"."users"')) {
        // Find values
        // Parameters: id, email, password_hash, handle, display_name, avatar_key, roles, status
        const [id, email, password_hash, handle, display_name, avatar_key, roles, status] = params;

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

        const newUser = {
          id: String(id),
          email: String(email).toLowerCase(),
          email_verified_at: null,
          password_hash: password_hash ? String(password_hash) : null,
          handle: String(handle),
          display_name: String(display_name),
          avatar_key: avatar_key ? String(avatar_key) : null,
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

      // 4c. pg_advisory_xact_lock
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
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
          }));

        if (sql.includes('"handle" = $1')) {
          matching = matching.filter((u) => u.handle === String(params[0]));
        }
        return { rows: matching, rowCount: matching.length };
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

      // 9. UPDATE "auth"."refresh_tokens"
      if (sql.includes('update "auth"."refresh_tokens"')) {
        let updatedCount = 0;

        // Family revocation: SET revoked_at = now() WHERE family_id = ...
        if (sql.includes('"revoked_at" =') && sql.includes('"family_id" =')) {
          const familyId = String(params.length > 1 ? params[1] : params[0]);
          for (const token of store.refresh_tokens) {
            if (token.family_id === familyId && !token.revoked_at) {
              token.revoked_at = new Date();
              updatedCount++;
            }
          }
        } else if (sql.includes('"revoked_at" =') && sql.includes('"user_id" =')) {
          const userId = String(params.length > 1 ? params[1] : params[0]);
          for (const token of store.refresh_tokens) {
            if (token.user_id === userId && !token.revoked_at) {
              token.revoked_at = new Date();
              updatedCount++;
            }
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
        if (sql.includes('"password_hash" = $1') && sql.includes('"id" = $2')) {
          const user = store.users.find((u) => u.id === String(params[1]));
          if (user) {
            user.password_hash = String(params[0]);
            updatedCount++;
          }
        }
        if (sql.includes('"email_verified_at" = $1') && sql.includes('"id" = $2')) {
          const user = store.users.find((u) => u.id === String(params[1]));
          if (user) {
            user.email_verified_at = new Date(params[0]);
            updatedCount++;
          }
        }
        if (sql.includes('"roles" =')) {
          // Update roles
          const userId = String(params[params.length - 1]);
          const user = store.users.find((u) => u.id === userId);
          if (user) {
            user.roles = params[0];
            updatedCount++;
          }
        }
        if (sql.includes('"status" =')) {
          const userId = String(params[params.length - 1]);
          const user = store.users.find((u) => u.id === userId);
          if (user) {
            user.status = params[0];
            if (sql.includes('"suspension_reason" =')) {
              user.suspension_reason = params[1] || null;
              user.suspended_until = params[2] ? new Date(params[2]) : null;
            } else {
              user.suspension_reason = null;
              user.suspended_until = null;
            }
            updatedCount++;
          }
        }
        return { rows: [], rowCount: updatedCount };
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
