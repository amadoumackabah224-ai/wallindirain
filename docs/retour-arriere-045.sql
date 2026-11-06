-- Retour arrière de la migration 045 (tableau argent : dépenses récurrentes, budget, objectif, réglage de prévision).
-- Refuse s'il existe des données de finances (sinon elles seraient perdues). Le réglage feature_finances doit être éteint (0).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM finance_recurring) OR EXISTS (SELECT 1 FROM finance_budgets) OR EXISTS (SELECT 1 FROM finance_goals) OR EXISTS (SELECT 1 FROM finance_prefs) THEN
    RAISE EXCEPTION 'retour arrière refusé : des données de finances existent (dépenses récurrentes, budgets, objectifs ou réglages)';
  END IF;
  IF COALESCE((SELECT value FROM settings WHERE key = 'feature_finances'), 0) <> 0 THEN
    RAISE EXCEPTION 'retour arrière refusé : éteignez d''abord la fonction (réglage feature_finances = 0)';
  END IF;
END $$;
DROP TRIGGER users_finances_anonymized ON users;
DROP FUNCTION trg_finances_user_anonymized();
DROP FUNCTION fn_seller_finance_rate_set(uuid, int);
DROP FUNCTION fn_seller_finance_goal_set(uuid, bigint);
DROP FUNCTION fn_seller_finance_budget_set(uuid, text, bigint);
DROP FUNCTION fn_seller_finance_recurring_stop(uuid, uuid);
DROP FUNCTION fn_seller_finance_recurring_save(uuid, uuid, text, text, bigint, text, date);
DROP FUNCTION _finance_feature_on();
DROP TABLE finance_prefs;
DROP TABLE finance_goals;
DROP TABLE finance_budgets;
DROP TABLE finance_recurring;
DELETE FROM settings WHERE key = 'feature_finances';

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

DELETE FROM schema_migrations WHERE name = '045_finances.sql';
