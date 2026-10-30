import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, ConversationKind, MemberRole, MemberState } from '../db/types.js';
import type { Kysely } from 'kysely';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import {
  buildCreateConversationRateLimitKey,
  buildMessageRequestRateLimitKey,
} from '../rate-limit/valkey-limiter.js';
import type { RealtimeHintDispatcher } from '../realtime/hints.js';

export interface ConversationsRouteDependencies {
  db: Kysely<Database>;
  hints: RealtimeHintDispatcher;
  rateLimiter?: RateLimiter;
}

interface CursorPayload {
  t: string;
  id: string;
}

interface PublicProfileDto {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

export const conversationsRoute: FastifyPluginAsync<ConversationsRouteDependencies> = async (
  fastify,
  { db, hints, rateLimiter },
) => {
  // Helper to build a complete Conversation object
  async function buildConversationDto(
    convId: string,
    callerUserId: string,
  ): Promise<Record<string, unknown>> {
    const conv = await db
      .selectFrom('chat.conversations')
      .selectAll()
      .where('id', '=', convId)
      .executeTakeFirst();

    if (!conv) {
      throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
    }

    const members = await db
      .selectFrom('chat.members')
      .selectAll()
      .where('conversation_id', '=', convId)
      .execute();

    const callerMember = members.find((m) => m.user_id === callerUserId);
    if (!callerMember) {
      throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
    }

    // Filter out LEFT members for public list
    const visibleMembers = members.filter((m) => m.state === 'ACTIVE' || m.state === 'REQUESTED');

    // Sort: OWNER first, then by join time (joined_seq, created_at)
    visibleMembers.sort((a, b) => {
      if (a.role === 'OWNER' && b.role !== 'OWNER') return -1;
      if (b.role === 'OWNER' && a.role !== 'OWNER') return 1;
      const aSeq = BigInt(a.joined_seq);
      const bSeq = BigInt(b.joined_seq);
      if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    const userIds = visibleMembers.map((m) => m.user_id);
    const profiles =
      userIds.length > 0
        ? await db
            .selectFrom('auth.public_profiles')
            .select(['id', 'handle', 'display_name', 'avatar_key'])
            .where('id', 'in', userIds)
            .execute()
        : [];

    const profileMap = new Map<string, PublicProfileDto>(
      profiles.map((p) => [
        p.id,
        {
          id: p.id,
          handle: p.handle,
          display_name: p.display_name,
          avatar_url: p.avatar_key ? `https://media.winkey.vn/${p.avatar_key}` : null,
        },
      ]),
    );

    // Compute unread_count: messages after max(last_read_seq, joined_seq - 1) not sent by caller, capped at 99
    const unreadRes = await sql<{ count: string }>`
      SELECT LEAST(99, count(*)) AS count
      FROM (
        SELECT 1
        FROM chat.messages msg
        WHERE msg.conversation_id = ${convId}::uuid
          AND msg.seq > GREATEST(${callerMember.last_read_seq}::bigint, ${callerMember.joined_seq}::bigint - 1)
          AND (msg.sender_id IS NULL OR msg.sender_id != ${callerUserId}::uuid)
        LIMIT 100
      ) sub
    `.execute(db);

    const unreadCount = Number(unreadRes.rows[0]?.count ?? 0);

    return {
      id: conv.id,
      kind: conv.kind,
      title: conv.title,
      members: visibleMembers.map((m) => ({
        user_id: m.user_id,
        user: profileMap.get(m.user_id) ?? null,
        role: m.role,
        state: m.state,
      })),
      my_role: callerMember.role,
      my_state: callerMember.state,
      last_seq: Number(conv.last_seq),
      last_message_at: conv.last_message_at ? new Date(conv.last_message_at).toISOString() : null,
      unread_count: unreadCount,
      muted_until: callerMember.muted_until
        ? new Date(callerMember.muted_until).toISOString()
        : null,
      created_at: new Date(conv.created_at).toISOString(),
    };
  }

  // 1. GET /v1/chat/conversations - List caller's conversations
  fastify.get<{
    Querystring: { state?: string; cursor?: string; limit?: string };
  }>('/v1/chat/conversations', async (request, reply) => {
    const caller = requireAuth(request);
    const stateParam = request.query.state ?? 'ACTIVE';

    if (stateParam !== 'ACTIVE' && stateParam !== 'REQUESTED') {
      throw ProblemError.badRequest("state must be 'ACTIVE' or 'REQUESTED'", 'INVALID_STATE');
    }

    let limit = 20;
    if (request.query.limit !== undefined) {
      const parsed = parseInt(request.query.limit, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 50) {
        throw ProblemError.badRequest('limit must be an integer between 1 and 50', 'INVALID_LIMIT');
      }
      limit = parsed;
    }

    let cursorPayload: CursorPayload | null = null;
    if (request.query.cursor) {
      cursorPayload = decodeCursor<CursorPayload>(request.query.cursor);
      if (!cursorPayload || !cursorPayload.t || !cursorPayload.id) {
        throw ProblemError.badRequest('Invalid cursor format', 'INVALID_CURSOR');
      }
    }

    // Keyset query: (coalesce(last_message_at, created_at) DESC, id DESC)
    const cursorCondition = cursorPayload
      ? sql`AND (
          COALESCE(c.last_message_at, c.created_at) < ${new Date(cursorPayload.t)}
          OR (
            COALESCE(c.last_message_at, c.created_at) = ${new Date(cursorPayload.t)}
            AND c.id < ${cursorPayload.id}::uuid
          )
        )`
      : sql``;

    const convRowsRes = await sql<{
      id: string;
      kind: ConversationKind;
      title: string | null;
      last_seq: string;
      last_message_at: Date | null;
      created_at: Date;
      my_role: MemberRole;
      my_state: MemberState;
      my_joined_seq: string;
      my_last_read_seq: string;
      my_muted_until: Date | null;
    }>`
      SELECT c.id, c.kind, c.title, c.last_seq, c.last_message_at, c.created_at,
             m.role AS my_role, m.state AS my_state, m.joined_seq AS my_joined_seq,
             m.last_read_seq AS my_last_read_seq, m.muted_until AS my_muted_until
      FROM chat.members m
      JOIN chat.conversations c ON c.id = m.conversation_id
      WHERE m.user_id = ${caller.userId}::uuid
        AND m.state = ${stateParam}
        ${cursorCondition}
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
      LIMIT ${limit + 1}
    `.execute(db);

    const convRows = convRowsRes.rows;
    const hasMore = convRows.length > limit;
    const pageRows = hasMore ? convRows.slice(0, limit) : convRows;

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const lastRow = pageRows[pageRows.length - 1];
      const t = (
        lastRow.last_message_at ? new Date(lastRow.last_message_at) : new Date(lastRow.created_at)
      ).toISOString();
      nextCursor = encodeCursor<CursorPayload>({ t, id: lastRow.id });
    }

    if (pageRows.length === 0) {
      return reply.status(200).send({ items: [], next_cursor: null });
    }

    const convIds = pageRows.map((c) => c.id);

    // Fetch all active/requested members for these conversations
    const allMembersRes = await db
      .selectFrom('chat.members')
      .selectAll()
      .where('conversation_id', 'in', convIds)
      .where('state', 'in', ['ACTIVE', 'REQUESTED'])
      .execute();

    // Fetch public profiles for these members
    const memberUserIds = [...new Set(allMembersRes.map((m) => m.user_id))];
    const profiles =
      memberUserIds.length > 0
        ? await db
            .selectFrom('auth.public_profiles')
            .select(['id', 'handle', 'display_name', 'avatar_key'])
            .where('id', 'in', memberUserIds)
            .execute()
        : [];

    const profileMap = new Map<string, PublicProfileDto>(
      profiles.map((p) => [
        p.id,
        {
          id: p.id,
          handle: p.handle,
          display_name: p.display_name,
          avatar_url: p.avatar_key ? `https://media.winkey.vn/${p.avatar_key}` : null,
        },
      ]),
    );

    // Group members by conversation
    const membersByConv = new Map<string, typeof allMembersRes>();
    for (const m of allMembersRes) {
      const arr = membersByConv.get(m.conversation_id) ?? [];
      arr.push(m);
      membersByConv.set(m.conversation_id, arr);
    }

    // Compute unread counts in batch
    const unreadCountsRes = await sql<{ conversation_id: string; unread_count: string }>`
      SELECT c_id AS conversation_id, LEAST(99, count(*)) AS unread_count
      FROM (
        SELECT m.conversation_id AS c_id
        FROM chat.members m
        JOIN chat.messages msg ON msg.conversation_id = m.conversation_id
        WHERE m.user_id = ${caller.userId}::uuid
          AND m.conversation_id = ANY(${convIds}::uuid[])
          AND msg.seq > GREATEST(m.last_read_seq, m.joined_seq - 1)
          AND (msg.sender_id IS NULL OR msg.sender_id != ${caller.userId}::uuid)
        LIMIT 5000
      ) sub
      GROUP BY c_id
    `.execute(db);

    const unreadMap = new Map<string, number>(
      unreadCountsRes.rows.map((r) => [r.conversation_id, Number(r.unread_count)]),
    );

    const items = pageRows.map((c) => {
      const cMembers = membersByConv.get(c.id) ?? [];
      cMembers.sort((a, b) => {
        if (a.role === 'OWNER' && b.role !== 'OWNER') return -1;
        if (b.role === 'OWNER' && a.role !== 'OWNER') return 1;
        const aSeq = BigInt(a.joined_seq);
        const bSeq = BigInt(b.joined_seq);
        if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      return {
        id: c.id,
        kind: c.kind,
        title: c.title,
        members: cMembers.map((m) => ({
          user_id: m.user_id,
          user: profileMap.get(m.user_id) ?? null,
          role: m.role,
          state: m.state,
        })),
        my_role: c.my_role,
        my_state: c.my_state,
        last_seq: Number(c.last_seq),
        last_message_at: c.last_message_at ? new Date(c.last_message_at).toISOString() : null,
        unread_count: unreadMap.get(c.id) ?? 0,
        muted_until: c.my_muted_until ? new Date(c.my_muted_until).toISOString() : null,
        created_at: new Date(c.created_at).toISOString(),
      };
    });

    return reply.status(200).send({ items, next_cursor: nextCursor });
  });

  // 2. POST /v1/chat/conversations - Create direct conversation or group
  fastify.post<{
    Body: {
      kind: ConversationKind;
      title?: string;
      user_ids: string[];
    };
  }>('/v1/chat/conversations', async (request, reply) => {
    const caller = requireAuth(request);
    const { kind, title, user_ids } = request.body || {};

    if (kind !== 'DIRECT' && kind !== 'GROUP') {
      throw ProblemError.badRequest("kind must be 'DIRECT' or 'GROUP'", 'INVALID_KIND');
    }

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      throw ProblemError.badRequest('user_ids must be a non-empty array', 'INVALID_USER_IDS');
    }

    if (user_ids.includes(caller.userId)) {
      throw ProblemError.badRequest('Cannot add yourself to user_ids', 'INVALID_USER_IDS');
    }

    for (const uid of user_ids) {
      if (!isValidUuid(uid)) {
        throw ProblemError.badRequest(`Invalid user ID: ${uid}`, 'INVALID_USER_ID');
      }
    }

    const uniqueUserIds = [...new Set(user_ids)];

    // Rate limit: 20 conversations created / hour
    if (rateLimiter) {
      await rateLimiter.consume({
        key: buildCreateConversationRateLimitKey(caller.userId),
        limit: 20,
        windowSeconds: 3600,
      });
    }

    if (kind === 'DIRECT') {
      if (uniqueUserIds.length !== 1) {
        throw ProblemError.badRequest(
          'DIRECT conversation requires exactly one other user',
          'INVALID_USER_IDS',
        );
      }
      if (title !== undefined) {
        throw ProblemError.badRequest('DIRECT conversation cannot have a title', 'INVALID_TITLE');
      }

      const targetId = uniqueUserIds[0];

      // Profile check
      const targetProfile = await db
        .selectFrom('auth.public_profiles')
        .select('id')
        .where('id', '=', targetId)
        .executeTakeFirst();

      if (!targetProfile) {
        throw ProblemError.notFound('Target user not found', 'USER_NOT_FOUND');
      }

      // Block check
      const blockCheck = await sql`
        SELECT 1 FROM social.blocks
        WHERE (blocker_id = ${caller.userId}::uuid AND blocked_id = ${targetId}::uuid)
           OR (blocker_id = ${targetId}::uuid AND blocked_id = ${caller.userId}::uuid)
        LIMIT 1
      `.execute(db);

      if (blockCheck.rows.length > 0) {
        throw ProblemError.forbidden('Cannot interact with this user', 'INTERACTION_BLOCKED');
      }

      // Subscription check: does target follow caller?
      const subCheck = await sql`
        SELECT 1 FROM social.subscriptions
        WHERE subscriber_id = ${targetId}::uuid AND channel_id = ${caller.userId}::uuid
        LIMIT 1
      `.execute(db);

      const targetState: MemberState = subCheck.rows.length > 0 ? 'ACTIVE' : 'REQUESTED';

      if (targetState === 'REQUESTED' && rateLimiter) {
        await rateLimiter.consume({
          key: buildMessageRequestRateLimitKey(caller.userId),
          limit: 20,
          windowSeconds: 86400,
        });
      }

      const directKey = [caller.userId, targetId].sort().join(':');
      let createdNew = false;
      let convId: string;

      await db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('chat-direct:' || ${directKey}))`.execute(
          trx,
        );

        const existingConv = await trx
          .selectFrom('chat.conversations')
          .selectAll()
          .where('direct_key', '=', directKey)
          .executeTakeFirst();

        if (existingConv) {
          convId = existingConv.id;
          // Check caller's membership: if LEFT, re-activate
          const callerMem = await trx
            .selectFrom('chat.members')
            .selectAll()
            .where('conversation_id', '=', existingConv.id)
            .where('user_id', '=', caller.userId)
            .executeTakeFirst();

          if (callerMem && callerMem.state === 'LEFT') {
            const nextSeq = (BigInt(existingConv.last_seq) + 1n).toString();
            await trx
              .updateTable('chat.members')
              .set({
                state: 'ACTIVE',
                joined_seq: nextSeq,
                left_seq: null,
                updated_at: new Date(),
              })
              .where('conversation_id', '=', existingConv.id)
              .where('user_id', '=', caller.userId)
              .execute();
          }
        } else {
          createdNew = true;
          convId = uuidv7();

          await trx
            .insertInto('chat.conversations')
            .values({
              id: convId,
              kind: 'DIRECT',
              title: null,
              created_by: caller.userId,
              direct_key: directKey,
              last_seq: '1',
              last_message_at: new Date(),
            })
            .execute();

          await trx
            .insertInto('chat.messages')
            .values({
              conversation_id: convId,
              seq: '1',
              id: uuidv7(),
              kind: 'SYSTEM',
              sender_id: null,
              sender_device_id: null,
              client_msg_id: null,
              megolm_session_id: null,
              ciphertext: null,
              system_body: JSON.stringify({ type: 'conversation_created' }),
            })
            .execute();

          await trx
            .insertInto('chat.members')
            .values([
              {
                conversation_id: convId,
                user_id: caller.userId,
                role: 'MEMBER',
                state: 'ACTIVE',
                joined_seq: '1',
                last_read_seq: '1',
              },
              {
                conversation_id: convId,
                user_id: targetId,
                role: 'MEMBER',
                state: targetState,
                joined_seq: '1',
                last_read_seq: '0',
              },
            ])
            .execute();
        }
      });

      if (createdNew) {
        hints.publishHint(caller.userId, { kind: 'CONVERSATION', conversation_id: convId! });
        hints.publishHint(targetId, { kind: 'CONVERSATION', conversation_id: convId! });
      }

      const dto = await buildConversationDto(convId!, caller.userId);
      return reply.status(createdNew ? 201 : 200).send(dto);
    }

    // GROUP
    if (!title || typeof title !== 'string' || title.trim().length === 0 || title.length > 80) {
      throw ProblemError.badRequest(
        'title is required and must be between 1 and 80 characters for groups',
        'INVALID_TITLE',
      );
    }
    if (uniqueUserIds.length < 1 || uniqueUserIds.length > 49) {
      throw ProblemError.badRequest(
        'user_ids must contain 1 to 49 other members',
        'INVALID_USER_IDS',
      );
    }

    // Profile check for all members
    const profiles = await db
      .selectFrom('auth.public_profiles')
      .select('id')
      .where('id', 'in', uniqueUserIds)
      .execute();

    if (profiles.length !== uniqueUserIds.length) {
      throw ProblemError.notFound('One or more users not found', 'USER_NOT_FOUND');
    }

    // Block check
    const blockCheck = await sql`
      SELECT 1 FROM social.blocks
      WHERE (blocker_id = ${caller.userId}::uuid AND blocked_id = ANY(${uniqueUserIds}::uuid[]))
         OR (blocker_id = ANY(${uniqueUserIds}::uuid[]) AND blocked_id = ${caller.userId}::uuid)
      LIMIT 1
    `.execute(db);

    if (blockCheck.rows.length > 0) {
      throw ProblemError.forbidden('Cannot interact with blocked users', 'INTERACTION_BLOCKED');
    }

    // Subscription check for each member
    const subsRes = await sql<{ subscriber_id: string }>`
      SELECT subscriber_id
      FROM social.subscriptions
      WHERE subscriber_id = ANY(${uniqueUserIds}::uuid[])
        AND channel_id = ${caller.userId}::uuid
    `.execute(db);

    const followingSet = new Set(subsRes.rows.map((r) => r.subscriber_id));
    let requestedCount = 0;
    const memberStates = uniqueUserIds.map((uid) => {
      const state: MemberState = followingSet.has(uid) ? 'ACTIVE' : 'REQUESTED';
      if (state === 'REQUESTED') requestedCount += 1;
      return { user_id: uid, state };
    });

    if (requestedCount > 0 && rateLimiter) {
      await rateLimiter.consume({
        key: buildMessageRequestRateLimitKey(caller.userId),
        limit: 20,
        windowSeconds: 86400,
        cost: requestedCount,
      });
    }

    const convId = uuidv7();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('chat.conversations')
        .values({
          id: convId,
          kind: 'GROUP',
          title: title.trim(),
          created_by: caller.userId,
          direct_key: null,
          last_seq: '1',
          last_message_at: new Date(),
        })
        .execute();

      await trx
        .insertInto('chat.messages')
        .values({
          conversation_id: convId,
          seq: '1',
          id: uuidv7(),
          kind: 'SYSTEM',
          sender_id: null,
          sender_device_id: null,
          client_msg_id: null,
          megolm_session_id: null,
          ciphertext: null,
          system_body: JSON.stringify({ type: 'conversation_created', title: title.trim() }),
        })
        .execute();

      const memberValues = [
        {
          conversation_id: convId,
          user_id: caller.userId,
          role: 'OWNER' as MemberRole,
          state: 'ACTIVE' as MemberState,
          joined_seq: '1',
          last_read_seq: '1',
        },
        ...memberStates.map((m) => ({
          conversation_id: convId,
          user_id: m.user_id,
          role: 'MEMBER' as MemberRole,
          state: m.state,
          joined_seq: '1',
          last_read_seq: '0',
        })),
      ];

      await trx.insertInto('chat.members').values(memberValues).execute();
    });

    hints.publishHint(caller.userId, { kind: 'CONVERSATION', conversation_id: convId });
    for (const m of memberStates) {
      hints.publishHint(m.user_id, { kind: 'CONVERSATION', conversation_id: convId });
    }

    const dto = await buildConversationDto(convId, caller.userId);
    return reply.status(201).send(dto);
  });

  // 3. GET /v1/chat/conversations/:conversation_id - Get one conversation
  fastify.get<{ Params: { conversation_id: string } }>(
    '/v1/chat/conversations/:conversation_id',
    async (request, reply) => {
      const caller = requireAuth(request);
      const { conversation_id } = request.params;

      if (!isValidUuid(conversation_id)) {
        throw ProblemError.badRequest('Invalid conversation ID', 'INVALID_CONVERSATION_ID');
      }

      const dto = await buildConversationDto(conversation_id, caller.userId);
      return reply.status(200).send(dto);
    },
  );

  // 4. PATCH /v1/chat/conversations/:conversation_id - Rename group
  fastify.patch<{
    Params: { conversation_id: string };
    Body: { title: string };
  }>('/v1/chat/conversations/:conversation_id', async (request, reply) => {
    const caller = requireAuth(request);
    const { conversation_id } = request.params;
    const { title } = request.body || {};

    if (!isValidUuid(conversation_id)) {
      throw ProblemError.badRequest('Invalid conversation ID', 'INVALID_CONVERSATION_ID');
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0 || title.length > 80) {
      throw ProblemError.badRequest('title must be between 1 and 80 characters', 'INVALID_TITLE');
    }

    let activeMemberIds: string[] = [];

    await db.transaction().execute(async (trx) => {
      const conv = await trx
        .selectFrom('chat.conversations')
        .selectAll()
        .where('id', '=', conversation_id)
        .forUpdate()
        .executeTakeFirst();

      if (!conv) {
        throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      }

      if (conv.kind === 'DIRECT') {
        throw ProblemError.conflict('Cannot rename a direct conversation', 'NOT_A_GROUP');
      }

      const callerMem = await trx
        .selectFrom('chat.members')
        .selectAll()
        .where('conversation_id', '=', conversation_id)
        .where('user_id', '=', caller.userId)
        .executeTakeFirst();

      if (!callerMem || (callerMem.role !== 'OWNER' && callerMem.role !== 'ADMIN')) {
        throw ProblemError.forbidden(
          'Only group OWNER or ADMIN can rename group',
          'NOT_AUTHORIZED',
        );
      }

      const nextSeq = (BigInt(conv.last_seq) + 1n).toString();
      await trx
        .updateTable('chat.conversations')
        .set({
          title: title.trim(),
          last_seq: nextSeq,
          last_message_at: new Date(),
        })
        .where('id', '=', conversation_id)
        .execute();

      await trx
        .insertInto('chat.messages')
        .values({
          conversation_id,
          seq: nextSeq,
          id: uuidv7(),
          kind: 'SYSTEM',
          sender_id: null,
          sender_device_id: null,
          client_msg_id: null,
          megolm_session_id: null,
          ciphertext: null,
          system_body: JSON.stringify({
            type: 'title_changed',
            title: title.trim(),
            by: caller.userId,
          }),
        })
        .execute();

      const members = await trx
        .selectFrom('chat.members')
        .select('user_id')
        .where('conversation_id', '=', conversation_id)
        .where('state', 'in', ['ACTIVE', 'REQUESTED'])
        .execute();

      activeMemberIds = members.map((m) => m.user_id);
    });

    for (const uid of activeMemberIds) {
      hints.publishHint(uid, { kind: 'CONVERSATION', conversation_id });
    }

    const dto = await buildConversationDto(conversation_id, caller.userId);
    return reply.status(200).send(dto);
  });

  // 5. POST /v1/chat/conversations/:conversation_id/members - Add members to group
  fastify.post<{
    Params: { conversation_id: string };
    Body: { user_ids: string[] };
  }>('/v1/chat/conversations/:conversation_id/members', async (request, reply) => {
    const caller = requireAuth(request);
    const { conversation_id } = request.params;
    const { user_ids } = request.body || {};

    if (!isValidUuid(conversation_id)) {
      throw ProblemError.badRequest('Invalid conversation ID', 'INVALID_CONVERSATION_ID');
    }

    if (!Array.isArray(user_ids) || user_ids.length === 0 || user_ids.length > 49) {
      throw ProblemError.badRequest(
        'user_ids must be an array of 1 to 49 items',
        'INVALID_USER_IDS',
      );
    }

    for (const uid of user_ids) {
      if (!isValidUuid(uid)) {
        throw ProblemError.badRequest(`Invalid user ID: ${uid}`, 'INVALID_USER_ID');
      }
    }

    const uniqueUserIds = [...new Set(user_ids.filter((uid) => uid !== caller.userId))];
    if (uniqueUserIds.length === 0) {
      throw ProblemError.badRequest('No valid other members to add', 'INVALID_USER_IDS');
    }

    // Profiles check
    const profiles = await db
      .selectFrom('auth.public_profiles')
      .select('id')
      .where('id', 'in', uniqueUserIds)
      .execute();

    if (profiles.length !== uniqueUserIds.length) {
      throw ProblemError.notFound('One or more users not found', 'USER_NOT_FOUND');
    }

    // Blocks check
    const blockCheck = await sql`
      SELECT 1 FROM social.blocks
      WHERE (blocker_id = ${caller.userId}::uuid AND blocked_id = ANY(${uniqueUserIds}::uuid[]))
         OR (blocker_id = ANY(${uniqueUserIds}::uuid[]) AND blocked_id = ${caller.userId}::uuid)
      LIMIT 1
    `.execute(db);

    if (blockCheck.rows.length > 0) {
      throw ProblemError.forbidden('Cannot add blocked users', 'INTERACTION_BLOCKED');
    }

    // Subscription check: does user follow caller?
    const subsRes = await sql<{ subscriber_id: string }>`
      SELECT subscriber_id
      FROM social.subscriptions
      WHERE subscriber_id = ANY(${uniqueUserIds}::uuid[])
        AND channel_id = ${caller.userId}::uuid
    `.execute(db);

    const followingSet = new Set(subsRes.rows.map((r) => r.subscriber_id));
    let allMemberIdsToNotify: string[] = [];

    await db.transaction().execute(async (trx) => {
      const conv = await trx
        .selectFrom('chat.conversations')
        .selectAll()
        .where('id', '=', conversation_id)
        .forUpdate()
        .executeTakeFirst();

      if (!conv) {
        throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      }

      if (conv.kind === 'DIRECT') {
        throw ProblemError.conflict('Cannot add members to a direct conversation', 'NOT_A_GROUP');
      }

      const callerMem = await trx
        .selectFrom('chat.members')
        .selectAll()
        .where('conversation_id', '=', conversation_id)
        .where('user_id', '=', caller.userId)
        .executeTakeFirst();

      if (!callerMem || (callerMem.role !== 'OWNER' && callerMem.role !== 'ADMIN')) {
        throw ProblemError.forbidden('Only group OWNER or ADMIN can add members', 'NOT_AUTHORIZED');
      }

      const currentMembers = await trx
        .selectFrom('chat.members')
        .selectAll()
        .where('conversation_id', '=', conversation_id)
        .execute();

      const currentActiveCount = currentMembers.filter(
        (m) => m.state === 'ACTIVE' || m.state === 'REQUESTED',
      ).length;

      const currentMemberMap = new Map(currentMembers.map((m) => [m.user_id, m]));
      const toAdd: Array<{ user_id: string; state: MemberState; isRejoin: boolean }> = [];

      for (const uid of uniqueUserIds) {
        const mem = currentMemberMap.get(uid);
        if (mem && (mem.state === 'ACTIVE' || mem.state === 'REQUESTED')) {
          // Already in conversation, ignore
          continue;
        }
        const state: MemberState = followingSet.has(uid) ? 'ACTIVE' : 'REQUESTED';
        toAdd.push({ user_id: uid, state, isRejoin: mem !== undefined });
      }

      if (currentActiveCount + toAdd.length > 50) {
        throw ProblemError.conflict('Group cannot have more than 50 members', 'TOO_MANY_MEMBERS');
      }

      let requestedCount = 0;
      let curSeq = BigInt(conv.last_seq);

      for (const item of toAdd) {
        if (item.state === 'REQUESTED') requestedCount += 1;
        curSeq += 1n;
        const seqStr = curSeq.toString();

        if (item.isRejoin) {
          await trx
            .updateTable('chat.members')
            .set({
              role: 'MEMBER',
              state: item.state,
              joined_seq: seqStr,
              left_seq: null,
              updated_at: new Date(),
            })
            .where('conversation_id', '=', conversation_id)
            .where('user_id', '=', item.user_id)
            .execute();
        } else {
          await trx
            .insertInto('chat.members')
            .values({
              conversation_id,
              user_id: item.user_id,
              role: 'MEMBER',
              state: item.state,
              joined_seq: seqStr,
              last_read_seq: '0',
            })
            .execute();
        }

        // Insert SYSTEM message
        await trx
          .insertInto('chat.messages')
          .values({
            conversation_id,
            seq: seqStr,
            id: uuidv7(),
            kind: 'SYSTEM',
            sender_id: null,
            sender_device_id: null,
            client_msg_id: null,
            megolm_session_id: null,
            ciphertext: null,
            system_body: JSON.stringify({
              type: 'member_added',
              user_id: item.user_id,
              by: caller.userId,
            }),
          })
          .execute();
      }

      if (toAdd.length > 0) {
        await trx
          .updateTable('chat.conversations')
          .set({ last_seq: curSeq.toString(), last_message_at: new Date() })
          .where('id', '=', conversation_id)
          .execute();
      }

      if (requestedCount > 0 && rateLimiter) {
        await rateLimiter.consume({
          key: buildMessageRequestRateLimitKey(caller.userId),
          limit: 20,
          windowSeconds: 86400,
          cost: requestedCount,
        });
      }

      const updatedMembers = await trx
        .selectFrom('chat.members')
        .select('user_id')
        .where('conversation_id', '=', conversation_id)
        .where('state', 'in', ['ACTIVE', 'REQUESTED'])
        .execute();

      allMemberIdsToNotify = updatedMembers.map((m) => m.user_id);
    });

    for (const uid of allMemberIdsToNotify) {
      hints.publishHint(uid, { kind: 'CONVERSATION', conversation_id });
    }

    const dto = await buildConversationDto(conversation_id, caller.userId);
    return reply.status(200).send(dto);
  });

  // 6. DELETE /v1/chat/conversations/:conversation_id/members/:user_id - Leave or remove member
  fastify.delete<{
    Params: { conversation_id: string; user_id: string };
  }>('/v1/chat/conversations/:conversation_id/members/:user_id', async (request, reply) => {
    const caller = requireAuth(request);
    const { conversation_id, user_id } = request.params;

    if (!isValidUuid(conversation_id) || !isValidUuid(user_id)) {
      throw ProblemError.badRequest('Invalid UUID format', 'INVALID_UUID');
    }

    let membersToNotify: string[] = [];

    await db.transaction().execute(async (trx) => {
      const conv = await trx
        .selectFrom('chat.conversations')
        .selectAll()
        .where('id', '=', conversation_id)
        .forUpdate()
        .executeTakeFirst();

      if (!conv) {
        throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      }

      const callerMem = await trx
        .selectFrom('chat.members')
        .selectAll()
        .where('conversation_id', '=', conversation_id)
        .where('user_id', '=', caller.userId)
        .executeTakeFirst();

      if (!callerMem) {
        throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      }

      const targetMem = await trx
        .selectFrom('chat.members')
        .selectAll()
        .where('conversation_id', '=', conversation_id)
        .where('user_id', '=', user_id)
        .executeTakeFirst();

      if (!targetMem || targetMem.state === 'LEFT') {
        // Idempotent return
        return;
      }

      if (user_id === caller.userId) {
        // Self leave / decline
        if (conv.kind === 'DIRECT') {
          await trx
            .updateTable('chat.members')
            .set({ state: 'LEFT', left_seq: conv.last_seq, updated_at: new Date() })
            .where('conversation_id', '=', conversation_id)
            .where('user_id', '=', caller.userId)
            .execute();
        } else {
          // GROUP leave
          let curSeq = BigInt(conv.last_seq) + 1n;
          const seqStr = curSeq.toString();

          await trx
            .updateTable('chat.members')
            .set({ state: 'LEFT', left_seq: seqStr, role: 'MEMBER', updated_at: new Date() })
            .where('conversation_id', '=', conversation_id)
            .where('user_id', '=', caller.userId)
            .execute();

          await trx
            .insertInto('chat.messages')
            .values({
              conversation_id,
              seq: seqStr,
              id: uuidv7(),
              kind: 'SYSTEM',
              sender_id: null,
              sender_device_id: null,
              client_msg_id: null,
              megolm_session_id: null,
              ciphertext: null,
              system_body: JSON.stringify({ type: 'member_left', user_id: caller.userId }),
            })
            .execute();

          // Owner handover if owner left
          if (callerMem.role === 'OWNER') {
            const successorRes = await sql<{ user_id: string }>`
              SELECT user_id
              FROM chat.members
              WHERE conversation_id = ${conversation_id}::uuid
                AND state = 'ACTIVE'
                AND user_id != ${caller.userId}::uuid
              ORDER BY (CASE WHEN role = 'ADMIN' THEN 0 ELSE 1 END) ASC,
                       created_at ASC, user_id ASC
              LIMIT 1
              FOR UPDATE
            `.execute(trx);

            if (successorRes.rows.length > 0) {
              const successorId = successorRes.rows[0].user_id;
              curSeq += 1n;
              const ownerSeqStr = curSeq.toString();

              await trx
                .updateTable('chat.members')
                .set({ role: 'OWNER', updated_at: new Date() })
                .where('conversation_id', '=', conversation_id)
                .where('user_id', '=', successorId)
                .execute();

              await trx
                .insertInto('chat.messages')
                .values({
                  conversation_id,
                  seq: ownerSeqStr,
                  id: uuidv7(),
                  kind: 'SYSTEM',
                  sender_id: null,
                  sender_device_id: null,
                  client_msg_id: null,
                  megolm_session_id: null,
                  ciphertext: null,
                  system_body: JSON.stringify({
                    type: 'owner_changed',
                    user_id: successorId,
                    by: caller.userId,
                  }),
                })
                .execute();
            }
          }

          await trx
            .updateTable('chat.conversations')
            .set({ last_seq: curSeq.toString(), last_message_at: new Date() })
            .where('id', '=', conversation_id)
            .execute();
        }
      } else {
        // Removing someone else
        if (conv.kind === 'DIRECT') {
          throw ProblemError.forbidden(
            'Cannot remove member from direct conversation',
            'NOT_ALLOWED',
          );
        }

        if (callerMem.role !== 'OWNER' && callerMem.role !== 'ADMIN') {
          throw ProblemError.forbidden(
            'Only group OWNER or ADMIN can remove members',
            'NOT_AUTHORIZED',
          );
        }

        if (callerMem.role === 'ADMIN' && targetMem.role !== 'MEMBER') {
          throw ProblemError.forbidden(
            'ADMIN cannot remove an OWNER or another ADMIN',
            'NOT_AUTHORIZED',
          );
        }

        const nextSeq = (BigInt(conv.last_seq) + 1n).toString();
        await trx
          .updateTable('chat.conversations')
          .set({ last_seq: nextSeq, last_message_at: new Date() })
          .where('id', '=', conversation_id)
          .execute();

        await trx
          .updateTable('chat.members')
          .set({ state: 'LEFT', left_seq: nextSeq, role: 'MEMBER', updated_at: new Date() })
          .where('conversation_id', '=', conversation_id)
          .where('user_id', '=', user_id)
          .execute();

        await trx
          .insertInto('chat.messages')
          .values({
            conversation_id,
            seq: nextSeq,
            id: uuidv7(),
            kind: 'SYSTEM',
            sender_id: null,
            sender_device_id: null,
            client_msg_id: null,
            megolm_session_id: null,
            ciphertext: null,
            system_body: JSON.stringify({
              type: 'member_removed',
              user_id,
              by: caller.userId,
            }),
          })
          .execute();
      }

      const activeMembers = await trx
        .selectFrom('chat.members')
        .select('user_id')
        .where('conversation_id', '=', conversation_id)
        .where('state', 'in', ['ACTIVE', 'REQUESTED'])
        .execute();

      membersToNotify = activeMembers.map((m) => m.user_id);
    });

    for (const uid of membersToNotify) {
      hints.publishHint(uid, { kind: 'CONVERSATION', conversation_id });
    }

    return reply.status(204).send();
  });

  // 7. PATCH /v1/chat/conversations/:conversation_id/members/:user_id - Update role or mute
  fastify.patch<{
    Params: { conversation_id: string; user_id: string };
    Body: { role?: MemberRole; muted_until?: string | null };
  }>('/v1/chat/conversations/:conversation_id/members/:user_id', async (request, reply) => {
    const caller = requireAuth(request);
    const { conversation_id, user_id } = request.params;
    const { role, muted_until } = request.body || {};

    if (!isValidUuid(conversation_id) || !isValidUuid(user_id)) {
      throw ProblemError.badRequest('Invalid UUID format', 'INVALID_UUID');
    }

    if (role === undefined && muted_until === undefined) {
      throw ProblemError.badRequest('Must provide either role or muted_until', 'INVALID_REQUEST');
    }

    let updatedMember: {
      user_id: string;
      role: MemberRole;
      state: MemberState;
    };

    await db.transaction().execute(async (trx) => {
      const conv = await trx
        .selectFrom('chat.conversations')
        .selectAll()
        .where('id', '=', conversation_id)
        .executeTakeFirst();

      if (!conv) {
        throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      }

      const callerMem = await trx
        .selectFrom('chat.members')
        .selectAll()
        .where('conversation_id', '=', conversation_id)
        .where('user_id', '=', caller.userId)
        .executeTakeFirst();

      if (!callerMem) {
        throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      }

      const targetMem = await trx
        .selectFrom('chat.members')
        .selectAll()
        .where('conversation_id', '=', conversation_id)
        .where('user_id', '=', user_id)
        .executeTakeFirst();

      if (!targetMem || targetMem.state === 'LEFT') {
        throw ProblemError.notFound('Member not found or has left', 'MEMBER_NOT_FOUND');
      }

      // Role update rule: OWNER only, group only, setting ADMIN or MEMBER on another user
      if (role !== undefined) {
        if (conv.kind === 'DIRECT') {
          throw ProblemError.conflict('Cannot set roles in a direct conversation', 'NOT_A_GROUP');
        }
        if (callerMem.role !== 'OWNER') {
          throw ProblemError.forbidden(
            'Only group OWNER can change member roles',
            'NOT_AUTHORIZED',
          );
        }
        if (user_id === caller.userId) {
          throw ProblemError.forbidden('OWNER cannot change their own role here', 'NOT_ALLOWED');
        }
        if (role !== 'ADMIN' && role !== 'MEMBER') {
          throw ProblemError.badRequest("Role must be 'ADMIN' or 'MEMBER'", 'INVALID_ROLE');
        }

        await trx
          .updateTable('chat.members')
          .set({ role, updated_at: new Date() })
          .where('conversation_id', '=', conversation_id)
          .where('user_id', '=', user_id)
          .execute();

        targetMem.role = role;
      }

      // Mute update rule: caller only on self
      if (muted_until !== undefined) {
        if (user_id !== caller.userId) {
          throw ProblemError.forbidden('Cannot mute for other members', 'NOT_ALLOWED');
        }

        const muteDate = muted_until === null ? null : new Date(muted_until);
        if (muteDate && isNaN(muteDate.getTime())) {
          throw ProblemError.badRequest('Invalid muted_until timestamp', 'INVALID_TIMESTAMP');
        }

        await trx
          .updateTable('chat.members')
          .set({ muted_until: muteDate, updated_at: new Date() })
          .where('conversation_id', '=', conversation_id)
          .where('user_id', '=', caller.userId)
          .execute();
      }

      updatedMember = {
        user_id: targetMem.user_id,
        role: targetMem.role,
        state: targetMem.state,
      };
    });

    const profileRow = await db
      .selectFrom('auth.public_profiles')
      .select(['id', 'handle', 'display_name', 'avatar_key'])
      .where('id', '=', user_id)
      .executeTakeFirst();

    const profile: PublicProfileDto | null = profileRow
      ? {
          id: profileRow.id,
          handle: profileRow.handle,
          display_name: profileRow.display_name,
          avatar_url: profileRow.avatar_key
            ? `https://media.winkey.vn/${profileRow.avatar_key}`
            : null,
        }
      : null;

    return reply.status(200).send({
      user_id: updatedMember!.user_id,
      user: profile,
      role: updatedMember!.role,
      state: updatedMember!.state,
    });
  });

  // 8. POST /v1/chat/conversations/:conversation_id/accept - Accept message request
  fastify.post<{ Params: { conversation_id: string } }>(
    '/v1/chat/conversations/:conversation_id/accept',
    async (request, reply) => {
      const caller = requireAuth(request);
      const { conversation_id } = request.params;

      if (!isValidUuid(conversation_id)) {
        throw ProblemError.badRequest('Invalid conversation ID', 'INVALID_CONVERSATION_ID');
      }

      let membersToNotify: string[] = [];

      await db.transaction().execute(async (trx) => {
        const conv = await trx
          .selectFrom('chat.conversations')
          .selectAll()
          .where('id', '=', conversation_id)
          .forUpdate()
          .executeTakeFirst();

        if (!conv) {
          throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
        }

        const callerMem = await trx
          .selectFrom('chat.members')
          .selectAll()
          .where('conversation_id', '=', conversation_id)
          .where('user_id', '=', caller.userId)
          .executeTakeFirst();

        if (!callerMem) {
          throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
        }

        if (callerMem.state === 'LEFT') {
          throw ProblemError.conflict(
            'Conversation is closed or you have left',
            'CONVERSATION_CLOSED',
          );
        }

        if (callerMem.state === 'ACTIVE') {
          // Idempotent
          return;
        }

        const nextSeq = (BigInt(conv.last_seq) + 1n).toString();
        await trx
          .updateTable('chat.conversations')
          .set({ last_seq: nextSeq, last_message_at: new Date() })
          .where('id', '=', conversation_id)
          .execute();

        await trx
          .updateTable('chat.members')
          .set({ state: 'ACTIVE', updated_at: new Date() })
          .where('conversation_id', '=', conversation_id)
          .where('user_id', '=', caller.userId)
          .execute();

        await trx
          .insertInto('chat.messages')
          .values({
            conversation_id,
            seq: nextSeq,
            id: uuidv7(),
            kind: 'SYSTEM',
            sender_id: null,
            sender_device_id: null,
            client_msg_id: null,
            megolm_session_id: null,
            ciphertext: null,
            system_body: JSON.stringify({ type: 'request_accepted', user_id: caller.userId }),
          })
          .execute();

        const activeMembers = await trx
          .selectFrom('chat.members')
          .select('user_id')
          .where('conversation_id', '=', conversation_id)
          .where('state', 'in', ['ACTIVE', 'REQUESTED'])
          .execute();

        membersToNotify = activeMembers.map((m) => m.user_id);
      });

      for (const uid of membersToNotify) {
        hints.publishHint(uid, { kind: 'CONVERSATION', conversation_id });
      }

      const dto = await buildConversationDto(conversation_id, caller.userId);
      return reply.status(200).send(dto);
    },
  );

  // 9. POST /v1/chat/conversations/:conversation_id/read - Move read marker forward
  fastify.post<{
    Params: { conversation_id: string };
    Body: { seq: number };
  }>('/v1/chat/conversations/:conversation_id/read', async (request, reply) => {
    const caller = requireAuth(request);
    const { conversation_id } = request.params;
    const { seq } = request.body || {};

    if (!isValidUuid(conversation_id)) {
      throw ProblemError.badRequest('Invalid conversation ID', 'INVALID_CONVERSATION_ID');
    }

    if (seq === undefined || typeof seq !== 'number' || seq < 0) {
      throw ProblemError.badRequest('seq must be a non-negative integer', 'INVALID_SEQ');
    }

    const conv = await db
      .selectFrom('chat.conversations')
      .select('last_seq')
      .where('id', '=', conversation_id)
      .executeTakeFirst();

    if (!conv) {
      throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
    }

    const callerMem = await db
      .selectFrom('chat.members')
      .select('last_read_seq')
      .where('conversation_id', '=', conversation_id)
      .where('user_id', '=', caller.userId)
      .executeTakeFirst();

    if (!callerMem) {
      throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
    }

    const lastSeqNum = Number(conv.last_seq);
    const clampedSeq = Math.min(seq, lastSeqNum);
    const currentReadSeq = Number(callerMem.last_read_seq);
    const newReadSeq = Math.max(currentReadSeq, clampedSeq);

    if (newReadSeq > currentReadSeq) {
      await db
        .updateTable('chat.members')
        .set({ last_read_seq: newReadSeq.toString(), updated_at: new Date() })
        .where('conversation_id', '=', conversation_id)
        .where('user_id', '=', caller.userId)
        .execute();
    }

    return reply.status(204).send();
  });
};
