-- =====================================================================
-- Migration 062 : vérification du véhicule des livreurs (plaque + carte grise).
--  - concerne les livreurs à moto ou en voiture (vélo et à pied : rien à fournir)
--  - numéro de plaque, photo de la plaque, photo de la carte grise ; vérifiés à la main par l'administrateur
--  - réglage « vehicle_check_required » (0 par défaut = désactivé) : s'il est à 1, un livreur moto/voiture
--    non vérifié ne peut pas recevoir de mission
--  - images visibles du livreur et des administrateurs seulement, consultation par un administrateur enregistrée
-- =====================================================================
INSERT INTO settings(key, value, label) VALUES
  ('vehicle_check_required', 0, 'Plaque et carte grise vérifiées exigées pour les livreurs moto et voiture (1 = oui, 0 = non)')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE courier_vehicles (
  user_id       uuid PRIMARY KEY REFERENCES users(id),
  plate         text CHECK (plate IS NULL OR length(plate) BETWEEN 3 AND 20),
  plate_img     bytea CHECK (plate_img IS NULL OR octet_length(plate_img) BETWEEN 1000 AND 600000),
  plate_mime    text CHECK (plate_mime IS NULL OR plate_mime IN ('image/jpeg','image/png','image/webp')),
  card_img      bytea CHECK (card_img IS NULL OR octet_length(card_img) BETWEEN 1000 AND 600000),
  card_mime     text CHECK (card_mime IS NULL OR card_mime IN ('image/jpeg','image/png','image/webp')),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','verified','rejected')),
  reject_reason text,
  submitted_at  timestamptz,
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Le livreur peut-il recevoir une mission ? Oui si le contrôle est désactivé, si son véhicule n'a pas de plaque (vélo, à pied, non précisé) ou si plaque et carte grise sont vérifiées
CREATE FUNCTION _courier_vehicle_ok(p_courier uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _setting('vehicle_check_required') = 0
      OR COALESCE((SELECT vehicle FROM courier_profiles WHERE courier_id = p_courier), '') NOT IN ('moto', 'voiture')
      OR EXISTS (SELECT 1 FROM courier_vehicles WHERE user_id = p_courier AND status = 'verified');
$$;

CREATE FUNCTION fn_vehicle_set(p_actor uuid, p_plate text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d courier_vehicles; v_plate text := upper(regexp_replace(trim(COALESCE(p_plate, '')), '\s+', ' ', 'g'));
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  IF length(v_plate) < 3 OR length(v_plate) > 20 THEN PERFORM _err('invalid_input', 'Numéro de plaque invalide (3 à 20 caractères)'); END IF;
  SELECT * INTO d FROM courier_vehicles WHERE user_id = p_actor FOR UPDATE;
  IF FOUND AND d.status IN ('submitted', 'verified') THEN PERFORM _err('invalid_state', 'Véhicule déjà envoyé ou vérifié : contactez l''administration pour le modifier'); END IF;
  INSERT INTO courier_vehicles(user_id, plate) VALUES (p_actor, v_plate)
  ON CONFLICT (user_id) DO UPDATE SET plate = EXCLUDED.plate, status = 'draft', reject_reason = NULL, updated_at = now();
  PERFORM _audit(p_actor, 'vehicle_plate_set', 'user', p_actor::text);
END $$;

CREATE FUNCTION fn_vehicle_image_set(p_actor uuid, p_side text, p_mime text, p_data bytea) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d courier_vehicles;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  IF p_side NOT IN ('plate', 'card') THEN PERFORM _err('invalid_input', 'Photo invalide : plaque ou carte grise'); END IF;
  SELECT * INTO d FROM courier_vehicles WHERE user_id = p_actor FOR UPDATE;
  IF FOUND AND d.status IN ('submitted', 'verified') THEN PERFORM _err('invalid_state', 'Véhicule déjà envoyé ou vérifié : contactez l''administration pour le modifier'); END IF;
  INSERT INTO courier_vehicles(user_id) VALUES (p_actor) ON CONFLICT (user_id) DO NOTHING;
  BEGIN
    IF p_side = 'plate' THEN UPDATE courier_vehicles SET plate_img = p_data, plate_mime = p_mime WHERE user_id = p_actor;
    ELSE UPDATE courier_vehicles SET card_img = p_data, card_mime = p_mime WHERE user_id = p_actor; END IF;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Image invalide ou trop lourde');
  END;
  UPDATE courier_vehicles SET status = 'draft', reject_reason = NULL, updated_at = now() WHERE user_id = p_actor;
  PERFORM _audit(p_actor, 'vehicle_image_uploaded', 'user', p_actor::text, jsonb_build_object('side', p_side));
END $$;

CREATE FUNCTION fn_vehicle_submit(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE FUNCTION fn_vehicle_image_get(p_actor uuid, p_user uuid, p_side text) RETURNS TABLE(mime text, data bytea) LANGUAGE plpgsql AS $$
DECLARE a users; d courier_vehicles; v_mime text; v_data bytea;
BEGIN
  SELECT * INTO a FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Compte inactif ou introuvable'); END IF;
  IF a.id <> p_user AND a.role <> 'admin' THEN PERFORM _err('forbidden', 'Action non autorisée pour votre rôle'); END IF;
  IF p_side NOT IN ('plate', 'card') THEN PERFORM _err('invalid_input', 'Photo invalide : plaque ou carte grise'); END IF;
  SELECT * INTO d FROM courier_vehicles WHERE user_id = p_user;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_side = 'plate' THEN v_mime := d.plate_mime; v_data := d.plate_img; ELSE v_mime := d.card_mime; v_data := d.card_img; END IF;
  IF v_data IS NULL THEN RETURN; END IF;
  IF a.id <> p_user THEN PERFORM _audit(p_actor, 'vehicle_image_viewed', 'user', p_user::text, jsonb_build_object('side', p_side)); END IF;
  RETURN QUERY SELECT v_mime, v_data;
END $$;

CREATE FUNCTION fn_my_vehicle(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d courier_vehicles; v_veh text;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  SELECT * INTO d FROM courier_vehicles WHERE user_id = p_actor;
  SELECT vehicle INTO v_veh FROM courier_profiles WHERE courier_id = p_actor;
  RETURN jsonb_build_object('vehicle', v_veh, 'needed', COALESCE(v_veh, '') IN ('moto', 'voiture'),
    'required', _setting('vehicle_check_required') = 1, 'plate', d.plate, 'status', COALESCE(d.status, 'none'),
    'has_plate_img', d.plate_img IS NOT NULL, 'has_card_img', d.card_img IS NOT NULL,
    'reject_reason', d.reject_reason, 'submitted_at', d.submitted_at, 'decided_at', d.decided_at);
END $$;

CREATE FUNCTION fn_admin_verify_vehicle(p_actor uuid, p_user uuid, p_verified boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE FUNCTION fn_admin_reject_vehicle(p_actor uuid, p_user uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 OR length(p_reason) > 300 THEN PERFORM _err('invalid_input', 'Indiquez le motif du refus (3 à 300 caractères)'); END IF;
  UPDATE courier_vehicles SET status = 'rejected', reject_reason = trim(p_reason), decided_at = now(), decided_by = p_actor, updated_at = now() WHERE user_id = p_user;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Aucun véhicule envoyé par ce livreur'); END IF;
  PERFORM _audit(p_actor, 'vehicle_rejected', 'user', p_user::text, jsonb_build_object('reason', trim(p_reason)));
END $$;

-- Réglage : 0 ou 1
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('fn_admin_set_setting(uuid,text,bigint)'::regprocedure) INTO d;
  IF position('''kyc_images_required'') AND p_value > 1' in d) = 0 THEN RAISE EXCEPTION 'fn_admin_set_setting : repère introuvable'; END IF;
  EXECUTE replace(d, '''kyc_images_required'') AND p_value > 1', '''kyc_images_required'',''vehicle_check_required'') AND p_value > 1');
END $$;

-- Un livreur dont le véhicule n'est pas vérifié ne reçoit pas de mission (si le contrôle est activé)
DO $$
DECLARE d text; a text := 'SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;';
BEGIN
  FOREACH d IN ARRAY ARRAY['fn_chief_offer_order(uuid,uuid,uuid)', 'fn_chief_assign(uuid,uuid,uuid)'] LOOP
    d := pg_get_functiondef(d::regprocedure);
    IF position(a in d) = 0 THEN RAISE EXCEPTION 'mission : repère introuvable'; END IF;
    EXECUTE replace(d, a, 'IF NOT _courier_vehicle_ok(p_courier) THEN PERFORM _err(''vehicle_unverified'', ''La plaque et la carte grise de ce livreur ne sont pas encore vérifiées'');' || E'\n  ' || 'END IF;' || E'\n  ' || a);
  END LOOP;
END $$;

-- Anonymisation d'un compte : les images du véhicule sont supprimées
CREATE FUNCTION trg_vehicle_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM courier_vehicles WHERE user_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER users_vehicle_anonymized BEFORE UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_vehicle_anonymized();

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
