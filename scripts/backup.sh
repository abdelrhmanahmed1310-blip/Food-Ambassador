#!/usr/bin/env bash
# Back up the database to a compressed custom-format dump with a SHA-256
# checksum (docs/OPERATIONS.md). Usage: pnpm db:backup [output-directory]
# Reads DATABASE_URL from the environment or .env. Never prints credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"')"
fi
: "${DATABASE_URL:?DATABASE_URL is not set}"
URL="${DATABASE_URL%%\?*}" # pg_dump does not accept Prisma's ?schema= parameter
OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/food-ambassador-$STAMP.dump"
pg_dump --format=custom --compress=9 --no-owner --file="$FILE" "$URL"
(cd "$OUT_DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256")
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1)), checksum in $FILE.sha256"
