-- Retour arrière de la migration 049 (Plan financier). Refuse s'il existe des budgets, objectifs ou récurrents. À appliquer avant celui de la 048.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pf_budgets) OR EXISTS (SELECT 1 FROM pf_goals) OR EXISTS (SELECT 1 FROM pf_recurring) THEN
    RAISE EXCEPTION 'retour arrière refusé : des données du Plan financier existent';
  END IF;
END $$;
DROP TRIGGER users_pf_plan_anonymized ON users;
DROP FUNCTION trg_pf_plan_anonymized();
DROP FUNCTION fn_pf_recurring_stop(uuid, uuid);
DROP FUNCTION fn_pf_recurring_save(uuid, uuid, text, text, text, bigint, text, date);
DROP FUNCTION fn_pf_goal_set(uuid, bigint);
DROP FUNCTION fn_pf_budget_set(uuid, text, bigint);
DROP FUNCTION _pf_pro(uuid);
DROP TABLE pf_recurring;
DROP TABLE pf_goals;
DROP TABLE pf_budgets;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
DO $$
DECLARE r record; v_cols text;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE '\_%' OR p.proname LIKE 'fn\_%' OR p.proname = 'trg_orders_frozen') LOOP
    IF r.proname <> 'trg_orders_frozen' THEN
      EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public, pg_temp', r.sig);
      IF r.proname LIKE 'fn\_%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wld_app', r.sig); END IF;
    END IF;
  END LOOP;

  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions','order_requests') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash')
       AND NOT (r.relname IN ('proofs','avatars','product_images','return_photos','invoices') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

DELETE FROM schema_migrations WHERE name = '049_plan_financier.sql';
