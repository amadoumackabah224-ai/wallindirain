#!/bin/sh
# Restaure une sauvegarde dans une base NEUVE (même sur un serveur PostgreSQL vierge).
# Usage : restore.sh fichier.dump nom_de_la_base
# Variables : PGHOST PGPORT PGUSER PGPASSWORD (compte propriétaire)
# ATTENTION : ne restaurez jamais par-dessus la base en service (voir docs/INSTALLATION.md, « Restauration »).
set -eu
FILE="${1:?Usage : restore.sh fichier.dump nom_de_base}"
DB="${2:?Usage : restore.sh fichier.dump nom_de_base}"
pg_restore --list "$FILE" >/dev/null
# le rôle applicatif est propre au serveur (pas à la base) : il doit exister avant les droits restaurés
psql -qAtX -v ON_ERROR_STOP=1 -d postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wld_app') THEN CREATE ROLE wld_app NOLOGIN; END IF; END \$\$"
createdb "$DB"
pg_restore --no-owner --exit-on-error --dbname="$DB" "$FILE"
echo "Restauration terminée dans la base : $DB"
echo "Étape suivante : définir le mot de passe du compte applicatif avec « node src/migrate.js » (DB_APP_PASSWORD)."
