#!/bin/bash
set -euo pipefail

MIGRATOR_USER="${MIGRATOR_USER:-winkey_migrator}"
MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:-winkey_migrator}"
AUTH_SVC_USER="${AUTH_SVC_USER:-auth_svc}"
AUTH_SVC_PASSWORD="${AUTH_SVC_PASSWORD:-auth_svc}"
MEDIA_SVC_USER="${MEDIA_SVC_USER:-media_svc}"
MEDIA_SVC_PASSWORD="${MEDIA_SVC_PASSWORD:-media_svc}"
SOCIAL_SVC_USER="${SOCIAL_SVC_USER:-social_svc}"
SOCIAL_SVC_PASSWORD="${SOCIAL_SVC_PASSWORD:-social_svc}"

echo "Initializing Winkey PostgreSQL roles..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
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
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${SOCIAL_SVC_USER}') THEN
            CREATE ROLE ${SOCIAL_SVC_USER} WITH LOGIN PASSWORD '${SOCIAL_SVC_PASSWORD}';
        END IF;
    END
    \$\$;

    -- Set winkey_migrator as database owner (migrations create schemas and tables)
    ALTER DATABASE winkey OWNER TO ${MIGRATOR_USER};
    GRANT ALL PRIVILEGES ON DATABASE winkey TO ${MIGRATOR_USER};
EOSQL

echo "Winkey PostgreSQL roles initialized successfully."
