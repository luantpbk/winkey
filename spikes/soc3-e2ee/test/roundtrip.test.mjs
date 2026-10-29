import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import init, {
  Account,
  Session,
  GroupSession,
  InboundGroupSession,
} from '../pkg/vodozemac_winkey.js';

// Setup Olm backend for Node environment tests
import Olm from '@matrix-org/olm';
globalThis.Olm = Olm;

describe('Vodozemac WASM / Olm Cryptographic Roundtrips', () => {
  before(async () => {
    await init();
  });

  test('Olm 1-1: Account generation, OTKs, and mutual ratcheted session', () => {
    // 1. Alice creates account with 50 one-time keys
    const alice = new Account();
    alice.generateOneTimeKeys(50);
    const aliceId = alice.curve25519Key();
    const aliceOtks = JSON.parse(alice.oneTimeKeys());
    const otkCount = Object.keys(aliceOtks.curve25519).length;
    assert.equal(otkCount, 50, 'Must have generated 50 one-time keys');
    alice.markKeysAsPublished();

    // 2. Bob creates outbound session to Alice using her first OTK
    const bob = new Account();
    const bobId = bob.curve25519Key();
    const firstOtk = Object.values(aliceOtks.curve25519)[0];

    const bobSession = bob.createOutboundSession(aliceId, firstOtk);
    assert.ok(bobSession.sessionId(), 'Bob session must have valid session_id');

    // 3. Bob sends initial message (PreKey type 0)
    const plaintext1 = 'Hello Alice, this is secret message #1';
    const enc1 = JSON.parse(bobSession.encrypt(plaintext1));
    assert.equal(enc1.type, 0, 'First message must be Olm PreKey message (type 0)');

    // 4. Alice receives and creates inbound session
    const aliceSession = alice.createInboundSession(bobId, enc1.type, enc1.body);
    assert.equal(
      aliceSession.sessionId(),
      bobSession.sessionId(),
      'Both parties must share the same session ID',
    );

    const dec1Bytes = aliceSession.decrypt(enc1.type, enc1.body);
    const dec1Text = new TextDecoder().decode(dec1Bytes);
    assert.equal(dec1Text, plaintext1, 'Alice must successfully decrypt Bob message');

    // 5. Alice replies (Normal message type 1)
    const replyText = 'Hi Bob! I received your message securely.';
    const encReply = JSON.parse(aliceSession.encrypt(replyText));
    assert.equal(encReply.type, 1, 'Subsequent message must be type 1 (ratcheted)');

    const decReplyBytes = bobSession.decrypt(encReply.type, encReply.body);
    const decReplyText = new TextDecoder().decode(decReplyBytes);
    assert.equal(decReplyText, replyText, 'Bob must successfully decrypt Alice reply');
  });

  test('Megolm: Outbound sender session to Inbound group session (group of 50)', () => {
    // 1. Group sender creates OutboundGroupSession
    const outboundGroup = new GroupSession();
    assert.equal(outboundGroup.messageIndex(), 0, 'Initial message index must be 0');
    const sessionKey = outboundGroup.sessionKey();
    const sessionId = outboundGroup.sessionId();
    assert.ok(sessionKey, 'Session key must be present');
    assert.ok(sessionId, 'Session ID must be present');

    // 2. Member creates InboundGroupSession from exported key
    const inboundGroup = new InboundGroupSession(sessionKey);
    assert.equal(inboundGroup.sessionId(), sessionId, 'Inbound session ID must match');
    assert.equal(inboundGroup.firstKnownIndex(), 0, 'First known index must be 0');

    // 3. Encrypt & decrypt group messages
    for (let i = 0; i < 5; i++) {
      const msg = `Group broadcast payload #${i} for 50 members`;
      const ciphertext = outboundGroup.encrypt(msg);
      assert.equal(outboundGroup.messageIndex(), i + 1, 'Ratchet index must increment');

      const decJson = inboundGroup.decrypt(ciphertext);
      const dec = JSON.parse(decJson);
      const decStr = new TextDecoder().decode(new Uint8Array(dec.plaintext));
      assert.equal(decStr, msg, `Message ${i} must match`);
      assert.equal(dec.message_index, i, `Message index ${i} must match`);
    }
  });

  test('Pickle & Unpickle: Success with correct 32-byte key, rejection with wrong key', () => {
    const account = new Account();
    account.generateOneTimeKeys(10);
    const correctKey = new Uint8Array(32).fill(7);
    const wrongKey = new Uint8Array(32).fill(9);

    const pickled = account.pickle(correctKey);
    assert.ok(typeof pickled === 'string' && pickled.length > 50);

    // Unpickle with correct key
    const restored = Account.fromPickle(pickled, correctKey);
    assert.equal(restored.curve25519Key(), account.curve25519Key());
    assert.equal(restored.ed25519Key(), account.ed25519Key());

    // Unpickle with wrong key must throw
    assert.throws(
      () => {
        Account.fromPickle(pickled, wrongKey);
      },
      /BAD_ACCOUNT_KEY|Bad pickle|unpickle failed/i,
      'Unpickle with wrong key must fail authentication',
    );
  });
});
