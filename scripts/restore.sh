#!/usr/bin/env bash
# Restore a backup into an EMPTY database and verify it (docs/OPERATIONS.md).
# Usage: pnpm db:restore <file.dump> <target-database-url>
# Refuses a target that already has tables, so a live database is never overwritten.
set -euo pipefail
cd "$(dirname "$0")/.."
DUMP="${1:?usage: restore.sh <file.dump> <target-database-url>}"
TARGET="${2:?usage: restore.sh <file.dump> <target-database-url>}"
URL="${TARGET%%\?*}"
if [[ -f "$DUMP.sha256" ]]; then
  (cd "$(dirname "$DUMP")" && sha256sum --check --quiet "$(basename "$DUMP").sha256")
  echo "Checksum OK"
else
  echo "No checksum file next to the dump; refusing to restore an unverified file." >&2
  exit 1
fi
TABLES="$(psql "$URL" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if [[ "$TABLES" != "0" ]]; then
  echo "Target database is not empty ($TABLES tables); restore only into a new, empty database." >&2
  exit 1
fi
# Roles live outside the dump: recreate the tenant role the grants refer to.
psql "$URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fa_tenant') THEN
    CREATE ROLE fa_tenant NOLOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
GRANT fa_tenant TO CURRENT_USER;
SQL
pg_restore --no-owner --exit-on-error --single-transaction --dbname="$URL" "$DUMP"
echo "Restored. Verifying…"
DATABASE_URL="$TARGET" pnpm -s db:verify
