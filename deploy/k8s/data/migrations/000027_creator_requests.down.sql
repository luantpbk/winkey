DROP TABLE IF EXISTS auth.creator_requests;
DROP TYPE IF EXISTS auth.creator_request_status;
ALTER TABLE auth.users ALTER COLUMN roles SET DEFAULT '{viewer,creator}';
