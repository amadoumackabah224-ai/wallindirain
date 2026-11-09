-- Retour arrière de la migration 054 (profil et catégories modifiables). À appliquer avant celui de la 053.
-- Refuse s'il existe des catégories ajoutées, des profils choisis, ou des écritures/budgets/paiements planifiés utilisant une catégorie de l'arbre.
DO $$
DECLARE d text; n text;
BEGIN
  IF EXISTS (SELECT 1 FROM pf_cat_custom) OR EXISTS (SELECT 1 FROM pf_cat_override) OR EXISTS (SELECT 1 FROM pf_prefs WHERE profile IS NOT NULL) THEN
    RAISE EXCEPTION 'retour arrière refusé : des catégories ou profils personnalisés existent';
  END IF;
  IF EXISTS (SELECT 1 FROM pf_transactions WHERE category NOT IN ('sales','salary','gift','other_in','food','transport','housing','telecom','health','family','business','shopping','savings','other_out','transfer'))
     OR EXISTS (SELECT 1 FROM pf_recurring WHERE category NOT IN ('sales','salary','gift','other_in','food','transport','housing','telecom','health','family','business','shopping','savings','other_out'))
     OR EXISTS (SELECT 1 FROM pf_budgets WHERE category NOT IN ('food','transport','housing','telecom','health','family','business','shopping','savings','other_out')) THEN
    RAISE EXCEPTION 'retour arrière refusé : des données utilisent les nouvelles catégories';
  END IF;
  d := pg_get_functiondef('_pf_check_tx(uuid,uuid,text,bigint,text,text,date)'::regprocedure);
  n := replace(d, 'IF p_kind = ''income'' AND NOT _pf_cat_ok(p_actor, ''income'', p_category) THEN', 'IF p_kind = ''income'' AND p_category NOT IN (''sales'',''salary'',''gift'',''other_in'') THEN');
  n := replace(n, 'IF p_kind = ''expense'' AND NOT _pf_cat_ok(p_actor, ''expense'', p_category) THEN', 'IF p_kind = ''expense'' AND p_category NOT IN (''food'',''transport'',''housing'',''telecom'',''health'',''family'',''business'',''shopping'',''savings'',''other_out'') THEN');
  IF n = d THEN RAISE EXCEPTION '_pf_check_tx : texte inattendu'; END IF;
  EXECUTE n;
  d := pg_get_functiondef('fn_pf_recurring_save(uuid,uuid,text,text,text,bigint,text,date)'::regprocedure);
  n := replace(d, 'IF p_kind = ''income'' AND NOT _pf_cat_ok(p_actor, ''income'', p_category) THEN', 'IF p_kind = ''income'' AND p_category NOT IN (''sales'',''salary'',''gift'',''other_in'') THEN');
  n := replace(n, 'IF p_kind = ''expense'' AND NOT _pf_cat_ok(p_actor, ''expense'', p_category) THEN', 'IF p_kind = ''expense'' AND p_category NOT IN (''food'',''transport'',''housing'',''telecom'',''health'',''family'',''business'',''shopping'',''savings'',''other_out'') THEN');
  IF n = d THEN RAISE EXCEPTION 'fn_pf_recurring_save : texte inattendu'; END IF;
  EXECUTE n;
  d := pg_get_functiondef('fn_pf_budget_set(uuid,text,bigint)'::regprocedure);
  n := replace(d, 'IF NOT _pf_cat_ok(p_actor, ''expense'', p_category) THEN', 'IF p_category NOT IN (''food'',''transport'',''housing'',''telecom'',''health'',''family'',''business'',''shopping'',''savings'',''other_out'') THEN');
  IF n = d THEN RAISE EXCEPTION 'fn_pf_budget_set : texte inattendu'; END IF;
  EXECUTE n;
END $$;
ALTER TABLE pf_budgets ADD CONSTRAINT pf_budgets_category_check CHECK (category IN ('food','transport','housing','telecom','health','family','business','shopping','savings','other_out'));
DROP TRIGGER users_pf_cat_anonymized ON users;
DROP FUNCTION trg_pf_cat_anonymized();
DROP FUNCTION fn_pf_cat_edit(uuid, text, text, text, boolean);
DROP FUNCTION fn_pf_cat_add(uuid, text, text, text, text);
DROP FUNCTION fn_pf_profile_set(uuid, text);
DROP FUNCTION _pf_cat_ok(uuid, text, text);
ALTER TABLE pf_prefs DROP COLUMN profile;
DROP TABLE pf_cat_override;
DROP TABLE pf_cat_custom;
DROP TABLE pf_cat_system;
DELETE FROM settings WHERE key = 'pf_free_categories';

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

DELETE FROM schema_migrations WHERE name = '054_categories.sql';
