\set ON_ERROR_STOP on

DO $$
DECLARE
    a    constant uuid := '00000000-0000-7000-8000-0000000000d1';
    dev  constant uuid := '00000000-0000-7000-8000-00000000d0d1';
    conv constant uuid := '00000000-0000-7000-8000-00000000d0c1';
    att  constant uuid := '00000000-0000-7000-8000-00000000d0a1';
    att2 constant uuid := '00000000-0000-7000-8000-00000000d0a2';
BEGIN
    INSERT INTO chat.conversations (id, kind, created_by, direct_key) VALUES (conv, 'DIRECT', a, 'x:y');
    INSERT INTO chat.messages (conversation_id, seq, id, kind, sender_id, sender_device_id, client_msg_id,
                               megolm_session_id, ciphertext)
    VALUES (conv, 1, gen_random_uuid(), 'ENCRYPTED', a, dev, gen_random_uuid(), 's', 'Y2lwaGVy');

    INSERT INTO chat.attachments (id, conversation_id, uploader_id, uploader_device_id, size_bytes, expires_at)
    VALUES (att, conv, a, dev, 1024, now() + interval '30 days');
    -- Larger than 25 MiB is refused.
    BEGIN
        INSERT INTO chat.attachments (id, conversation_id, uploader_id, uploader_device_id, size_bytes, expires_at)
        VALUES (att2, conv, a, dev, 26214401, now() + interval '30 days');
        RAISE EXCEPTION 'TEST FAILED: an attachment over 25 MiB was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- A PENDING attachment cannot be linked to a message.
    BEGIN
        UPDATE chat.attachments SET message_seq = 1 WHERE id = att;
        RAISE EXCEPTION 'TEST FAILED: a PENDING attachment was linked to a message';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- UPLOADED needs uploaded_at.
    BEGIN
        UPDATE chat.attachments SET state = 'UPLOADED' WHERE id = att;
        RAISE EXCEPTION 'TEST FAILED: UPLOADED without uploaded_at was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE chat.attachments SET state = 'UPLOADED', uploaded_at = now() WHERE id = att;
    -- It can only reference a message that exists in the same conversation.
    BEGIN
        UPDATE chat.attachments SET message_seq = 2 WHERE id = att;
        RAISE EXCEPTION 'TEST FAILED: an attachment referenced a missing message';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    UPDATE chat.attachments SET message_seq = 1 WHERE id = att;

    -- Key backup: one per user, known algorithm, bounded auth_data; sessions go with it.
    INSERT INTO chat.key_backups (user_id, version, algorithm, auth_data)
    VALUES (a, 1, 'winkey.backup.v1', '{"salt":"c2FsdA","wrapped_key":"a2V5"}');
    BEGIN
        INSERT INTO chat.key_backups (user_id, version, algorithm, auth_data)
        VALUES (dev, 1, 'other', '{}');
        RAISE EXCEPTION 'TEST FAILED: an unknown backup algorithm was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO chat.key_backups (user_id, version, algorithm, auth_data)
        VALUES (dev, 1, 'winkey.backup.v1', jsonb_build_object('pad', repeat('x', 5000)));
        RAISE EXCEPTION 'TEST FAILED: auth_data over 4 KiB was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO chat.key_backup_sessions (user_id, conversation_id, session_id, first_message_index, ciphertext)
    VALUES (a, conv, 'sess1', 0, 'Y2lwaGVy');
    BEGIN
        INSERT INTO chat.key_backup_sessions (user_id, conversation_id, session_id, first_message_index, ciphertext)
        VALUES (a, conv, 'sess2', -1, 'Y2lwaGVy');
        RAISE EXCEPTION 'TEST FAILED: a negative first_message_index was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    DELETE FROM chat.key_backups WHERE user_id = a;
    IF EXISTS (SELECT 1 FROM chat.key_backup_sessions WHERE user_id = a) THEN
        RAISE EXCEPTION 'TEST FAILED: backup sessions survived their backup';
    END IF;

    -- Attachments go with their conversation.
    DELETE FROM chat.conversations WHERE id = conv;
    IF EXISTS (SELECT 1 FROM chat.attachments WHERE conversation_id = conv) THEN
        RAISE EXCEPTION 'TEST FAILED: attachments survived their conversation';
    END IF;
END $$;
