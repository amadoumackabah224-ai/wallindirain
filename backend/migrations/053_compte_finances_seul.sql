-- 053 : inscription « finances seulement » (rôle membre), fermée par défaut.
-- Un membre n'a ni commandes, ni portefeuille Wallindirain, ni retrait : seulement Mes finances (comptes, transactions, contacts, plan), gratuit ou Pro.
-- Réglage ajouté : pf_open_signup (0 = fermé). L'inscription n'est possible que si ce réglage ET « Mes finances » sont activés.
-- Aucune autre fonction modifiée que fn_register (un cas ajouté) et _pf_actor (rôle ajouté).

INSERT INTO settings(key, value, label) VALUES
  ('pf_open_signup', 0, 'Mes finances : inscription ouverte aux personnes qui veulent seulement gérer leur argent (1 = oui)');

DO $$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('fn_register(text,text,user_role,text,text,text,text,text)'::regprocedure);
  n := replace(d, 'IF p_role NOT IN (''seller'',''supplier'') THEN', 'IF p_role NOT IN (''seller'',''supplier'') AND NOT (p_role::text = ''member'' AND _setting(''pf_open_signup'') = 1 AND _setting(''feature_finances_perso'') = 1) THEN');
  IF n = d THEN RAISE EXCEPTION 'fn_register : texte inattendu'; END IF;
  EXECUTE n;
  d := pg_get_functiondef('_pf_actor(uuid)'::regprocedure);
  n := replace(d, '''courier'',''warehouse'']', '''courier'',''warehouse'',''member'']');
  IF n = d THEN RAISE EXCEPTION '_pf_actor : texte inattendu'; END IF;
  EXECUTE n;
END $$;

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
