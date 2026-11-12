-- Retour arrière de la migration 065 (comptabilité de la société) : lecture seule, rien à restaurer.
DROP FUNCTION IF EXISTS fn_admin_accounting(uuid, date, date, uuid[]);
DROP FUNCTION IF EXISTS _acc_label(text);
DELETE FROM schema_migrations WHERE name = '065_comptabilite_societe.sql';
