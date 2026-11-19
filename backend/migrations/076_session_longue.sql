-- 076 : session longue. Une personne reste connectée tant qu'elle ne se déconnecte pas et qu'elle revient régulièrement :
-- la session se prolonge à chaque utilisation (30 jours d'inactivité pour tous, 7 jours pour l'administration, qui manipule l'argent).
-- Rien d'autre ne change : mêmes jetons opaques, même cookie HttpOnly, la déconnexion et le changement de mot de passe révoquent toujours la session.
CREATE OR REPLACE FUNCTION _session_ttl(p_user uuid) RETURNS interval LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN (SELECT role FROM users WHERE id = p_user) = 'admin' THEN interval '7 days' ELSE interval '30 days' END
$$;

CREATE OR REPLACE FUNCTION fn_session_create(p_user uuid, p_token_hash text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE v_exp timestamptz := now() + _session_ttl(p_user);
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
  INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (p_token_hash, p_user, v_exp);
  RETURN v_exp;
END $$;

-- Prolonge une session valide (au plus une fois par heure). Renvoie la nouvelle échéance, ou NULL si rien n'a été prolongé.
CREATE FUNCTION fn_session_touch(p_token_hash text) RETURNS timestamptz LANGUAGE sql AS $$
  UPDATE sessions SET expires_at = now() + _session_ttl(user_id)
   WHERE token_hash = p_token_hash AND expires_at > now() AND expires_at < now() + _session_ttl(user_id) - interval '1 hour'
  RETURNING expires_at
$$;

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
