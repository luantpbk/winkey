/* global fetch, console, Buffer, process */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerTestUser, TestDevice, checkRes, ensureWasm } from './chat.mjs';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8080';

/**
 * S14: E2EE Chat Attachments & Key Backup API Test Suite (SOC-3b, ADR-049)
 *
 * Scenarios:
 * 1. Attachments full lifecycle:
 *    - reserveAttachment -> PUT ciphertext -> completeAttachment -> send with attachment_ids -> recipient lists message with attachments -> download presigned GET -> bytes match.
 * 2. Guardrails & error handling:
 *    - PUT with wrong size -> completeAttachment returns 409 UPLOAD_INCOMPLETE.
 *    - Member added after message gets 404 on download; non-member gets 404.
 *    - Reusing attachment_id in a second message returns 409 ATTACHMENT_UNAVAILABLE.
 *    - Deleting the message makes the download 404.
 *    - Unsigned GET on the bucket is refused (403 Forbidden).
 * 3. Key backup lifecycle:
 *    - Create backup v1 -> duplicate create without replace returns 409 BACKUP_EXISTS.
 *    - Upload sessions -> lower first_message_index wins (kept count incremented for higher index).
 *    - Version mismatch returns 409 BACKUP_VERSION_MISMATCH.
 *    - Replace drops existing sessions and increments backup version.
 *    - Delete backup returns 204, subsequent GET returns 404.
 */
export async function runChatAttachmentsAndBackupScenario() {
  await ensureWasm();
  const startTime = Date.now();
  console.log('[S14-chat] Starting E2EE Chat Attachments and Key Backup API tests...');

  // ---------------------------------------------------------------------------
  // Step 1: User & Device Registration
  // ---------------------------------------------------------------------------
  console.log('[S14-chat] Registering Alice, Bob, and Carol with devices...');
  const alice = await registerTestUser('Alice Attachments');
  const bob = await registerTestUser('Bob Attachments');
  const carol = await registerTestUser('Carol Attachments');
  const stranger = await registerTestUser('Stranger Attachments');

  const aliceDev = new TestDevice(alice.id, crypto.randomUUID(), "Alice's Primary Device");
  aliceDev.generateFallbackKey();
  aliceDev.generateOneTimeKeys(10);
  await checkRes(await aliceDev.register(alice.token), 201, 'Register Alice Device');
  await checkRes(await aliceDev.uploadOneTimeKeys(alice.token), 200, 'Upload Alice OTKs');

  const bobDev = new TestDevice(bob.id, crypto.randomUUID(), "Bob's Primary Device");
  bobDev.generateFallbackKey();
  bobDev.generateOneTimeKeys(10);
  await checkRes(await bobDev.register(bob.token), 201, 'Register Bob Device');
  await checkRes(await bobDev.uploadOneTimeKeys(bob.token), 200, 'Upload Bob OTKs');

  const carolDev = new TestDevice(carol.id, crypto.randomUUID(), "Carol's Device");
  carolDev.generateFallbackKey();
  carolDev.generateOneTimeKeys(10);
  await checkRes(await carolDev.register(carol.token), 201, 'Register Carol Device');
  await checkRes(await carolDev.uploadOneTimeKeys(carol.token), 200, 'Upload Carol OTKs');

  // Alice creates DIRECT conversation with Bob
  const convRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'DIRECT', user_ids: [bob.id] }),
  });
  const conv = (await checkRes(convRes, 201, 'Alice creates DIRECT conv with Bob')).json;
  const convId = conv.id;

  // Bob accepts DIRECT conversation
  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/chat/conversations/${convId}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }),
    200,
    'Bob accepts conversation',
  );

  // ---------------------------------------------------------------------------
  // Step 2: Attachment Happy Path (create -> PUT -> complete -> send -> list -> download)
  // ---------------------------------------------------------------------------
  console.log(
    '[S14-chat] Testing Attachment Happy Path (create -> PUT -> complete -> send -> download)...',
  );
  const payloadBytes = Buffer.from(
    'ENCRYPTED-FILE-CIPHERTEXT-Winkey-SOC3b-' + crypto.randomBytes(512).toString('hex'),
  );
  const payloadSize = payloadBytes.length;

  // 1. Reserve attachment
  const reserveRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${convId}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender_device_id: aliceDev.deviceId,
      size_bytes: payloadSize,
    }),
  });
  const reserveData = (await checkRes(reserveRes, 201, 'Reserve attachment')).json;
  assert.ok(reserveData.attachment && reserveData.attachment.id);
  assert.equal(reserveData.attachment.size_bytes, payloadSize);
  assert.equal(reserveData.attachment.state, 'PENDING');
  assert.ok(reserveData.upload_url);
  assert.ok(reserveData.upload_headers);
  const attachmentId = reserveData.attachment.id;

  // 2. PUT ciphertext to presigned URL
  const uploadHeaders = {
    ...reserveData.upload_headers,
    'Content-Length': String(payloadSize),
  };
  const putRes = await fetch(reserveData.upload_url, {
    method: 'PUT',
    headers: uploadHeaders,
    body: payloadBytes,
  });
  assert.ok(
    putRes.status === 200 || putRes.status === 204,
    `PUT ciphertext failed with status ${putRes.status}`,
  );

  // 3. Complete attachment
  const completeRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${convId}/attachments/${attachmentId}/complete`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
    },
  );
  const completeData = (await checkRes(completeRes, 200, 'Complete attachment')).json;
  assert.equal(completeData.id, attachmentId);
  assert.equal(completeData.state, 'UPLOADED');

  // Idempotent completion check
  const completeAgainRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${convId}/attachments/${attachmentId}/complete`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
    },
  );
  const completeAgainData = (await checkRes(completeAgainRes, 200, 'Complete attachment again'))
    .json;
  assert.equal(completeAgainData.state, 'UPLOADED');

  // 4. Send message referencing attachment_ids
  const clientMsgId1 = crypto.randomUUID();
  const sessionId1 = crypto.randomBytes(16).toString('hex');
  const sendRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender_device_id: aliceDev.deviceId,
      client_msg_id: clientMsgId1,
      megolm_session_id: sessionId1,
      ciphertext: Buffer.from('MEGOLM-CIPHERTEXT-WITH-ATTACHMENT-KEY').toString('base64'),
      attachment_ids: [attachmentId],
    }),
  });
  const sendData = (await checkRes(sendRes, 201, 'Send message with attachment')).json;
  assert.ok(Array.isArray(sendData.attachments));
  assert.equal(sendData.attachments.length, 1);
  assert.equal(sendData.attachments[0].id, attachmentId);
  assert.equal(sendData.attachments[0].size_bytes, payloadSize);
  assert.equal(sendData.attachments[0].state, 'UPLOADED');
  const message1Seq = sendData.seq;

  // 5. Bob lists messages and sees attachments
  const listRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${convId}/messages`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  const listData = (await checkRes(listRes, 200, 'Bob lists messages')).json;
  const targetMsg = listData.items.find((m) => m.seq === message1Seq);
  assert.ok(targetMsg, 'Sent message must appear in Bob message list');
  assert.ok(Array.isArray(targetMsg.attachments) && targetMsg.attachments.length === 1);
  assert.equal(targetMsg.attachments[0].id, attachmentId);

  // 6. Bob downloads the attachment
  const downloadRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${convId}/attachments/${attachmentId}/download`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    },
  );
  const downloadData = (await checkRes(downloadRes, 200, 'Bob downloads attachment')).json;
  assert.ok(downloadData.url);
  assert.equal(downloadData.size_bytes, payloadSize);

  // 7. Verify downloaded bytes match uploaded bytes
  const getPayloadRes = await fetch(downloadData.url);
  assert.equal(getPayloadRes.status, 200, 'GET download_url returns 200');
  const downloadedBuf = Buffer.from(await getPayloadRes.arrayBuffer());
  assert.ok(
    downloadedBuf.equals(payloadBytes),
    'Downloaded bytes must exactly match uploaded bytes',
  );

  // ---------------------------------------------------------------------------
  // Step 3: Edge Case - Size Mismatch -> 409 UPLOAD_INCOMPLETE
  // ---------------------------------------------------------------------------
  console.log('[S14-chat] Testing size mismatch -> 409 UPLOAD_INCOMPLETE...');
  const badReserveRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${convId}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender_device_id: aliceDev.deviceId,
      size_bytes: 4096, // Claims 4096 bytes
    }),
  });
  const badReserveData = (await checkRes(badReserveRes, 201, 'Reserve with size 4096')).json;
  const badId = badReserveData.attachment.id;

  // Upload only 1024 bytes (mismatch)
  const partialBuf = Buffer.alloc(1024, 0x41);
  await fetch(badReserveData.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1024' },
    body: partialBuf,
  });

  const badCompleteRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${convId}/attachments/${badId}/complete`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
    },
  );
  const badCompleteData = (await checkRes(badCompleteRes, 409, 'Complete size mismatch')).json;
  assert.equal(badCompleteData.code, 'UPLOAD_INCOMPLETE');

  // ---------------------------------------------------------------------------
  // Step 4: Edge Case - Reusing attachment_id -> 409 ATTACHMENT_UNAVAILABLE
  // ---------------------------------------------------------------------------
  console.log('[S14-chat] Testing attachment reuse -> 409 ATTACHMENT_UNAVAILABLE...');
  const reuseRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender_device_id: aliceDev.deviceId,
      client_msg_id: crypto.randomUUID(),
      megolm_session_id: sessionId1,
      ciphertext: Buffer.from('MEGOLM-REUSE-ATTACHMENT').toString('base64'),
      attachment_ids: [attachmentId], // Already linked to message1Seq!
    }),
  });
  const reuseData = (await checkRes(reuseRes, 409, 'Reuse attachment in 2nd message')).json;
  assert.equal(reuseData.code, 'ATTACHMENT_UNAVAILABLE');

  // ---------------------------------------------------------------------------
  // Step 5: Group Access Control - Member added after message gets 404
  // ---------------------------------------------------------------------------
  console.log('[S14-chat] Testing group access control: late-joining member gets 404...');

  // Alice creates GROUP with Bob only
  const groupRes = await fetch(`${GATEWAY_URL}/v1/chat/conversations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'GROUP',
      title: 'Attachment Group Test',
      user_ids: [bob.id],
    }),
  });
  const group = (await checkRes(groupRes, 201, 'Create Group conv')).json;
  const groupId = group.id;

  // Bob accepts group
  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }),
    200,
    'Bob accepts group',
  );

  // Alice reserves, uploads, completes attachment in group
  const grpBuf = Buffer.from('GROUP-SECRET-ATTACHMENT-' + crypto.randomBytes(64).toString('hex'));
  const grpReserve = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender_device_id: aliceDev.deviceId, size_bytes: grpBuf.length }),
      }),
      201,
      'Reserve group attachment',
    )
  ).json;
  const grpAttachId = grpReserve.attachment.id;
  await fetch(grpReserve.upload_url, {
    method: 'PUT',
    headers: { ...grpReserve.upload_headers, 'Content-Length': String(grpBuf.length) },
    body: grpBuf,
  });
  await checkRes(
    await fetch(
      `${GATEWAY_URL}/v1/chat/conversations/${groupId}/attachments/${grpAttachId}/complete`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}` },
      },
    ),
    200,
    'Complete group attachment',
  );

  // Alice sends message in group carrying grpAttachId
  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender_device_id: aliceDev.deviceId,
        client_msg_id: crypto.randomUUID(),
        megolm_session_id: crypto.randomBytes(16).toString('hex'),
        ciphertext: Buffer.from('MEGOLM-GROUP-ATTACHMENT').toString('base64'),
        attachment_ids: [grpAttachId],
      }),
    }),
    201,
    'Send group message with attachment',
  );

  // Bob was a member when message was sent -> download succeeds
  const bobGrpDl = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${groupId}/attachments/${grpAttachId}/download`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    },
  );
  assert.equal(bobGrpDl.status, 200, 'Original member Bob can download group attachment');

  // Now Alice adds Carol to group
  await checkRes(
    await fetch(`${GATEWAY_URL}/v1/chat/conversations/${groupId}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_ids: [carol.id] }),
    }),
    200,
    'Alice adds Carol to group after message',
  );

  // Carol was added AFTER message was sent -> joined_seq is higher than message seq -> download must be 404
  const carolGrpDl = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${groupId}/attachments/${grpAttachId}/download`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.token}` },
    },
  );
  assert.equal(carolGrpDl.status, 404, 'Late-joining member Carol must get 404 on download');

  // Stranger non-member -> 404
  const strangerDl = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${groupId}/attachments/${grpAttachId}/download`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${stranger.token}` },
    },
  );
  assert.equal(strangerDl.status, 404, 'Non-member stranger must get 404 on download');

  // ---------------------------------------------------------------------------
  // Step 6: Message Deletion -> Attachment Download returns 404
  // ---------------------------------------------------------------------------
  console.log('[S14-chat] Testing message deletion -> download returns 404...');
  // Delete message1Seq in convId
  const deleteRes = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${convId}/messages/${message1Seq}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.token}` },
    },
  );
  assert.equal(deleteRes.status, 204, 'Delete message returns 204');

  // Bob attempts download on deleted message attachment -> 404
  const dlAfterDelete = await fetch(
    `${GATEWAY_URL}/v1/chat/conversations/${convId}/attachments/${attachmentId}/download`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    },
  );
  assert.equal(dlAfterDelete.status, 404, 'Download after message delete must return 404');

  // ---------------------------------------------------------------------------
  // Step 7: Unsigned Bucket Direct Access is Refused (403)
  // ---------------------------------------------------------------------------
  console.log('[S14-chat] Testing unsigned GET on S3 bucket is refused...');
  // Strip query signature from presigned download url
  const unsignedUrl = downloadData.url.split('?')[0];
  const unsignedRes = await fetch(unsignedUrl);
  assert.equal(
    unsignedRes.status,
    403,
    `Direct unsigned GET on bucket must return 403 Forbidden (got ${unsignedRes.status})`,
  );

  // ---------------------------------------------------------------------------
  // Step 8: Key Backup Full Matrix (create, 409 without replace, sessions index wins, version mismatch, replace drops)
  // ---------------------------------------------------------------------------
  console.log('[S14-chat] Testing Key Backup API matrix...');
  const initialAuthData = {
    kdf: 'argon2id',
    salt: 'c2FsdF90ZXN0XzE2Yg',
    m_kib: 65536,
    t: 3,
    p: 1,
    wrapped_key: Buffer.from('WRAPPED-BACKUP-KEY-32BYTES').toString('base64'),
    iv: Buffer.from('IV-12BYTES-OK').toString('base64'),
    key_check: Buffer.from('KEY-CHECK-8BYTES').toString('base64'),
  };

  // 1. Create key backup v1
  const createBackupRes = await fetch(`${GATEWAY_URL}/v1/chat/key-backup`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      algorithm: 'winkey.backup.v1',
      auth_data: initialAuthData,
    }),
  });
  const backupData = (await checkRes(createBackupRes, 201, 'Create key backup v1')).json;
  assert.equal(backupData.version, 1);
  assert.equal(backupData.session_count, 0);

  // 2. Duplicate create without replace -> 409 BACKUP_EXISTS
  const dupBackupRes = await fetch(`${GATEWAY_URL}/v1/chat/key-backup`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      algorithm: 'winkey.backup.v1',
      auth_data: initialAuthData,
    }),
  });
  const dupData = (await checkRes(dupBackupRes, 409, 'Duplicate create without replace')).json;
  assert.equal(dupData.code, 'BACKUP_EXISTS');

  // 3. Upload sessions: first_message_index wins rule
  console.log('[S14-chat] Testing session key backup: lower first_message_index wins...');
  const testSessionId = 'megolm_sess_' + crypto.randomBytes(8).toString('hex');
  // First upload: index 5
  const uploadSess1 = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/key-backup/sessions`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          sessions: [
            {
              conversation_id: convId,
              session_id: testSessionId,
              first_message_index: 5,
              ciphertext: Buffer.from('SEALED-SESSION-INDEX-5').toString('base64'),
            },
          ],
        }),
      }),
      200,
      'Upload session index 5',
    )
  ).json;
  assert.deepEqual(uploadSess1, { stored: 1, kept: 0 });

  // Second upload: index 10 (higher -> kept, skipped)
  const uploadSessHigher = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/key-backup/sessions`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          sessions: [
            {
              conversation_id: convId,
              session_id: testSessionId,
              first_message_index: 10,
              ciphertext: Buffer.from('SEALED-SESSION-INDEX-10').toString('base64'),
            },
          ],
        }),
      }),
      200,
      'Upload session index 10 (higher -> kept)',
    )
  ).json;
  assert.deepEqual(uploadSessHigher, { stored: 0, kept: 1 });

  // Third upload: index 2 (lower -> wins, stored)
  const uploadSessLower = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/key-backup/sessions`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          sessions: [
            {
              conversation_id: convId,
              session_id: testSessionId,
              first_message_index: 2,
              ciphertext: Buffer.from('SEALED-SESSION-INDEX-2').toString('base64'),
            },
          ],
        }),
      }),
      200,
      'Upload session index 2 (lower -> wins)',
    )
  ).json;
  assert.deepEqual(uploadSessLower, { stored: 1, kept: 0 });

  // Verify session_count in backup
  const getBackupRes = await fetch(`${GATEWAY_URL}/v1/chat/key-backup`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  const currentBackup = (await checkRes(getBackupRes, 200, 'Get key backup status')).json;
  assert.equal(currentBackup.session_count, 1);

  // 4. Version mismatch -> 409 BACKUP_VERSION_MISMATCH
  const mismatchRes = await fetch(`${GATEWAY_URL}/v1/chat/key-backup/sessions`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 99,
      sessions: [
        {
          conversation_id: convId,
          session_id: testSessionId,
          first_message_index: 0,
          ciphertext: 'QUJD',
        },
      ],
    }),
  });
  const mismatchData = (await checkRes(mismatchRes, 409, 'Upload sessions wrong version')).json;
  assert.equal(mismatchData.code, 'BACKUP_VERSION_MISMATCH');

  // 5. Replace drops existing sessions and bumps version
  console.log('[S14-chat] Testing replace drops sessions and bumps version...');
  const replacedBackup = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/key-backup`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          algorithm: 'winkey.backup.v1',
          auth_data: { ...initialAuthData, salt: 'bmV3X3NhbHRfdmFsdWU' },
          replace: true,
        }),
      }),
      200,
      'Replace key backup',
    )
  ).json;
  assert.equal(replacedBackup.version, 2);
  assert.equal(replacedBackup.session_count, 0);

  // Version 2 should have 0 sessions
  const listSessionsV2 = (
    await checkRes(
      await fetch(`${GATEWAY_URL}/v1/chat/key-backup/sessions?version=2`, {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
      200,
      'List sessions for version 2',
    )
  ).json;
  assert.equal(listSessionsV2.items.length, 0);

  // Old version 1 upload now returns 409 BACKUP_VERSION_MISMATCH
  const oldVersionRes = await fetch(`${GATEWAY_URL}/v1/chat/key-backup/sessions`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      sessions: [
        {
          conversation_id: convId,
          session_id: testSessionId,
          first_message_index: 0,
          ciphertext: 'QUJD',
        },
      ],
    }),
  });
  assert.equal(oldVersionRes.status, 409);

  // 6. Delete backup
  const deleteBackupRes = await fetch(`${GATEWAY_URL}/v1/chat/key-backup`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  assert.equal(deleteBackupRes.status, 204, 'DELETE /v1/chat/key-backup returns 204');

  const getDeletedBackup = await fetch(`${GATEWAY_URL}/v1/chat/key-backup`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  assert.equal(getDeletedBackup.status, 404, 'GET deleted key-backup returns 404');

  const durationMs = Date.now() - startTime;
  console.log(`[S14-chat] ALL S14 API tests PASSED in ${(durationMs / 1000).toFixed(2)}s! ✅`);
  return { durationMs };
}
