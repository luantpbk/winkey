#!/usr/bin/env bash
# Verifies migrations are reversible and runs SQL tests.
# Usage: DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=disable scripts/db-test.sh
# Requires: psql, migrate (github.com/golang-migrate/migrate/v4/cmd/migrate, built with -tags postgres).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
root="$(cd "$(dirname "$0")/.." && pwd)"
migrations="$root/db/migrations"

echo "== up";        migrate -path "$migrations" -database "$DATABASE_URL" up
echo "== down all";  migrate -path "$migrations" -database "$DATABASE_URL" down -all
leftover="$(psql "$DATABASE_URL" -Atc "select count(*) from pg_namespace where nspname in ('auth','media')")"
[ "$leftover" = "0" ] || { echo "down migrations left schemas behind"; exit 1; }
echo "== up again";  migrate -path "$migrations" -database "$DATABASE_URL" up

for t in "$root"/db/tests/*.sql; do
  echo "== test $(basename "$t")"
  # Each test runs in one transaction that is rolled back, so tests never see each other's rows.
  { echo "BEGIN;"; cat "$t"; echo "ROLLBACK;"; } | psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f -
done
echo "all database tests passed"
