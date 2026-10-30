-- Idempotent grants for Winkey service roles based on db/README.md

-- 1. auth_svc: USAGE on auth, CRUD on all auth.* tables & sequences
GRANT USAGE ON SCHEMA auth TO auth_svc;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO auth_svc;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO auth_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL PRIVILEGES ON TABLES TO auth_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL PRIVILEGES ON SEQUENCES TO auth_svc;

-- 2. media_svc: USAGE on media, CRUD on all media.* tables & sequences
-- USAGE on auth + SELECT strictly on auth.public_profiles (never auth.users)
GRANT USAGE ON SCHEMA media TO media_svc;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA media TO media_svc;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA media TO media_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA media GRANT ALL PRIVILEGES ON TABLES TO media_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA media GRANT ALL PRIVILEGES ON SEQUENCES TO media_svc;

GRANT USAGE ON SCHEMA auth TO media_svc;
GRANT SELECT ON auth.public_profiles TO media_svc;
REVOKE ALL PRIVILEGES ON auth.users FROM media_svc;

-- media_svc additionally needs: USAGE on analytics, SELECT strictly on analytics.video_daily (task R1-b)
GRANT USAGE ON SCHEMA analytics TO media_svc;
GRANT SELECT ON analytics.video_daily TO media_svc;
-- ... and SELECT strictly on the recommendation tables (task R2, ADR-028)
GRANT SELECT ON analytics.video_coview, analytics.viewer_history TO media_svc;

-- 3. social_svc: USAGE on social, CRUD on all social.* tables & sequences
-- USAGE on auth + SELECT strictly on auth.public_profiles (never auth.users)
GRANT USAGE ON SCHEMA social TO social_svc;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA social TO social_svc;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA social TO social_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA social GRANT ALL PRIVILEGES ON TABLES TO social_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA social GRANT ALL PRIVILEGES ON SEQUENCES TO social_svc;

GRANT USAGE ON SCHEMA auth TO social_svc;
GRANT SELECT ON auth.public_profiles TO social_svc;
REVOKE ALL PRIVILEGES ON auth.users FROM social_svc;

-- 4. analytics_svc: USAGE on analytics, CRUD and default privileges on analytics.*, no other privileges (task R1-b)
GRANT USAGE ON SCHEMA analytics TO analytics_svc;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA analytics TO analytics_svc;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA analytics TO analytics_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT ALL PRIVILEGES ON TABLES TO analytics_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT ALL PRIVILEGES ON SEQUENCES TO analytics_svc;

-- 5. Cross-domain read for auth_svc: USAGE on media + SELECT strictly on media.ready_images (SOC-1b, ADR-049)
GRANT USAGE ON SCHEMA media TO auth_svc;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'media' AND viewname = 'ready_images') THEN
        GRANT SELECT ON media.ready_images TO auth_svc;
    END IF;
END
$$;
REVOKE ALL PRIVILEGES ON media.images FROM auth_svc;

-- 6. Cross-domain read for social_svc: USAGE on media + SELECT strictly on media.ready_images (SOC-2a, ADR-049)
GRANT USAGE ON SCHEMA media TO social_svc;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'media' AND viewname = 'ready_images') THEN
        GRANT SELECT ON media.ready_images TO social_svc;
    END IF;
END
$$;
REVOKE ALL PRIVILEGES ON media.images FROM social_svc;

-- 7. Cross-domain read for media_svc (storage-gc): USAGE on social + SELECT strictly on social.post_media (SOC-2a, ADR-049)
GRANT USAGE ON SCHEMA social TO media_svc;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'social' AND tablename = 'post_media') THEN
        GRANT SELECT ON social.post_media TO media_svc;
    END IF;
END
$$;
REVOKE ALL PRIVILEGES ON social.posts FROM media_svc;

-- 8. chat_svc: USAGE on chat, CRUD on all chat.* tables & sequences (SOC-3a, ADR-049)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'chat') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA chat TO chat_svc';
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA chat TO chat_svc';
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA chat TO chat_svc';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA chat GRANT ALL PRIVILEGES ON TABLES TO chat_svc';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA chat GRANT ALL PRIVILEGES ON SEQUENCES TO chat_svc';
    END IF;
END
$$;

-- chat_svc read grants across domains:
-- USAGE on auth + SELECT strictly on auth.public_profiles (never auth.users)
GRANT USAGE ON SCHEMA auth TO chat_svc;
GRANT SELECT ON auth.public_profiles TO chat_svc;
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



