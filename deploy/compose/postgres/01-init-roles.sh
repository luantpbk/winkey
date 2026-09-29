#!/bin/bash
set -euo pipefail

MIGRATOR_USER="${MIGRATOR_USER:-winkey_migrator}"
MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:-winkey_migrator}"
AUTH_SVC_USER="${AUTH_SVC_USER:-auth_svc}"
AUTH_SVC_PASSWORD="${AUTH_SVC_PASSWORD:-auth_svc}"
MEDIA_SVC_USER="${MEDIA_SVC_USER:-media_svc}"
MEDIA_SVC_PASSWORD="${MEDIA_SVC_PASSWORD:-media_svc}"

echo "Initializing Winkey PostgreSQL roles..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- 1. Create database roles if not existing
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${MIGRATOR_USER}') THEN
            CREATE ROLE ${MIGRATOR_USER} WITH LOGIN PASSWORD '${MIGRATOR_PASSWORD}';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${AUTH_SVC_USER}') THEN
            CREATE ROLE ${AUTH_SVC_USER} WITH LOGIN PASSWORD '${AUTH_SVC_PASSWORD}';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${MEDIA_SVC_USER}') THEN
            CREATE ROLE ${MEDIA_SVC_USER} WITH LOGIN PASSWORD '${MEDIA_SVC_PASSWORD}';
        END IF;
    END
    \$\$;

    -- 2. Make winkey_migrator the database owner
    ALTER DATABASE winkey OWNER TO ${MIGRATOR_USER};
    GRANT ALL PRIVILEGES ON DATABASE winkey TO ${MIGRATOR_USER};

    -- 3. Connect to winkey and configure initial schemas and default privileges
    \c winkey

    CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION ${MIGRATOR_USER};
    CREATE SCHEMA IF NOT EXISTS media AUTHORIZATION ${MIGRATOR_USER};

    -- Permissions for auth_svc per db/README.md: USAGE on auth; CRUD on auth.*
    GRANT USAGE ON SCHEMA auth TO ${AUTH_SVC_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_USER} IN SCHEMA auth
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${AUTH_SVC_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_USER} IN SCHEMA auth
        GRANT USAGE, SELECT ON SEQUENCES TO ${AUTH_SVC_USER};

    -- Permissions for media_svc per db/README.md: USAGE on media; CRUD on media.*; USAGE on auth + SELECT only on auth.public_profiles
    GRANT USAGE ON SCHEMA media TO ${MEDIA_SVC_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_USER} IN SCHEMA media
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${MEDIA_SVC_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_USER} IN SCHEMA media
        GRANT USAGE, SELECT ON SEQUENCES TO ${MEDIA_SVC_USER};

    GRANT USAGE ON SCHEMA auth TO ${MEDIA_SVC_USER};

    -- Event trigger: whenever public_profiles view is created or updated by migrations, automatically grant SELECT to media_svc
    CREATE OR REPLACE FUNCTION public.grant_media_svc_public_profiles()
    RETURNS event_trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS \$\$
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'auth' AND viewname = 'public_profiles') THEN
            EXECUTE 'GRANT SELECT ON auth.public_profiles TO ${MEDIA_SVC_USER}';
        END IF;
    END;
    \$\$;

    DROP EVENT TRIGGER IF EXISTS trg_grant_media_svc_public_profiles;
    CREATE EVENT TRIGGER trg_grant_media_svc_public_profiles
        ON ddl_command_end
        EXECUTE FUNCTION public.grant_media_svc_public_profiles();
EOSQL

echo "Winkey PostgreSQL roles initialized successfully."
