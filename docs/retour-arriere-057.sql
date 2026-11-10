-- Retour arrière de la migration 057 (espaces de groupe). À appliquer avant celui de la 056.
-- Refuse s'il existe des espaces.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pf_spaces) THEN RAISE EXCEPTION 'retour arrière refusé : des espaces de groupe existent'; END IF;
END $$;
DROP TRIGGER users_pf_space_anonymized ON users;
DROP FUNCTION trg_pf_space_anonymized();
DROP FUNCTION fn_pf_space_transfer(uuid, uuid, uuid, uuid, bigint, text, date);
DROP FUNCTION fn_pf_space_tx_void(uuid, uuid, uuid);
DROP FUNCTION fn_pf_space_tx_update(uuid, uuid, uuid, uuid, bigint, text, text, date);
DROP FUNCTION fn_pf_space_tx_add(uuid, uuid, uuid, text, bigint, text, text, date);
DROP FUNCTION fn_pf_space_account_archive(uuid, uuid, uuid, boolean);
DROP FUNCTION fn_pf_space_account_save(uuid, uuid, uuid, text, text, text, bigint);
DROP FUNCTION fn_pf_space_leave(uuid, uuid);
DROP FUNCTION fn_pf_space_remove(uuid, uuid, uuid);
DROP FUNCTION fn_pf_space_set_role(uuid, uuid, uuid, text);
DROP FUNCTION fn_pf_space_respond(uuid, uuid, boolean);
DROP FUNCTION fn_pf_space_invite(uuid, uuid, text, text);
DROP FUNCTION fn_pf_space_archive(uuid, uuid, boolean);
DROP FUNCTION fn_pf_space_rename(uuid, uuid, text);
DROP FUNCTION fn_pf_space_create(uuid, text);
DROP FUNCTION _space_check_tx(uuid, uuid, text, bigint, text, text, date);
DROP FUNCTION _space_log(uuid, uuid, text, text);
DROP FUNCTION _space_need(uuid, uuid, text[], boolean);
DROP FUNCTION _space_on();
DROP TABLE pf_space_log;
DROP TABLE pf_space_tx;
DROP TABLE pf_space_accounts;
DROP TABLE pf_space_members;
DROP TABLE pf_spaces;
DELETE FROM settings WHERE key IN ('pf_spaces', 'pf_space_max_spaces', 'pf_space_max_members');

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

GRANT SELECT ON pf_all_tx TO wld_app;

DELETE FROM schema_migrations WHERE name = '057_espaces_groupe.sql';
