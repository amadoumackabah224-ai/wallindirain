-- Retour arrière de la migration 053 (inscription « finances seulement »). Refuse s'il existe des comptes membres. À appliquer avant celui de la 052.
DO $$
DECLARE d text; n text;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role::text = 'member') THEN RAISE EXCEPTION 'retour arrière refusé : des comptes membres existent'; END IF;
  d := pg_get_functiondef('fn_register(text,text,user_role,text,text,text,text,text)'::regprocedure);
  n := replace(d, 'IF p_role NOT IN (''seller'',''supplier'') AND NOT (p_role::text = ''member'' AND _setting(''pf_open_signup'') = 1 AND _setting(''feature_finances_perso'') = 1) THEN', 'IF p_role NOT IN (''seller'',''supplier'') THEN');
  IF n = d THEN RAISE EXCEPTION 'fn_register : texte inattendu'; END IF;
  EXECUTE n;
  d := pg_get_functiondef('_pf_actor(uuid)'::regprocedure);
  n := replace(d, '''courier'',''warehouse'',''member'']', '''courier'',''warehouse'']');
  IF n = d THEN RAISE EXCEPTION '_pf_actor : texte inattendu'; END IF;
  EXECUTE n;
END $$;
DELETE FROM settings WHERE key = 'pf_open_signup';

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

DELETE FROM schema_migrations WHERE name = '053_compte_finances_seul.sql';
