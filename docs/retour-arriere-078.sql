-- Retour arrière de la 078 (proformas). Refusé s'il existe des proformas : rien n'est supprimé.
BEGIN;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM proformas) THEN RAISE EXCEPTION 'Retour arrière refusé : des proformas existent. Rien n''a été supprimé.'; END IF; END $$;
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('fn_admin_reset_activity(uuid,text)'::regprocedure);
  EXECUTE replace(d, 'TRUNCATE TABLE proformas, dlv_requests,', 'TRUNCATE TABLE dlv_requests,');
END $$;
DROP FUNCTION IF EXISTS fn_admin_proformas(uuid);
DROP FUNCTION IF EXISTS fn_proforma_convert(uuid, uuid);
DROP FUNCTION IF EXISTS fn_proforma_cancel(uuid, uuid);
DROP FUNCTION IF EXISTS fn_proformas_mine(uuid);
DROP FUNCTION IF EXISTS fn_proforma_create(uuid, uuid, bigint, int, text, text, text, text, text, int);
DROP FUNCTION IF EXISTS _proforma_json(proformas);
DROP TABLE IF EXISTS proformas;
DROP SEQUENCE IF EXISTS proforma_seq;
DELETE FROM settings WHERE key = 'feature_proformas';
DELETE FROM schema_migrations WHERE name = '078_proformas.sql';
COMMIT;
