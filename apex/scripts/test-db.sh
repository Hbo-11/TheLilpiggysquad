#!/usr/bin/env bash
# Creates a throwaway Postgres database with a Supabase-like auth stub, applies the
# migrations, and runs the server + database tests against it.
#
# Uses APEX_TEST_DATABASE_ADMIN_URL if set (any Postgres 15+ superuser connection),
# otherwise starts the local Debian/Ubuntu "16/main" cluster if available.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${APEX_TEST_DB_NAME:-apex_notifications_test}"

if [[ -z "${APEX_TEST_DATABASE_ADMIN_URL:-}" ]]; then
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_lsclusters | grep -q online || pg_ctlcluster 16 main start
    su postgres -c "psql -qtc \"select 1 from pg_roles where rolname='apex_test'\"" | grep -q 1 ||
      su postgres -c "psql -qc \"create role apex_test login superuser password 'apex_test'\""
    APEX_TEST_DATABASE_ADMIN_URL="postgres://apex_test:apex_test@localhost:5432/postgres"
  else
    echo "Set APEX_TEST_DATABASE_ADMIN_URL to a Postgres superuser connection string." >&2
    exit 1
  fi
fi

psql "$APEX_TEST_DATABASE_ADMIN_URL" -qv ON_ERROR_STOP=1 -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME"
TEST_URL="${APEX_TEST_DATABASE_ADMIN_URL%/*}/$DB_NAME"
psql "$TEST_URL" -qv ON_ERROR_STOP=1 -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do
  echo "Applying $f"
  psql "$TEST_URL" -qv ON_ERROR_STOP=1 -f "$f"
done

export APEX_TEST_DATABASE_URL="$TEST_URL"
npm run --silent test:server
