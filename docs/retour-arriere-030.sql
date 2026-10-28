-- RETOUR ARRIÈRE de la migration 030 : le fournisseur doit de nouveau fournir sa pièce à l'inscription. Ne touche aucune donnée.
BEGIN;
CREATE OR REPLACE FUNCTION fn_register(p_phone text, p_name text, p_role user_role, p_password_hash text, p_identity_doc text,
                            p_payout_method text DEFAULT NULL, p_payout_phone text DEFAULT NULL, p_terms_version text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_doc text := NULLIF(trim(COALESCE(p_identity_doc, '')), '');
BEGIN
  IF p_role NOT IN ('seller','supplier') THEN
    PERFORM _err('invalid_role', 'Inscription ouverte aux vendeurs et fournisseurs uniquement');
  END IF;
  -- fournisseur : pièce obligatoire (validation du compte) ; vendeur : demandée plus tard, avant son premier retrait
  IF p_role = 'supplier' AND (v_doc IS NULL OR length(v_doc) < 4) THEN
    PERFORM _err('identity_required', 'La pièce d''identité est obligatoire pour un fournisseur');
  END IF;
  IF v_doc IS NOT NULL AND length(v_doc) < 4 THEN PERFORM _err('invalid_input', 'Pièce d''identité invalide'); END IF;
  IF (p_payout_method IS NULL) <> (p_payout_phone IS NULL) THEN
    PERFORM _err('invalid_input', 'Indiquez l''opérateur et le numéro de versement');
  END IF;
  BEGIN
    INSERT INTO users(role, status, full_name, phone, password_hash, identity_doc, payout_method, payout_phone)
    VALUES (p_role, CASE WHEN p_role = 'supplier' THEN 'pending'::user_status ELSE 'active'::user_status END,
            trim(p_name), p_phone, p_password_hash, v_doc, p_payout_method, p_payout_phone)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN PERFORM _err('phone_taken', 'Ce numéro est déjà inscrit');
    WHEN check_violation  THEN PERFORM _err('invalid_input', 'Nom, numéro ou numéro de versement invalide (9 chiffres attendus)');
  END;
  IF p_terms_version IS NOT NULL THEN PERFORM fn_record_consent('register', v_id, NULL, p_terms_version); END IF;
  PERFORM _audit(v_id, 'register', 'user', v_id::text, jsonb_build_object('role', p_role));
  RETURN v_id;
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
       AND NOT (r.relname IN ('proofs','avatars','product_images') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

DELETE FROM schema_migrations WHERE name = '030_fournisseur_sans_piece.sql';
COMMIT;
