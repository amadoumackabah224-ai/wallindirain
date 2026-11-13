-- Retour arrière de la migration 066 (alertes graves) : seules les fonctions et le réglage sont retirés. Les notifications déjà créées restent.
DROP FUNCTION IF EXISTS fn_run_ops_checks();
DROP FUNCTION IF EXISTS fn_ops_alert(text, text);
DELETE FROM settings WHERE key = 'ops_alerts';
DELETE FROM schema_migrations WHERE name = '066_alertes_graves.sql';
