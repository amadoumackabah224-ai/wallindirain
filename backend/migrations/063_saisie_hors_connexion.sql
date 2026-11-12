-- =====================================================================
-- Migration 063 : saisie hors connexion (Mes finances et Boutique).
-- Une opération saisie sans réseau est gardée sur le téléphone puis envoyée au retour du réseau avec une clé unique :
-- si l'envoi est répété (coupure au mauvais moment), le serveur reconnaît la clé et ne l'enregistre qu'une fois.
-- Les clés sont gardées 30 jours puis effacées.
-- =====================================================================
CREATE TABLE pf_client_keys (
  owner_id   uuid NOT NULL REFERENCES users(id),
  key        text NOT NULL CHECK (length(key) BETWEEN 8 AND 80),
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);

-- Réserve la clé : new = on peut enregistrer ; done = déjà fait (résultat rendu) ; busy = envoi identique en cours
CREATE FUNCTION fn_pf_once(p_actor uuid, p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r pf_client_keys; n int;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 80 THEN PERFORM _err('invalid_input', 'Clé d''envoi invalide'); END IF;
  DELETE FROM pf_client_keys WHERE owner_id = p_actor AND created_at < now() - interval '30 days';
  INSERT INTO pf_client_keys(owner_id, key) VALUES (p_actor, p_key) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN RETURN jsonb_build_object('state', 'new'); END IF;
  SELECT * INTO r FROM pf_client_keys WHERE owner_id = p_actor AND key = p_key FOR UPDATE;
  IF r.result IS NOT NULL THEN RETURN jsonb_build_object('state', 'done', 'result', r.result); END IF;
  IF r.created_at < now() - interval '2 minutes' THEN   -- un essai précédent a été interrompu : on reprend
    UPDATE pf_client_keys SET created_at = now() WHERE owner_id = p_actor AND key = p_key;
    RETURN jsonb_build_object('state', 'new');
  END IF;
  RETURN jsonb_build_object('state', 'busy');
END $$;
CREATE FUNCTION fn_pf_once_done(p_actor uuid, p_key text, p_result jsonb) RETURNS void LANGUAGE sql AS $$
  UPDATE pf_client_keys SET result = COALESCE(p_result, '{}'::jsonb) WHERE owner_id = p_actor AND key = p_key;
$$;
CREATE FUNCTION fn_pf_once_release(p_actor uuid, p_key text) RETURNS void LANGUAGE sql AS $$
  DELETE FROM pf_client_keys WHERE owner_id = p_actor AND key = p_key AND result IS NULL;
$$;

-- Effacement des données Mes finances et anonymisation du compte : les clés partent aussi
DO $$
DECLARE d text; a text := 'DELETE FROM pf_sale_lines WHERE sale_id IN (SELECT id FROM pf_sales WHERE owner_id = p_actor);';
BEGIN
  SELECT pg_get_functiondef('fn_pf_erase(uuid,text)'::regprocedure) INTO d;
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'fn_pf_erase : repère introuvable'; END IF;
  EXECUTE replace(d, a, 'DELETE FROM pf_client_keys WHERE owner_id = p_actor;' || E'\n  ' || a);
END $$;
CREATE FUNCTION trg_pf_keys_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pf_client_keys WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER users_pf_keys_anonymized BEFORE UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_keys_anonymized();

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
