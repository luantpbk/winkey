\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000000d1', 'role1-user@example.com', 'role1_user', 'R1'),
       ('00000000-0000-7000-8000-0000000000d2', 'role1-admin@example.com', 'role1_admin', 'R1A');

-- ROLE1: new accounts are viewer-only by default.
DO $$
BEGIN
    IF (SELECT roles FROM auth.users WHERE id = '00000000-0000-7000-8000-0000000000d1') <> '{viewer}'::auth.role[] THEN
        RAISE EXCEPTION 'TEST FAILED: default roles must be {viewer}';
    END IF;
END $$;

INSERT INTO auth.creator_requests (id, user_id, message)
VALUES ('00000000-0000-7000-8000-00000000d101', '00000000-0000-7000-8000-0000000000d1', 'I publish travel vlogs.');

DO $$
BEGIN
    -- One PENDING request per user.
    BEGIN
        INSERT INTO auth.creator_requests (id, user_id, message)
        VALUES ('00000000-0000-7000-8000-00000000d102', '00000000-0000-7000-8000-0000000000d1', 'Second pending one');
        RAISE EXCEPTION 'TEST FAILED: a second PENDING request was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- Message length.
    BEGIN
        INSERT INTO auth.creator_requests (id, user_id, message)
        VALUES ('00000000-0000-7000-8000-00000000d103', '00000000-0000-7000-8000-0000000000d2', 'short');
        RAISE EXCEPTION 'TEST FAILED: a message under 10 characters was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- A decided request needs decided_by and decided_at.
    BEGIN
        UPDATE auth.creator_requests SET status = 'APPROVED' WHERE id = '00000000-0000-7000-8000-00000000d101';
        RAISE EXCEPTION 'TEST FAILED: APPROVED without decided_by/decided_at was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- A rejection needs a note.
    BEGIN
        UPDATE auth.creator_requests
        SET status = 'REJECTED', decided_by = '00000000-0000-7000-8000-0000000000d2', decided_at = now()
        WHERE id = '00000000-0000-7000-8000-00000000d101';
        RAISE EXCEPTION 'TEST FAILED: REJECTED without a note was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- A PENDING request cannot carry a decision.
    BEGIN
        UPDATE auth.creator_requests SET decided_by = '00000000-0000-7000-8000-0000000000d2'
        WHERE id = '00000000-0000-7000-8000-00000000d101';
        RAISE EXCEPTION 'TEST FAILED: PENDING with decided_by was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;

-- Once decided, the user may open a new PENDING request.
UPDATE auth.creator_requests
SET status = 'REJECTED', decided_by = '00000000-0000-7000-8000-0000000000d2', decided_at = now(),
    decision_note = 'Please add a channel description first.'
WHERE id = '00000000-0000-7000-8000-00000000d101';
INSERT INTO auth.creator_requests (id, user_id, message)
VALUES ('00000000-0000-7000-8000-00000000d104', '00000000-0000-7000-8000-0000000000d1', 'Added a description now.');

-- Deleting the user removes their requests.
DELETE FROM auth.users WHERE id = '00000000-0000-7000-8000-0000000000d1';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM auth.creator_requests WHERE user_id = '00000000-0000-7000-8000-0000000000d1') THEN
        RAISE EXCEPTION 'TEST FAILED: requests of a deleted user remain';
    END IF;
END $$;
