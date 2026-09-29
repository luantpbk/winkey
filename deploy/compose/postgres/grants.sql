-- =============================================================================
-- Winkey Database Grants (applied as winkey_migrator after migrations complete)
-- Permissions matrix specified in db/README.md
-- =============================================================================

-- 1. auth schema: USAGE for auth_svc and media_svc; CRUD for auth_svc
GRANT USAGE ON SCHEMA auth TO auth_svc, media_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO auth_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO auth_svc;

ALTER DEFAULT PRIVILEGES FOR ROLE winkey_migrator IN SCHEMA auth
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE winkey_migrator IN SCHEMA auth
    GRANT USAGE, SELECT ON SEQUENCES TO auth_svc;

-- 2. media schema: USAGE and CRUD for media_svc
GRANT USAGE ON SCHEMA media TO media_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA media TO media_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA media TO media_svc;

ALTER DEFAULT PRIVILEGES FOR ROLE winkey_migrator IN SCHEMA media
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO media_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE winkey_migrator IN SCHEMA media
    GRANT USAGE, SELECT ON SEQUENCES TO media_svc;

-- 3. media_svc cross-domain read: SELECT ONLY on auth.public_profiles (never auth.users)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'auth' AND viewname = 'public_profiles') THEN
        GRANT SELECT ON auth.public_profiles TO media_svc;
    END IF;
END
$$;
