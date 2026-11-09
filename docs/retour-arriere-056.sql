-- Retour arrière de la migration 056 (devises). À appliquer avant celui de la 055.
-- Refuse s'il existe des devises ajoutées, des comptes dans une autre devise, ou le réglage de mise à jour automatique activé.
DO $$
DECLARE d text; n text;
BEGIN
  IF EXISTS (SELECT 1 FROM pf_currencies) OR EXISTS (SELECT 1 FROM pf_accounts WHERE currency <> 'GNF') OR EXISTS (SELECT 1 FROM pf_prefs WHERE rates_auto) THEN
    RAISE EXCEPTION 'retour arrière refusé : des devises ou des comptes en devise existent';
  END IF;
  d := pg_get_functiondef('fn_pf_wallet_link(uuid,uuid)'::regprocedure);
  n := replace(d, 'v_acc := _pf_account_save_base(p_actor, NULL, ''Mobile Money'', ''mobile_money'', ''orange'', 0);', 'v_acc := fn_pf_account_save(p_actor, NULL, ''Mobile Money'', ''mobile_money'', ''orange'', 0);');
  IF n = d THEN RAISE EXCEPTION 'fn_pf_wallet_link : texte inattendu'; END IF;
  EXECUTE n;
  d := pg_get_functiondef('fn_pf_transfer(uuid,uuid,uuid,bigint,text,date)'::regprocedure);
  n := replace(d, 'IF EXISTS (SELECT 1 FROM pf_accounts f JOIN pf_accounts t ON t.owner_id = f.owner_id WHERE f.id = p_from AND t.id = p_to AND f.owner_id = p_actor AND f.currency <> t.currency) THEN
    PERFORM _err(''invalid_input'', ''Un virement se fait entre deux comptes de la même devise'');
  END IF;', '');
  IF n = d THEN RAISE EXCEPTION 'fn_pf_transfer : texte inattendu'; END IF;
  EXECUTE n;
END $$;
DROP TRIGGER users_pf_zcur_anonymized ON users;
DROP FUNCTION trg_pf_cur_anonymized();
DROP FUNCTION fn_pf_rates_auto_set(uuid, boolean);
DROP FUNCTION fn_pf_currency_remove(uuid, text);
DROP FUNCTION fn_pf_currency_save(uuid, text, text, int, numeric);
DROP FUNCTION fn_pf_account_save(uuid, uuid, text, text, text, bigint, text);
ALTER FUNCTION _pf_account_save_base(uuid, uuid, text, text, text, bigint) RENAME TO fn_pf_account_save;
DROP VIEW pf_all_tx;
ALTER VIEW pf_all_tx_raw RENAME TO pf_all_tx;
ALTER TABLE pf_prefs DROP COLUMN rates_auto;
ALTER TABLE pf_accounts DROP COLUMN currency;
DROP TABLE pf_currencies;
DELETE FROM settings WHERE key = 'pf_free_currencies';

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

DELETE FROM schema_migrations WHERE name = '056_devises.sql';
