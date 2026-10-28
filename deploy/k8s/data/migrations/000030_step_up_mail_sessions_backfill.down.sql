-- The enum value STEP_UP_CODE stays (PostgreSQL cannot drop an enum value); queued rows using it must be
-- gone before an older auth-svc runs. Backfilled sessions stay: they describe real live families.
DELETE FROM auth.mail_queue WHERE template::text = 'STEP_UP_CODE';
