#!/bin/sh
# Test de restauration automatique (critère d'acceptation n°8) : sauvegarde la base, la restaure dans une base
# temporaire, compare les chiffres clés puis supprime la base temporaire. À lancer régulièrement (ex. chaque mois).
# Variables : PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE (base à tester)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="${PGDATABASE:?PGDATABASE requis}"
TMPDB="${DB}_restoretest_$$"
# dossier temporaire : ce test ne dépose jamais de fichier parmi les vraies sauvegardes
BACKUP_DIR="$(mktemp -d)"; export BACKUP_DIR
trap 'rm -rf "$BACKUP_DIR"' EXIT
sh "$HERE/backup.sh" >/dev/null
FILE="$(ls -t "$BACKUP_DIR"/wallindirain-*.dump | head -1)"
sh "$HERE/restore.sh" "$FILE" "$TMPDB" >/dev/null
Q="SELECT (SELECT count(*) FROM users)||'/'||(SELECT count(*) FROM orders)||'/'||(SELECT count(*) FROM wallet_entries)||'/'||(SELECT coalesce(sum(amount),0) FROM wallet_entries)||'/'||(SELECT count(*) FROM audit_log)"
A="$(psql -qAtX -d "$DB" -c "$Q")"
B="$(psql -qAtX -d "$TMPDB" -c "$Q")"
PROBLEMS="$(psql -qAtX -d "$TMPDB" -c "SELECT count(*) FROM fn_ledger_check()")"
dropdb --if-exists "$TMPDB"
if [ "$A" = "$B" ] && [ "$PROBLEMS" = "0" ]; then
  echo "OK : restauration identique (utilisateurs/commandes/mouvements/somme/journal = $B), 0 incohérence comptable"
else
  echo "ÉCHEC : original=$A restauré=$B incohérences=$PROBLEMS" >&2; exit 1
fi
