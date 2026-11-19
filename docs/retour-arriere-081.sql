-- Retour arrière de la 081 : supprime seulement la fonction (les dates d'essai déjà prolongées restent, sans effet sur l'argent).
BEGIN;
DROP FUNCTION IF EXISTS fn_admin_pf_grace(uuid, int);
DELETE FROM schema_migrations WHERE name = '081_pf_periode_grace.sql';
COMMIT;
