-- RETOUR ARRIÈRE de la migration 028 (alertes automatiques). JAMAIS AUTOMATIQUE.
-- Aucune donnée financière : retire la fonction, la colonne anti-doublon et les 3 réglages d'alerte. Les notifications déjà envoyées restent.
-- Retirer aussi le code serveur qui appelle fn_run_alerts().
BEGIN;
DROP FUNCTION fn_run_alerts();
DROP FUNCTION _notify_once(uuid, text, text, text, text, text);
DROP INDEX notifications_dedupe_uq;
ALTER TABLE notifications DROP COLUMN dedupe_key;
DELETE FROM settings WHERE key IN ('alert_low_stock_qty', 'alert_cash_hours', 'alert_payout_days');
DELETE FROM schema_migrations WHERE name = '028_alertes.sql';
COMMIT;
