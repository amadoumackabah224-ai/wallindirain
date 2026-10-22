-- Migration 011 : confidentialité du personnel (la personne ne voit plus qui a consulté ses photos).

-- Confidentialité de l'administration : la personne ne voit plus QUI a consulté ses photos (cela exposait le personnel).
-- La trace reste enregistrée dans le journal d'audit, visible des administrateurs seulement.
CREATE OR REPLACE FUNCTION fn_my_identity(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; d identity_documents;
BEGIN
  u := _kyc_user(p_actor);
  SELECT * INTO d FROM identity_documents WHERE user_id = p_actor;
  RETURN jsonb_build_object(
    'verified', u.identity_verified, 'doc_number', u.identity_doc,
    'status', CASE WHEN u.identity_verified THEN 'verified' ELSE COALESCE(d.status, 'none') END,
    'doc_type', COALESCE(d.doc_type, 'cni'),
    'has_front', d.front IS NOT NULL, 'has_back', d.back IS NOT NULL, 'has_selfie', d.selfie IS NOT NULL,
    'reject_reason', d.reject_reason, 'submitted_at', d.submitted_at, 'decided_at', d.decided_at);
END $$;

-- ---------- Droits (mêmes règles que les migrations précédentes) ----------
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
