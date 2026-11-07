-- Retour arrière de la migration 048 (Mes finances). Refuse s'il existe des comptes, des transactions, des abonnements ou si la fonction est allumée.
-- À appliquer avant celui de la 047.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pf_accounts) OR EXISTS (SELECT 1 FROM pf_transactions) OR EXISTS (SELECT 1 FROM pf_access) OR EXISTS (SELECT 1 FROM pf_prefs) THEN
    RAISE EXCEPTION 'retour arrière refusé : des données de Mes finances existent';
  END IF;
  IF _setting('feature_finances_perso') <> 0 THEN RAISE EXCEPTION 'retour arrière refusé : éteignez d''abord la fonction (feature_finances_perso = 0)'; END IF;
END $$;
DROP TRIGGER users_pf_anonymized ON users;
DROP FUNCTION trg_pf_user_anonymized();
DROP FUNCTION fn_admin_pf_grant(uuid, uuid, int, text);
DROP FUNCTION fn_pf_subscribe(uuid, text);
DROP FUNCTION fn_pf_prefs_set(uuid, bigint, bigint);
DROP FUNCTION fn_pf_transfer(uuid, uuid, uuid, bigint, text, date);
DROP FUNCTION fn_pf_tx_void(uuid, uuid);
DROP FUNCTION fn_pf_tx_update(uuid, uuid, uuid, bigint, text, text, date);
DROP FUNCTION fn_pf_tx_add(uuid, uuid, text, bigint, text, text, date);
DROP FUNCTION _pf_check_tx(uuid, uuid, text, bigint, text, text, date);
DROP FUNCTION fn_pf_account_archive(uuid, uuid, boolean);
DROP FUNCTION fn_pf_account_save(uuid, uuid, text, text, text, bigint);
DROP FUNCTION _pf_account_writable(uuid, uuid);
DROP FUNCTION _pf_touch(uuid);
DROP FUNCTION fn_pf_tier(uuid);
DROP FUNCTION _pf_tier(uuid);
DROP FUNCTION _pf_actor(uuid);
DROP FUNCTION _pf_feature_on();
DROP TABLE pf_prefs;
DROP TABLE pf_access;
DROP TABLE pf_transactions;
DROP TABLE pf_accounts;
DELETE FROM settings WHERE key IN ('feature_finances_perso','pf_price_monthly','pf_price_yearly','pf_trial_days','pf_free_accounts','pf_free_history_days');

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

DELETE FROM schema_migrations WHERE name = '048_finances_perso.sql';
