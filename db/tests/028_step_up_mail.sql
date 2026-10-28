\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000000e1', 'stepup@example.com', 'stepup_a', 'Step Up');

DO $$
BEGIN
    -- The step-up e-mail code has its own template.
    INSERT INTO auth.mail_queue (user_id, to_email, template, params)
    VALUES ('00000000-0000-7000-8000-0000000000e1', 'stepup@example.com', 'STEP_UP_CODE', '{"code":"123456"}');
    IF NOT EXISTS (SELECT 1 FROM auth.mail_queue WHERE template = 'STEP_UP_CODE') THEN
        RAISE EXCEPTION 'TEST FAILED: STEP_UP_CODE mail was not queued';
    END IF;
END
$$;
