-- 081 : période de grâce « Mes finances ». Avant de fixer le prix de la formule Pro, l'administrateur offre N jours de Pro à TOUS les utilisateurs
-- existants (sinon, dès qu'un prix est fixé, tous ceux dont l'essai de 14 jours est fini passeraient en gratuit d'un coup).
-- Ne touche à aucun argent : prolonge seulement la date d'essai ; ne raccourcit jamais un essai ou un abonnement déjà plus long.
-- Retour arrière : docs/retour-arriere-081.sql (supprime seulement la fonction).
CREATE FUNCTION fn_admin_pf_grace(p_actor uuid, p_days int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 90 THEN PERFORM _err('invalid_input', 'Durée : 1 à 90 jours'); END IF;
  -- ceux qui ont déjà utilisé Mes finances : essai prolongé jusqu'à maintenant + N jours (jamais raccourci)
  UPDATE pf_access SET trial_until = now() + make_interval(days => p_days)
   WHERE COALESCE(trial_until, '-infinity') < now() + make_interval(days => p_days)
     AND COALESCE(paid_until, '-infinity') < now() + make_interval(days => p_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM _audit(p_actor, 'pf_grace', 'setting', 'pf_grace', jsonb_build_object('days', p_days, 'users', v_n));
  RETURN v_n;
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
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'))
       AND NOT (r.relname = 'courier_vehicles' AND column_name IN ('plate_img','card_img'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

GRANT SELECT ON pf_all_tx TO wld_app;
