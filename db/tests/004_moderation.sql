\set ON_ERROR_STOP on

-- auth: suspension details must match the status.
INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000000e1', 'mod-target@example.com', 'mod.target', 'Target');

UPDATE auth.users
SET status = 'SUSPENDED', suspension_reason = 'spam', suspended_until = now() + interval '7 days'
WHERE id = '00000000-0000-7000-8000-0000000000e1';

DO $$
BEGIN
    UPDATE auth.users SET status = 'SUSPENDED', suspension_reason = NULL
    WHERE id = '00000000-0000-7000-8000-0000000000e1';
    RAISE EXCEPTION 'TEST FAILED: SUSPENDED without a reason was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

DO $$
BEGIN
    UPDATE auth.users SET status = 'ACTIVE'
    WHERE id = '00000000-0000-7000-8000-0000000000e1';
    RAISE EXCEPTION 'TEST FAILED: ACTIVE with leftover suspension details was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

UPDATE auth.users SET status = 'ACTIVE', suspension_reason = NULL, suspended_until = NULL
WHERE id = '00000000-0000-7000-8000-0000000000e1';

INSERT INTO auth.audit_log (id, actor_id, action, target_user_id, details) VALUES
    ('00000000-0000-7000-8000-0000000000f1', '00000000-0000-7000-8000-0000000000e2', 'USER_SUSPENDED',
     '00000000-0000-7000-8000-0000000000e1', '{"reason":"spam"}');

-- social: one OPEN report per reporter and target; a resolved one frees the slot.
INSERT INTO social.reports (id, reporter_id, target_type, target_id, reason) VALUES
    ('00000000-0000-7000-8000-00000000e101', '00000000-0000-7000-8000-0000000000a1', 'VIDEO',
     '00000000-0000-7000-8000-00000000c101', 'SPAM');

DO $$
BEGIN
    INSERT INTO social.reports (id, reporter_id, target_type, target_id, reason) VALUES
        ('00000000-0000-7000-8000-00000000e102', '00000000-0000-7000-8000-0000000000a1', 'VIDEO',
         '00000000-0000-7000-8000-00000000c101', 'HATE');
    RAISE EXCEPTION 'TEST FAILED: second OPEN report by the same reporter was allowed';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

DO $$
BEGIN
    UPDATE social.reports SET status = 'DISMISSED'
    WHERE id = '00000000-0000-7000-8000-00000000e101';
    RAISE EXCEPTION 'TEST FAILED: resolved report without resolved_by was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

UPDATE social.reports
SET status = 'DISMISSED', resolved_by = '00000000-0000-7000-8000-0000000000e2', resolved_at = now()
WHERE id = '00000000-0000-7000-8000-00000000e101';

INSERT INTO social.reports (id, reporter_id, target_type, target_id, reason) VALUES
    ('00000000-0000-7000-8000-00000000e103', '00000000-0000-7000-8000-0000000000a1', 'VIDEO',
     '00000000-0000-7000-8000-00000000c101', 'SPAM');

-- social: projection flag defaults to not hidden.
INSERT INTO social.videos (id, owner_id) VALUES
    ('00000000-0000-7000-8000-00000000c101', '00000000-0000-7000-8000-0000000000c0');
DO $$
BEGIN
    IF (SELECT hidden FROM social.videos WHERE id = '00000000-0000-7000-8000-00000000c101') THEN
        RAISE EXCEPTION 'TEST FAILED: new projection row is hidden';
    END IF;
END $$;

-- media: HIDDEN needs reason, moderator and time.
INSERT INTO media.videos (id, owner_id, title, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000b101', '00000000-0000-7000-8000-0000000000c0', 'Clip',
        'winkey-raw', 'k', 'video/mp4', 1024);

DO $$
BEGIN
    UPDATE media.videos SET moderation_state = 'HIDDEN'
    WHERE id = '00000000-0000-7000-8000-00000000b101';
    RAISE EXCEPTION 'TEST FAILED: HIDDEN without a reason was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

UPDATE media.videos
SET moderation_state = 'HIDDEN', moderation_reason = 'copyright',
    moderated_by = '00000000-0000-7000-8000-0000000000e2', moderated_at = now()
WHERE id = '00000000-0000-7000-8000-00000000b101';

UPDATE media.videos
SET moderation_state = 'VISIBLE', moderation_reason = NULL
WHERE id = '00000000-0000-7000-8000-00000000b101';
