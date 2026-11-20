-- Retour arrière de la 082 : rétablit les fonctions de la 062 (sans messages). Aucune donnée supprimée.
BEGIN;

CREATE OR REPLACE FUNCTION fn_vehicle_submit(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d courier_vehicles;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  SELECT * INTO d FROM courier_vehicles WHERE user_id = p_actor FOR UPDATE;
  IF NOT FOUND OR d.plate IS NULL THEN PERFORM _err('invalid_input', 'Saisissez d''abord le numéro de votre plaque'); END IF;
  IF d.plate_img IS NULL THEN PERFORM _err('invalid_input', 'Ajoutez la photo de votre plaque'); END IF;
  IF d.card_img IS NULL THEN PERFORM _err('invalid_input', 'Ajoutez la photo de votre carte grise'); END IF;
  IF d.status IN ('submitted', 'verified') THEN RETURN; END IF;
  UPDATE courier_vehicles SET status = 'submitted', submitted_at = now(), reject_reason = NULL, updated_at = now() WHERE user_id = p_actor;
  PERFORM _audit(p_actor, 'vehicle_submitted', 'user', p_actor::text);
END $$;

CREATE OR REPLACE FUNCTION fn_admin_verify_vehicle(p_actor uuid, p_user uuid, p_verified boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d courier_vehicles;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO d FROM courier_vehicles WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Aucun véhicule envoyé par ce livreur'); END IF;
  IF p_verified AND (d.plate IS NULL OR d.plate_img IS NULL OR d.card_img IS NULL OR d.status NOT IN ('submitted', 'verified')) THEN
    PERFORM _err('invalid_state', 'Le livreur doit d''abord envoyer la plaque et la carte grise');
  END IF;
  UPDATE courier_vehicles SET status = CASE WHEN p_verified THEN 'verified' ELSE 'submitted' END,
         decided_at = now(), decided_by = p_actor, reject_reason = NULL, updated_at = now() WHERE user_id = p_user;
  PERFORM _audit(p_actor, 'verify_vehicle', 'user', p_user::text, jsonb_build_object('verified', p_verified));
END $$;

CREATE OR REPLACE FUNCTION fn_admin_reject_vehicle(p_actor uuid, p_user uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 OR length(p_reason) > 300 THEN PERFORM _err('invalid_input', 'Indiquez le motif du refus (3 à 300 caractères)'); END IF;
  UPDATE courier_vehicles SET status = 'rejected', reject_reason = trim(p_reason), decided_at = now(), decided_by = p_actor, updated_at = now() WHERE user_id = p_user;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Aucun véhicule envoyé par ce livreur'); END IF;
  PERFORM _audit(p_actor, 'vehicle_rejected', 'user', p_user::text, jsonb_build_object('reason', trim(p_reason)));
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

DELETE FROM schema_migrations WHERE name = '082_verif_documents_livreurs.sql';
COMMIT;
