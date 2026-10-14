#!/bin/sh
# Sauvegarde complète de la base (format personnalisé pg_dump, compressé).
# Variables : PGHOST PGUSER PGPASSWORD PGDATABASE (standard PostgreSQL), BACKUP_DIR, BACKUP_KEEP_DAYS
set -eu
DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$DIR/.wallindirain-$STAMP.tmp"
OUT="$DIR/wallindirain-$STAMP.dump"
pg_dump --format=custom --no-owner --file="$TMP"
# vérification immédiate : le fichier doit être lisible par pg_restore
pg_restore --list "$TMP" >/dev/null
mv "$TMP" "$OUT"
echo "Sauvegarde créée : $OUT ($(wc -c < "$OUT") octets)"
# purge des anciennes sauvegardes
find "$DIR" -name 'wallindirain-*.dump' -type f -mtime +"$KEEP" -print -delete || true
