import { http, HttpResponse } from 'msw';
import { mockUsers } from './fixtures';
import type {
  Conversation,
  ConversationPage,
  Message,
  OwnDevice,
  PublicDevice,
  ToDeviceMessage,
} from '@winkey/api-client';

// In-memory state for Mock Chat Service (SOC-3a / ADR-049)
const mockDevices = new Map<string, PublicDevice[]>();
const mockOwnDevices = new Map<string, OwnDevice[]>();
const mockOneTimeKeys = new Map<string, any[]>();
const mockToDeviceMessages = new Map<string, ToDeviceMessage[]>();

// Default viewer for mock sessions without explicit id
const DEFAULT_VIEWER = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c99',
  handle: 'viewer_winkey',
  display_name: 'Khán giả Winkey',
  avatar_url: null,
};

// Seed default peer device for creator so 1-to-1 tests have keys to claim
const CREATOR_ID = mockUsers.creator.id;
const CREATOR_DEVICE_ID = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9d01';

mockDevices.set(CREATOR_ID, [
  {
    id: CREATOR_DEVICE_ID,
    user_id: CREATOR_ID,
    ed25519_key: 'E_CREATOR_TEST_IDENTITY_KEY_BASE64_43CHARS==',
    curve25519_key: 'K_CREATOR_TEST_CURVE_KEY_BASE64_43CHARS====',
    signature:
      'SIG_CREATOR_TEST_SIGNATURE_BASE64_86CHARS==============================================',
    created_at: '2026-10-30T00:00:00Z',
  },
]);

mockOneTimeKeys.set(`${CREATOR_ID}:${CREATOR_DEVICE_ID}`, [
  {
    key_id: 'otk_creator_01',
    key: 'OTK_CREATOR_KEY_01_BASE64_43CHARS=========',
    signature:
      'SIG_OTK_01============================================================================',
    fallback: false,
  },
]);

// Default seed conversations
const mockConversations: Conversation[] = [
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    kind: 'DIRECT',
    title: null,
    created_at: '2026-10-30T01:00:00Z',
    last_message_at: '2026-10-30T05:30:00Z',
    last_seq: 2,
    unread_count: 1,
    my_role: 'MEMBER',
    my_state: 'ACTIVE',
    muted_until: null,
    members: [
      {
        user_id: DEFAULT_VIEWER.id,
        role: 'MEMBER',
        state: 'ACTIVE',
        user: {
          id: DEFAULT_VIEWER.id,
          handle: DEFAULT_VIEWER.handle,
          display_name: DEFAULT_VIEWER.display_name,
          avatar_url: DEFAULT_VIEWER.avatar_url,
        },
      },
      {
        user_id: mockUsers.creator.id,
        role: 'MEMBER',
        state: 'ACTIVE',
        user: {
          id: mockUsers.creator.id,
          handle: mockUsers.creator.handle,
          display_name: mockUsers.creator.display_name,
          avatar_url: null,
        },
      },
    ],
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c20',
    kind: 'DIRECT',
    title: null,
    created_at: '2026-10-30T02:00:00Z',
    last_message_at: '2026-10-30T02:00:00Z',
    last_seq: 1,
    unread_count: 1,
    my_role: 'MEMBER',
    my_state: 'REQUESTED',
    muted_until: null,
    members: [
      {
        user_id: DEFAULT_VIEWER.id,
        role: 'MEMBER',
        state: 'REQUESTED',
        user: {
          id: DEFAULT_VIEWER.id,
          handle: DEFAULT_VIEWER.handle,
          display_name: DEFAULT_VIEWER.display_name,
          avatar_url: DEFAULT_VIEWER.avatar_url,
        },
      },
      {
        user_id: mockUsers.tech_guy.id,
        role: 'MEMBER',
        state: 'ACTIVE',
        user: {
          id: mockUsers.tech_guy.id,
          handle: mockUsers.tech_guy.handle,
          display_name: mockUsers.tech_guy.display_name,
          avatar_url: mockUsers.tech_guy.avatar_url,
        },
      },
    ],
  },
];

const mockMessages = new Map<string, Message[]>();

// SOC-3b: attachment rows and a stand-in for the private winkey-chat bucket, served from the same origin so the
// dev CSP needs nothing extra. Holds ciphertext only, like the real bucket.
interface MockAttachment {
  id: string;
  conversation_id: string;
  size_bytes: number;
  state: 'PENDING' | 'UPLOADED';
  expires_at: string;
  created_at: string;
  message_seq: number | null;
}
const mockAttachments = new Map<string, MockAttachment>();
const mockBucket = new Map<string, ArrayBuffer>();

function attachmentDto(a: MockAttachment) {
  const { message_seq: _seq, ...dto } = a;
  return dto;
}
mockMessages.set('0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10', [
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11',
    conversation_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    seq: 1,
    kind: 'ENCRYPTED',
    sender_id: mockUsers.creator.id,
    sender_device_id: CREATOR_DEVICE_ID,
    megolm_session_id: 'mock_session_1',
    ciphertext: 'MEGOLM_CIPHERTEXT_MOCK_SEQ_1',
    created_at: '2026-10-30T01:05:00Z',
    deleted: false,
    system: null,
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c12',
    conversation_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    seq: 2,
    kind: 'ENCRYPTED',
    sender_id: mockUsers.creator.id,
    sender_device_id: CREATOR_DEVICE_ID,
    megolm_session_id: 'mock_session_1',
    ciphertext: 'MEGOLM_CIPHERTEXT_MOCK_SEQ_2',
    created_at: '2026-10-30T05:30:00Z',
    deleted: false,
    system: null,
  },
]);

function getAuthenticatedUserId(request: Request): string {
  const headerId = request.headers.get('x-user-id');
  if (headerId) return headerId;
  return DEFAULT_VIEWER.id;
}

export const chatHandlers = [
  // 1. Devices
  http.get('*/v1/chat/devices', ({ request }) => {
    const userId = getAuthenticatedUserId(request);
    const devices = mockOwnDevices.get(userId) || [];
    return HttpResponse.json(devices);
  }),

  http.put('*/v1/chat/devices/:device_id', async ({ params, request }) => {
    const { device_id } = params as { device_id: string };
    const userId = getAuthenticatedUserId(request);
    const body = (await request.json().catch(() => ({}))) as any;

    const now = new Date().toISOString();
    let ownList = mockOwnDevices.get(userId) || [];
    const existingOwn = ownList.find((d) => d.id === device_id);

    const ownDevice: OwnDevice = {
      id: device_id,
      display_name: body.display_name || 'Thiết bị Web',
      ed25519_key: body.ed25519_key || '',
      curve25519_key: body.curve25519_key || '',
      created_at: existingOwn ? existingOwn.created_at : now,
      last_seen_at: now,
    };

    if (existingOwn) {
      ownList = ownList.map((d) => (d.id === device_id ? ownDevice : d));
    } else {
      ownList.push(ownDevice);
    }
    mockOwnDevices.set(userId, ownList);

    // Update public devices map
    let publicList = mockDevices.get(userId) || [];
    const publicDevice: PublicDevice = {
      id: device_id,
      user_id: userId,
      ed25519_key: ownDevice.ed25519_key,
      curve25519_key: ownDevice.curve25519_key,
      signature: body.signature || '',
      created_at: ownDevice.created_at,
    };
    publicList = publicList.filter((d) => d.id !== device_id);
    publicList.push(publicDevice);
    mockDevices.set(userId, publicList);

    return HttpResponse.json(ownDevice);
  }),

  http.delete('*/v1/chat/devices/:device_id', ({ params, request }) => {
    const { device_id } = params as { device_id: string };
    const userId = getAuthenticatedUserId(request);
    let ownList = mockOwnDevices.get(userId) || [];
    ownList = ownList.filter((d) => d.id !== device_id);
    mockOwnDevices.set(userId, ownList);

    let pubList = mockDevices.get(userId) || [];
    pubList = pubList.filter((d) => d.id !== device_id);
    mockDevices.set(userId, pubList);

    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/v1/chat/devices/:device_id/one-time-keys', async ({ params, request }) => {
    const { device_id } = params as { device_id: string };
    const userId = getAuthenticatedUserId(request);
    const body = (await request.json().catch(() => ({}))) as any;
    const key = `${userId}:${device_id}`;
    const keys = body.keys || [];
    const current = mockOneTimeKeys.get(key) || [];
    mockOneTimeKeys.set(key, [...current, ...keys]);
    return HttpResponse.json({ count: mockOneTimeKeys.get(key)!.length });
  }),

  http.get('*/v1/chat/devices/:device_id/one-time-keys', ({ params, request }) => {
    const { device_id } = params as { device_id: string };
    const userId = getAuthenticatedUserId(request);
    const key = `${userId}:${device_id}`;
    const count = (mockOneTimeKeys.get(key) || []).length;
    return HttpResponse.json({ count, fallback_key_id: 'fbk_01' });
  }),

  http.post('*/v1/chat/devices/query', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as any;
    const userIds = (body.user_ids || []) as string[];
    const result: Record<string, PublicDevice[]> = {};

    for (const uid of userIds) {
      result[uid] = mockDevices.get(uid) || [];
    }
    return HttpResponse.json({ devices: result });
  }),

  http.post('*/v1/chat/keys/claim', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as any;
    const oneTimeKeysReq = (body.one_time_keys || {}) as Record<string, Record<string, string>>;
    const result: Record<string, Record<string, any>> = {};

    for (const [userId, deviceMap] of Object.entries(oneTimeKeysReq)) {
      result[userId] = {};
      for (const deviceId of Object.keys(deviceMap)) {
        const key = `${userId}:${deviceId}`;
        const otks = mockOneTimeKeys.get(key) || [];
        if (otks.length > 0) {
          result[userId][deviceId] = otks.shift();
        } else {
          result[userId][deviceId] = {
            key_id: 'otk_fallback_claimed',
            key: 'CLAIMED_OTK_BASE64_43_CHARACTERS_PLACEHOLDER',
            signature:
              'SIG_CLAIMED============================================================================',
            fallback: true,
          };
        }
      }
    }
    return HttpResponse.json({ one_time_keys: result });
  }),

  // 2. To-Device
  http.post('*/v1/chat/to-device', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as any;
    const messages = (body.messages || []) as Array<{
      recipient_user_id: string;
      recipient_device_id: string;
      ciphertext: string;
    }>;

    for (const msg of messages) {
      const key = `${msg.recipient_user_id}:${msg.recipient_device_id}`;
      const queue = mockToDeviceMessages.get(key) || [];
      queue.push({
        id: `td_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        sender_id: getAuthenticatedUserId(request),
        sender_device_id: 'mock_sender_device',
        ciphertext: msg.ciphertext,
        created_at: new Date().toISOString(),
      });
      mockToDeviceMessages.set(key, queue);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/v1/chat/devices/:device_id/to-device', ({ params, request }) => {
    const { device_id } = params as { device_id: string };
    const userId = getAuthenticatedUserId(request);
    const key = `${userId}:${device_id}`;
    const items = mockToDeviceMessages.get(key) || [];
    return HttpResponse.json({ items, has_more: false });
  }),

  http.post('*/v1/chat/devices/:device_id/to-device/ack', async ({ params, request }) => {
    const { device_id } = params as { device_id: string };
    const userId = getAuthenticatedUserId(request);
    const body = (await request.json().catch(() => ({}))) as any;
    const upToId = body.up_to_id as string;

    const key = `${userId}:${device_id}`;
    let messages = mockToDeviceMessages.get(key) || [];
    if (upToId) {
      const idx = messages.findIndex((m) => m.id === upToId);
      if (idx !== -1) {
        messages = messages.slice(idx + 1);
      }
    }
    mockToDeviceMessages.set(key, messages);
    return new HttpResponse(null, { status: 204 });
  }),

  // 3. Conversations
  http.get('*/v1/chat/conversations', ({ request }) => {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') || 'ACTIVE';
    const userId = getAuthenticatedUserId(request);

    const filtered = mockConversations.filter((c) => {
      const myMember = c.members.find((m) => m.user_id === userId);
      if (!myMember) return false;
      return myMember.state === state;
    });

    const page: ConversationPage = {
      items: filtered,
      next_cursor: null,
    };
    return HttpResponse.json(page);
  }),

  http.post('*/v1/chat/conversations', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as any;
    const userId = getAuthenticatedUserId(request);
    const now = new Date().toISOString();

    const members = (body.members || []).map((m: any) => ({
      user_id: m.user_id,
      role: m.role || 'MEMBER',
      state: m.user_id === userId ? 'ACTIVE' : 'REQUESTED',
      user: {
        id: m.user_id,
        handle: 'mock_handle',
        display_name: 'Người dùng',
        avatar_url: null,
      },
    }));

    if (!members.some((m: any) => m.user_id === userId)) {
      members.unshift({
        user_id: userId,
        role: 'OWNER',
        state: 'ACTIVE',
        user: {
          id: userId,
          handle: 'myself',
          display_name: 'Tôi',
          avatar_url: null,
        },
      });
    }

    const newConv: Conversation = {
      id: `0192f5e4-7c1a-7b3e-9d2a-${Math.random().toString(36).substring(2, 14)}`,
      kind: body.kind || 'DIRECT',
      title: body.title || null,
      created_at: now,
      last_message_at: null,
      last_seq: 0,
      unread_count: 0,
      my_role: 'OWNER',
      my_state: 'ACTIVE',
      muted_until: null,
      members,
    };

    mockConversations.unshift(newConv);
    return HttpResponse.json(newConv, { status: 201 });
  }),

  http.get('*/v1/chat/conversations/:id', ({ params }) => {
    const { id } = params as { id: string };
    const conv = mockConversations.find((c) => c.id === id);
    if (!conv) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Conversation not found', status: 404 },
        { status: 404 },
      );
    }
    return HttpResponse.json(conv);
  }),

  http.patch('*/v1/chat/conversations/:id', async ({ params, request }) => {
    const { id } = params as { id: string };
    const body = (await request.json().catch(() => ({}))) as any;
    const conv = mockConversations.find((c) => c.id === id);
    if (!conv) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Conversation not found', status: 404 },
        { status: 404 },
      );
    }
    if (body.title !== undefined) conv.title = body.title;
    return HttpResponse.json(conv);
  }),

  http.post('*/v1/chat/conversations/:id/accept', ({ params, request }) => {
    const { id } = params as { id: string };
    const userId = getAuthenticatedUserId(request);
    const conv = mockConversations.find((c) => c.id === id);
    if (!conv) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Conversation not found', status: 404 },
        { status: 404 },
      );
    }
    const member = conv.members.find((m) => m.user_id === userId);
    if (member) {
      member.state = 'ACTIVE';
    }
    conv.my_state = 'ACTIVE';
    return HttpResponse.json(conv);
  }),

  http.post('*/v1/chat/conversations/:id/read', ({ params }) => {
    const { id } = params as { id: string };
    const conv = mockConversations.find((c) => c.id === id);
    if (conv) {
      conv.unread_count = 0;
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/v1/chat/conversations/:id/members', async ({ params, request }) => {
    const { id } = params as { id: string };
    const body = (await request.json().catch(() => ({}))) as any;
    const conv = mockConversations.find((c) => c.id === id);
    if (!conv) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Conversation not found', status: 404 },
        { status: 404 },
      );
    }
    const newMembers = (body.members || []).map((m: any) => ({
      user_id: m.user_id,
      role: m.role || 'MEMBER',
      state: 'ACTIVE',
      user: {
        id: m.user_id,
        handle: 'mock_user',
        display_name: 'Thành viên mới',
        avatar_url: null,
      },
    }));
    conv.members.push(...newMembers);
    return HttpResponse.json(conv);
  }),

  http.delete('*/v1/chat/conversations/:id/members/:user_id', ({ params }) => {
    const { id, user_id } = params as { id: string; user_id: string };
    const conv = mockConversations.find((c) => c.id === id);
    if (conv) {
      conv.members = conv.members.filter((m) => m.user_id !== user_id);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // 4. Messages
  http.get('*/v1/chat/conversations/:id/messages', ({ params }) => {
    const { id } = params as { id: string };
    const messages = mockMessages.get(id) || [];
    return HttpResponse.json({ items: messages, has_more: false });
  }),

  http.post('*/v1/chat/conversations/:id/messages', async ({ params, request }) => {
    const { id } = params as { id: string };
    const userId = getAuthenticatedUserId(request);
    const body = (await request.json().catch(() => ({}))) as any;

    const conv = mockConversations.find((c) => c.id === id);
    if (!conv) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Conversation not found', status: 404 },
        { status: 404 },
      );
    }

    const messages = mockMessages.get(id) || [];
    const newSeq = (conv.last_seq || 0) + 1;
    conv.last_seq = newSeq;
    conv.last_message_at = new Date().toISOString();

    const attachmentIds: string[] = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
    const linked = attachmentIds.map((aid) => mockAttachments.get(aid));
    if (
      linked.some(
        (a) => !a || a.state !== 'UPLOADED' || a.message_seq !== null || a.conversation_id !== id,
      )
    ) {
      conv.last_seq = newSeq - 1;
      return HttpResponse.json(
        {
          type: '/problems/conflict',
          title: 'Conflict',
          status: 409,
          code: 'ATTACHMENT_UNAVAILABLE',
        },
        { status: 409 },
      );
    }
    for (const a of linked) a!.message_seq = newSeq;

    const newMsg: Message = {
      id: `0192f5e4-7c1a-7b3e-9d2a-${Math.random().toString(36).substring(2, 14)}`,
      conversation_id: id,
      seq: newSeq,
      attachments: linked.map((a) => attachmentDto(a!)),
      kind: 'ENCRYPTED',
      sender_id: userId,
      sender_device_id: body.sender_device_id || 'mock_device',
      megolm_session_id: body.megolm_session_id || 'mock_session',
      ciphertext: body.ciphertext || '',
      created_at: new Date().toISOString(),
      deleted: false,
      system: null,
    };

    messages.push(newMsg);
    mockMessages.set(id, messages);

    return HttpResponse.json(newMsg, { status: 201 });
  }),

  http.post('*/v1/chat/conversations/:id/attachments', async ({ params, request }) => {
    const { id } = params as { id: string };
    const body = (await request.json().catch(() => ({}))) as { size_bytes?: number };
    const size = Number(body.size_bytes);
    if (!Number.isInteger(size) || size < 1 || size > 26214400) {
      return HttpResponse.json(
        { type: '/problems/bad-request', title: 'Bad Request', status: 400, code: 'INVALID_SIZE' },
        { status: 400 },
      );
    }
    const now = new Date();
    const attachment: MockAttachment = {
      id: crypto.randomUUID(),
      conversation_id: id,
      size_bytes: size,
      state: 'PENDING',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 24 * 3600_000).toISOString(),
      message_seq: null,
    };
    mockAttachments.set(attachment.id, attachment);
    const origin = new URL(request.url).origin;
    return HttpResponse.json(
      {
        attachment: attachmentDto(attachment),
        upload_url: `${origin}/__mock-s3/winkey-chat/c/${id}/${attachment.id}`,
        upload_headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
        },
        upload_expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      },
      { status: 201 },
    );
  }),

  http.put('*/__mock-s3/winkey-chat/c/:conv/:aid', async ({ params, request }) => {
    const { aid } = params as { aid: string };
    const bytes = await request.arrayBuffer();
    const a = mockAttachments.get(aid);
    if (!a || bytes.byteLength !== a.size_bytes) return new HttpResponse(null, { status: 403 });
    mockBucket.set(aid, bytes);
    return new HttpResponse(null, { status: 200 });
  }),

  http.get('*/__mock-s3/winkey-chat/c/:conv/:aid', ({ params }) => {
    const bytes = mockBucket.get((params as { aid: string }).aid);
    return bytes
      ? new HttpResponse(bytes, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      : new HttpResponse(null, { status: 404 });
  }),

  http.post('*/v1/chat/conversations/:id/attachments/:aid/complete', ({ params }) => {
    const a = mockAttachments.get((params as { aid: string }).aid);
    if (!a) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Not Found', status: 404 },
        { status: 404 },
      );
    }
    if (!mockBucket.has(a.id)) {
      return HttpResponse.json(
        { type: '/problems/conflict', title: 'Conflict', status: 409, code: 'UPLOAD_INCOMPLETE' },
        { status: 409 },
      );
    }
    a.state = 'UPLOADED';
    return HttpResponse.json(attachmentDto(a));
  }),

  http.post('*/v1/chat/conversations/:id/attachments/:aid/download', ({ params, request }) => {
    const { id, aid } = params as { id: string; aid: string };
    const a = mockAttachments.get(aid);
    if (!a || a.state !== 'UPLOADED') {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Not Found', status: 404 },
        { status: 404 },
      );
    }
    if (new Date(a.expires_at).getTime() <= Date.now()) {
      return HttpResponse.json(
        { type: '/problems/gone', title: 'Gone', status: 410, code: 'ATTACHMENT_EXPIRED' },
        { status: 410 },
      );
    }
    const origin = new URL(request.url).origin;
    return HttpResponse.json({
      url: `${origin}/__mock-s3/winkey-chat/c/${id}/${aid}`,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      size_bytes: a.size_bytes,
    });
  }),

  http.delete('*/v1/chat/conversations/:id/messages/:seq', ({ params }) => {
    const { id, seq } = params as { id: string; seq: string };
    const messages = mockMessages.get(id) || [];
    const targetSeq = parseInt(seq, 10);
    const msg = messages.find((m) => m.seq === targetSeq);
    if (msg) {
      msg.deleted = true;
      msg.ciphertext = null;
    }
    return new HttpResponse(null, { status: 204 });
  }),
];
