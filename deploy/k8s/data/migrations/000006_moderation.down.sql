ALTER TABLE media.videos
    DROP CONSTRAINT IF EXISTS videos_moderation_reason_len,
    DROP CONSTRAINT IF EXISTS videos_moderation_consistent,
    DROP COLUMN IF EXISTS moderated_at,
    DROP COLUMN IF EXISTS moderated_by,
    DROP COLUMN IF EXISTS moderation_reason,
    DROP COLUMN IF EXISTS moderation_state;
DROP TYPE IF EXISTS media.moderation_state;

ALTER TABLE social.videos DROP COLUMN IF EXISTS hidden;
DROP TABLE IF EXISTS social.reports;
DROP TYPE IF EXISTS social.report_status;
DROP TYPE IF EXISTS social.report_reason;
DROP TYPE IF EXISTS social.report_target;

DROP INDEX IF EXISTS auth.users_created;
DROP INDEX IF EXISTS auth.users_display_name_trgm;
DROP TABLE IF EXISTS auth.audit_log;
DROP TYPE IF EXISTS auth.audit_action;
-- Rows still SUSPENDED keep that status; their details are dropped with the columns.
ALTER TABLE auth.users
    DROP CONSTRAINT IF EXISTS users_suspension_reason_len,
    DROP CONSTRAINT IF EXISTS users_suspension_consistent,
    DROP COLUMN IF EXISTS suspension_reason,
    DROP COLUMN IF EXISTS suspended_until;
