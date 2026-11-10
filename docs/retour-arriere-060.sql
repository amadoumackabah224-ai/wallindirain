-- Retour arrière de la migration 060 (administrateur Pro, paie). Refuse s'il existe des employés.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pf_payroll) THEN RAISE EXCEPTION 'retour arrière refusé : des employés existent'; END IF;
END $$;
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('fn_pf_erase(uuid,text)'::regprocedure) INTO d;
  d := replace(d, 'DELETE FROM pf_payroll_pay WHERE owner_id = p_actor;' || E'\n  ', '');
  d := replace(d, 'DELETE FROM pf_payroll WHERE owner_id = p_actor;' || E'\n  ', '');
  EXECUTE d;
  SELECT pg_get_functiondef('_pf_tier(uuid)'::regprocedure) INTO d;
  EXECUTE replace(d, ' OR EXISTS (SELECT 1 FROM users u WHERE u.id = p_owner AND u.role = ''admin'')', '');
END $$;
DROP TRIGGER users_pf_payroll_anonymized ON users;
DROP FUNCTION trg_pf_payroll_anonymized();
DROP FUNCTION fn_pf_payroll_unpay(uuid, uuid, date);
DROP FUNCTION fn_pf_payroll_pay(uuid, uuid, date, uuid, bigint, date);
DROP FUNCTION fn_pf_payroll_archive(uuid, uuid, boolean);
DROP FUNCTION fn_pf_payroll_save(uuid, uuid, text, text, bigint, uuid);
DROP TABLE pf_payroll_pay;
DROP TABLE pf_payroll;
DELETE FROM schema_migrations WHERE name = '060_admin_paie.sql';
