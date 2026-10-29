\set ON_ERROR_STOP on

DO $$
DECLARE
    a    constant uuid := '00000000-0000-7000-8000-0000000000c1';
    b    constant uuid := '00000000-0000-7000-8000-0000000000c2';
    dev  constant uuid := '00000000-0000-7000-8000-00000000c0d1';
    conv constant uuid := '00000000-0000-7000-8000-00000000c0c1';
    k43  constant text := repeat('A', 43);
    k86  constant text := repeat('B', 86);
BEGIN
    INSERT INTO chat.devices (id, user_id, display_name, curve25519_key, ed25519_key, signature)
    VALUES (dev, a, 'Chrome trên Linux', k43, k43, k86);
    -- An identity key is unique across devices.
    BEGIN
        INSERT INTO chat.devices (id, user_id, display_name, curve25519_key, ed25519_key, signature)
        VALUES (gen_random_uuid(), b, 'Firefox', k43, repeat('C', 43), k86);
        RAISE EXCEPTION 'TEST FAILED: a reused curve25519 identity key was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- Malformed keys are refused.
    BEGIN
        INSERT INTO chat.devices (id, user_id, display_name, curve25519_key, ed25519_key, signature)
        VALUES (gen_random_uuid(), b, 'x', 'short', repeat('D', 43), k86);
        RAISE EXCEPTION 'TEST FAILED: a short identity key was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- A fallback key comes with its id and signature, or not at all.
    BEGIN
        UPDATE chat.devices SET fallback_key = repeat('E', 43) WHERE id = dev;
        RAISE EXCEPTION 'TEST FAILED: a fallback key without id and signature was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- One-time keys go with their device.
    INSERT INTO chat.one_time_keys (device_id, key_id, public_key, signature) VALUES (dev, 'AAAAAQ', k43, k86);
    DELETE FROM chat.devices WHERE id = dev;
    IF EXISTS (SELECT 1 FROM chat.one_time_keys WHERE device_id = dev) THEN
        RAISE EXCEPTION 'TEST FAILED: one-time keys survived their device';
    END IF;
    INSERT INTO chat.devices (id, user_id, display_name, curve25519_key, ed25519_key, signature)
    VALUES (dev, a, 'Chrome trên Linux', k43, k43, k86);

    -- DIRECT conversations: one per pair, no title; GROUP needs a title.
    INSERT INTO chat.conversations (id, kind, created_by, direct_key) VALUES (conv, 'DIRECT', a, a || ':' || b);
    BEGIN
        INSERT INTO chat.conversations (id, kind, created_by, direct_key)
        VALUES (gen_random_uuid(), 'DIRECT', b, a || ':' || b);
        RAISE EXCEPTION 'TEST FAILED: a second DIRECT conversation for the same pair was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO chat.conversations (id, kind, created_by) VALUES (gen_random_uuid(), 'GROUP', a);
        RAISE EXCEPTION 'TEST FAILED: a GROUP without a title was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO chat.conversations (id, kind, created_by, direct_key, title)
        VALUES (gen_random_uuid(), 'DIRECT', a, b || ':' || a, 'x');
        RAISE EXCEPTION 'TEST FAILED: a DIRECT conversation with a title was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Members: LEFT exactly when left_seq is set.
    INSERT INTO chat.members (conversation_id, user_id, role, state, joined_seq) VALUES (conv, a, 'OWNER', 'ACTIVE', 1);
    INSERT INTO chat.members (conversation_id, user_id, state, joined_seq) VALUES (conv, b, 'REQUESTED', 1);
    BEGIN
        UPDATE chat.members SET state = 'LEFT' WHERE conversation_id = conv AND user_id = b;
        RAISE EXCEPTION 'TEST FAILED: LEFT without left_seq was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Messages: shape and idempotency.
    INSERT INTO chat.messages (conversation_id, seq, id, kind, sender_id, sender_device_id, client_msg_id,
                               megolm_session_id, ciphertext)
    VALUES (conv, 1, gen_random_uuid(), 'ENCRYPTED', a, dev, '00000000-0000-7000-8000-00000000c001', 'sess', 'Y2lwaGVy');
    BEGIN
        INSERT INTO chat.messages (conversation_id, seq, id, kind, sender_id, sender_device_id, client_msg_id,
                                   megolm_session_id, ciphertext)
        VALUES (conv, 2, gen_random_uuid(), 'ENCRYPTED', a, dev, '00000000-0000-7000-8000-00000000c001', 'sess', 'eA');
        RAISE EXCEPTION 'TEST FAILED: a repeated client_msg_id was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO chat.messages (conversation_id, seq, id, kind, sender_id, system_body)
        VALUES (conv, 2, gen_random_uuid(), 'SYSTEM', a, '{"type":"member_added"}');
        RAISE EXCEPTION 'TEST FAILED: a SYSTEM message with a sender was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO chat.messages (conversation_id, seq, id, kind, system_body)
    VALUES (conv, 2, gen_random_uuid(), 'SYSTEM', jsonb_build_object('type', 'member_added', 'user_id', b, 'by', a));
    BEGIN
        UPDATE chat.messages SET ciphertext = NULL WHERE conversation_id = conv AND seq = 1;
        RAISE EXCEPTION 'TEST FAILED: ciphertext removed without deleted_at';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE chat.messages SET ciphertext = NULL, deleted_at = now() WHERE conversation_id = conv AND seq = 1;
    BEGIN
        INSERT INTO chat.messages (conversation_id, seq, id, kind, sender_id, sender_device_id, client_msg_id,
                                   megolm_session_id, ciphertext)
        VALUES (conv, 3, gen_random_uuid(), 'ENCRYPTED', a, dev, gen_random_uuid(), 'sess', repeat('Z', 87385));
        RAISE EXCEPTION 'TEST FAILED: a ciphertext over 64 KiB was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- To-device messages go with their recipient device; deleting the conversation cascades.
    INSERT INTO chat.to_device (recipient_device_id, sender_id, sender_device_id, ciphertext) VALUES (dev, b, dev, 'b2xt');
    DELETE FROM chat.devices WHERE id = dev;
    IF EXISTS (SELECT 1 FROM chat.to_device WHERE recipient_device_id = dev) THEN
        RAISE EXCEPTION 'TEST FAILED: to-device messages survived their device';
    END IF;
    DELETE FROM chat.conversations WHERE id = conv;
    IF EXISTS (SELECT 1 FROM chat.members WHERE conversation_id = conv)
       OR EXISTS (SELECT 1 FROM chat.messages WHERE conversation_id = conv) THEN
        RAISE EXCEPTION 'TEST FAILED: members or messages survived their conversation';
    END IF;
END $$;
