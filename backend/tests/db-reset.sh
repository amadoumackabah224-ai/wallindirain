#!/usr/bin/env bash
# Recrée une base de test vierge et applique toutes les migrations.
# Variables : PGHOST, PGPORT, PGUSER (par défaut : serveur local de test)
set -euo pipefail
export PGHOST="${PGHOST:-/tmp/pgsock}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
DB="${1:-wld_test}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
psql -qX -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
for f in "$DIR"/migrations/*.sql; do
  echo "→ $(basename "$f")"
  psql -qX -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
