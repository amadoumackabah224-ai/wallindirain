-- Retour arrière de la migration 075 (pilotage). À jouer en tant que propriétaire de la base.
-- Refuse si des rapports financiers sont déjà archivés (rien n'est perdu) : exportez-les d'abord.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM company_reports) THEN RAISE EXCEPTION 'Retour arrière refusé : des rapports financiers sont archivés. Rien n''a été supprimé.'; END IF;
END $$;
DROP FUNCTION IF EXISTS fn_withdrawal_dossier(uuid, uuid);
DROP FUNCTION IF EXISTS fn_order_dossier(uuid, uuid);
DROP FUNCTION IF EXISTS fn_performance(uuid, date, date);
DROP FUNCTION IF EXISTS fn_admin_debts(uuid);
DROP FUNCTION IF EXISTS fn_admin_report_make(uuid, text, date);
DROP FUNCTION IF EXISTS fn_admin_reports(uuid, text);
DROP FUNCTION IF EXISTS fn_run_reports();
DROP FUNCTION IF EXISTS _report_make(text, date, date, uuid);
DROP FUNCTION IF EXISTS _report_data(date, date);
DROP FUNCTION IF EXISTS fn_product_history(uuid, uuid);
DROP FUNCTION IF EXISTS fn_today(uuid);
DROP FUNCTION IF EXISTS fn_run_anomaly_checks();
DROP FUNCTION IF EXISTS fn_accounting_anomalies(uuid);
DROP FUNCTION IF EXISTS _anomaly_list();
DROP TABLE IF EXISTS company_reports;
DELETE FROM settings WHERE key = 'auto_reports';
DELETE FROM schema_migrations WHERE name = '075_pilotage.sql';
COMMIT;
