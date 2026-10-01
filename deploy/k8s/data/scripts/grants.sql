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

