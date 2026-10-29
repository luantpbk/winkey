use crate::account::Account;
use crate::group_session::GroupSession;
use crate::inbound_group_session::InboundGroupSession;

#[test]
fn test_olm_1to1_roundtrip() {
    let mut alice = Account::new();
    alice.generate_one_time_keys(10);
    let alice_keys_json = alice.identity_keys().unwrap();
    let alice_otks_json = alice.one_time_keys().unwrap();

    let alice_otks: std::collections::BTreeMap<String, String> =
        serde_json::from_str(&alice_otks_json).unwrap();
    let (_key_id, first_otk) = alice_otks.iter().next().unwrap();

    let bob = Account::new();
    let alice_id = alice.curve25519_key();
    let mut bob_session = bob
        .create_outbound_session(&alice_id, first_otk)
        .expect("bob outbound session");

    let payload = b"Hello from Bob to Alice - 1KiB Olm message test";
    let enc_json = bob_session.encrypt(payload).expect("encrypt");

    #[derive(serde::Deserialize)]
    struct MsgDto {
        #[serde(rename = "type")]
        msg_type: usize,
        body: String,
    }
    let msg: MsgDto = serde_json::from_str(&enc_json).unwrap();
    assert_eq!(msg.msg_type, 0, "Initial message must be PreKey type 0");

    let mut alice_session = alice
        .create_inbound_session(&bob.curve25519_key(), msg.msg_type, &msg.body)
        .expect("alice inbound session");

    let decrypted = alice_session
        .decrypt(msg.msg_type, &msg.body)
        .expect("decrypt");
    assert_eq!(decrypted, payload);

    // Subsequent normal message (type 1)
    let reply_payload = b"Hello back from Alice!";
    let reply_enc_json = alice_session.encrypt(reply_payload).expect("reply encrypt");
    let reply_msg: MsgDto = serde_json::from_str(&reply_enc_json).unwrap();
    assert_eq!(reply_msg.msg_type, 1, "Subsequent message must be type 1");

    let decrypted_reply = bob_session
        .decrypt(reply_msg.msg_type, &reply_msg.body)
        .expect("decrypt reply");
    assert_eq!(decrypted_reply, reply_payload);
}

#[test]
fn test_megolm_group_roundtrip() {
    let mut group = GroupSession::new();
    let session_key = group.session_key();
    assert_eq!(group.message_index(), 0);

    let mut inbound = InboundGroupSession::new(&session_key).expect("inbound session");
    assert_eq!(inbound.first_known_index(), 0);

    let message1 = b"Group message 1";
    let ciphertext1 = group.encrypt(message1);
    assert_eq!(group.message_index(), 1);

    let dec_json1 = inbound.decrypt(&ciphertext1).expect("decrypt msg 1");
    #[derive(serde::Deserialize)]
    struct DecDto {
        plaintext: Vec<u8>,
        message_index: u32,
    }
    let dec1: DecDto = serde_json::from_str(&dec_json1).unwrap();
    assert_eq!(dec1.plaintext, message1);
    assert_eq!(dec1.message_index, 0);

    let message2 = b"Group message 2 with longer text";
    let ciphertext2 = group.encrypt(message2);
    assert_eq!(group.message_index(), 2);

    let dec_json2 = inbound.decrypt(&ciphertext2).expect("decrypt msg 2");
    let dec2: DecDto = serde_json::from_str(&dec_json2).unwrap();
    assert_eq!(dec2.plaintext, message2);
    assert_eq!(dec2.message_index, 1);
}

#[test]
fn test_pickle_roundtrip_and_wrong_key_rejection() {
    let account = Account::new();
    let key_correct = [42u8; 32];
    let key_wrong = [99u8; 32];

    let pickle = account.pickle(&key_correct).expect("pickle account");
    assert!(!pickle.is_empty());

    // Restore with correct key
    let restored = Account::from_pickle(&pickle, &key_correct).expect("restore account");
    assert_eq!(account.curve25519_key(), restored.curve25519_key());
    assert_eq!(account.ed25519_key(), restored.ed25519_key());

    // Restore with wrong key must fail
    let failed = Account::from_pickle(&pickle, &key_wrong);
    assert!(failed.is_err(), "Unpickle with wrong key must return Err");
}
