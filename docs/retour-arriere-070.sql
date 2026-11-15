-- Retour arrière de la migration 070. Refusé s'il existe des comptes expéditeur ou des demandes d'envoi (aucune donnée n'est supprimée).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dlv_requests) OR EXISTS (SELECT 1 FROM users WHERE role::text = 'shipper') THEN
    RAISE EXCEPTION 'Des expéditeurs ou des demandes existent : le retour arrière 070 est refusé pour ne rien perdre';
  END IF;
END $$;
DO $$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('fn_register(text,text,user_role,text,text,text,text,text)'::regprocedure);
  n := replace(d, ' AND NOT (p_role::text = ''shipper'' AND _setting(''dlv_open_signup'') = 1 AND _setting(''feature_livraison_demande'') = 1)', '');
  IF n <> d THEN EXECUTE n; END IF;
END $$;
DROP FUNCTION IF EXISTS fn_admin_dlv_requests(uuid, text);
DROP FUNCTION IF EXISTS fn_dlv_request_cancel(uuid, uuid);
DROP FUNCTION IF EXISTS fn_dlv_my_requests(uuid);
DROP FUNCTION IF EXISTS fn_dlv_request_create(uuid, text, text, text, text, text, text, text, numeric, bigint, text, boolean);
DROP FUNCTION IF EXISTS _dlv_ref();
DROP TABLE IF EXISTS dlv_requests;
DELETE FROM settings WHERE key IN ('dlv_open_signup', 'dlv_daily_limit', 'dlv_max_declared');
DELETE FROM schema_migrations WHERE name = '070_livraison_demandes.sql';
