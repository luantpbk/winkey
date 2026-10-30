-- =============================================================================
-- Winkey Database Grants (applied as winkey_migrator after migrations complete)
-- Permissions matrix specified in db/README.md
-- =============================================================================

-- 1. auth schema: USAGE for auth_svc, media_svc, social_svc; CRUD for auth_svc
GRANT USAGE ON SCHEMA auth TO auth_svc, media_svc, social_svc;
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

-- 3. social schema: USAGE and CRUD for social_svc
GRANT USAGE ON SCHEMA social TO social_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA social TO social_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA social TO social_svc;

ALTER DEFAULT PRIVILEGES FOR ROLE winkey_migrator IN SCHEMA social
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO social_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE winkey_migrator IN SCHEMA social
    GRANT USAGE, SELECT ON SEQUENCES TO social_svc;

-- 4. Cross-domain reads: media_svc and social_svc SELECT ONLY on auth.public_profiles (never auth.users)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'auth' AND viewname = 'public_profiles') THEN
        GRANT SELECT ON auth.public_profiles TO media_svc, social_svc;
    END IF;
END
$$;

-- 5. analytics schema: USAGE and SELECT on video_daily for media_svc (studio stats)
GRANT USAGE ON SCHEMA analytics TO media_svc;
GRANT SELECT ON analytics.video_daily TO media_svc;
-- ... and SELECT strictly on the recommendation tables (task R2, ADR-028)
GRANT SELECT ON analytics.video_coview, analytics.viewer_history TO media_svc;

-- 6. auth_svc needs SELECT on media.ready_images for avatar/banner validation (SOC-1b, ADR-049)
GRANT USAGE ON SCHEMA media TO auth_svc;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'media' AND viewname = 'ready_images') THEN
        GRANT SELECT ON media.ready_images TO auth_svc;
    END IF;
END
$$;
REVOKE ALL PRIVILEGES ON media.images FROM auth_svc;

-- 7. social_svc needs SELECT on media.ready_images for post images (SOC-2a, ADR-049)
GRANT USAGE ON SCHEMA media TO social_svc;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'media' AND viewname = 'ready_images') THEN
        GRANT SELECT ON media.ready_images TO social_svc;
    END IF;
END
$$;
REVOKE ALL PRIVILEGES ON media.images FROM social_svc;

-- 8. media_svc (storage-gc) needs SELECT on social.post_media to verify post images (SOC-2a, ADR-049)
GRANT USAGE ON SCHEMA social TO media_svc;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'social' AND tablename = 'post_media') THEN
        GRANT SELECT ON social.post_media TO media_svc;
    END IF;
END
$$;
REVOKE ALL PRIVILEGES ON social.posts FROM media_svc;

-- 9. chat schema: USAGE and CRUD for chat_svc (SOC-3a, ADR-049)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'chat') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA chat TO chat_svc';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA chat TO chat_svc';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA chat TO chat_svc';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE winkey_migrator IN SCHEMA chat GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chat_svc';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE winkey_migrator IN SCHEMA chat GRANT USAGE, SELECT ON SEQUENCES TO chat_svc';
    END IF;
END
$$;

-- chat_svc read grants across domains:
-- USAGE on auth + SELECT strictly on auth.public_profiles (never auth.users)
GRANT USAGE ON SCHEMA auth TO chat_svc;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'auth' AND viewname = 'public_profiles') THEN
        EXECUTE 'GRANT SELECT ON auth.public_profiles TO chat_svc';
    END IF;
END
$$;
REVOKE ALL PRIVILEGES ON auth.users FROM chat_svc;

-- USAGE on social + SELECT strictly on social.blocks and social.subscriptions (never social.posts)
GRANT USAGE ON SCHEMA social TO chat_svc;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'social' AND tablename = 'blocks') THEN
        EXECUTE 'GRANT SELECT ON social.blocks TO chat_svc';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'social' AND tablename = 'subscriptions') THEN
        EXECUTE 'GRANT SELECT ON social.subscriptions TO chat_svc';
    END IF;
END
$$;
REVOKE ALL PRIVILEGES ON social.posts FROM chat_svc;

-- Negative isolation: social_svc cannot read chat.messages
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'chat' AND tablename = 'messages') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON chat.messages FROM social_svc';
    END IF;
END
$$;


