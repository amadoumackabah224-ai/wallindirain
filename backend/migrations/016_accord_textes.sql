-- =====================================================================
-- Migration 016 : accord sur les textes légaux par rôle.
-- Chaque personne accepte les textes de son rôle à sa première connexion, puis à chaque nouvelle version.
-- La preuve (qui, quand, quelle version) est ajoutée sans jamais être modifiée (table consents).
-- =====================================================================
ALTER TABLE consents DROP CONSTRAINT consents_kind_check;
ALTER TABLE consents ADD CONSTRAINT consents_kind_check CHECK (kind IN ('register','order','accept'));

-- état de l'accord d'une personne pour la version en vigueur
CREATE FUNCTION fn_legal_status(p_actor uuid, p_version text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'accepted_version', (SELECT c.version FROM consents c WHERE c.user_id = p_actor ORDER BY c.id DESC LIMIT 1),
    'accepted_at', (SELECT c.created_at FROM consents c WHERE c.user_id = p_actor ORDER BY c.id DESC LIMIT 1),
    'pending', NOT EXISTS (SELECT 1 FROM consents c WHERE c.user_id = p_actor AND c.version = p_version))
$$;

-- enregistre l'accord de la personne pour la version en vigueur (une seule fois par version)
CREATE FUNCTION fn_legal_accept(p_actor uuid, p_version text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL) THEN PERFORM _err('forbidden', 'Compte inactif'); END IF;
  IF EXISTS (SELECT 1 FROM consents WHERE user_id = p_actor AND version = p_version) THEN RETURN; END IF;
  PERFORM fn_record_consent('accept', p_actor, NULL, p_version);
END $$;

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
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash')
       AND NOT (r.relname IN ('proofs','avatars') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
