-- 018 : profil du livreur (véhicule, disponibilité) et zones de livraison qu'il couvre.
-- Aucune donnée financière touchée. Aucune donnée personnelle ajoutée (le téléphone et le nom restent dans users).
-- Les affectations existantes ne changent pas : le chef peut toujours affecter n'importe quel livreur actif ;
-- profil, disponibilité et zones sont des informations d'aide à la décision (et la base de la répartition future).

CREATE TABLE courier_profiles (
  courier_id   uuid PRIMARY KEY REFERENCES users(id),
  vehicle      text CHECK (vehicle IN ('moto', 'velo', 'voiture', 'pied')),
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'unavailable')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id)
);

CREATE TABLE courier_zones (
  courier_id uuid NOT NULL REFERENCES users(id),
  commune    text NOT NULL REFERENCES delivery_rates(commune),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (courier_id, commune)
);
CREATE INDEX courier_zones_commune_idx ON courier_zones(commune);

CREATE FUNCTION _courier_exists(p_courier uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_courier IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = p_courier AND role = 'courier' AND deleted_at IS NULL) THEN
    PERFORM _err('not_found', 'Livreur introuvable');
  END IF;
END $$;

-- Administrateur : véhicule du livreur
CREATE FUNCTION fn_admin_set_courier_profile(p_actor uuid, p_courier uuid, p_vehicle text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old text;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  PERFORM _courier_exists(p_courier);
  IF p_vehicle IS NOT NULL AND p_vehicle NOT IN ('moto', 'velo', 'voiture', 'pied') THEN PERFORM _err('invalid_input', 'Véhicule invalide'); END IF;
  SELECT vehicle INTO v_old FROM courier_profiles WHERE courier_id = p_courier;
  INSERT INTO courier_profiles(courier_id, vehicle, updated_by) VALUES (p_courier, p_vehicle, p_actor)
  ON CONFLICT (courier_id) DO UPDATE SET vehicle = EXCLUDED.vehicle, updated_at = now(), updated_by = p_actor;
  PERFORM _audit(p_actor, 'courier_profile_set', 'user', p_courier::text, jsonb_build_object('vehicle_from', v_old, 'vehicle_to', p_vehicle));
END $$;

-- Administrateur : remplace la liste des zones couvertes (une liste vide = aucune zone : livreur exclu de la répartition automatique future,
-- mais toujours affectable à la main)
CREATE FUNCTION fn_admin_set_courier_zones(p_actor uuid, p_courier uuid, p_communes text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_list text[]; v_bad text;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  PERFORM _courier_exists(p_courier);
  SELECT COALESCE(array_agg(DISTINCT trim(c) ORDER BY trim(c)), ARRAY[]::text[]) INTO v_list FROM unnest(COALESCE(p_communes, ARRAY[]::text[])) c;
  IF cardinality(v_list) > 50 THEN PERFORM _err('invalid_input', 'Trop de zones'); END IF;
  SELECT c INTO v_bad FROM unnest(v_list) c WHERE NOT EXISTS (SELECT 1 FROM delivery_rates r WHERE r.commune = c) LIMIT 1;
  IF v_bad IS NOT NULL THEN PERFORM _err('invalid_input', 'Zone inconnue : ' || left(v_bad, 60)); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('courier-zones:' || p_courier::text));
  DELETE FROM courier_zones WHERE courier_id = p_courier AND NOT (commune = ANY (v_list));
  INSERT INTO courier_zones(courier_id, commune) SELECT p_courier, c FROM unnest(v_list) c ON CONFLICT DO NOTHING;
  INSERT INTO courier_profiles(courier_id, updated_by) VALUES (p_courier, p_actor)
  ON CONFLICT (courier_id) DO UPDATE SET updated_at = now(), updated_by = p_actor;
  PERFORM _audit(p_actor, 'courier_zones_set', 'user', p_courier::text, jsonb_build_object('zones', to_jsonb(v_list)));
  RETURN jsonb_build_object('zones', to_jsonb(v_list));
END $$;

-- Livreur : sa propre disponibilité uniquement
CREATE FUNCTION fn_courier_set_availability(p_actor uuid, p_available boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  IF p_available IS NULL THEN PERFORM _err('invalid_input', 'Disponibilité invalide'); END IF;
  INSERT INTO courier_profiles(courier_id, availability, updated_by) VALUES (p_actor, CASE WHEN p_available THEN 'available' ELSE 'unavailable' END, p_actor)
  ON CONFLICT (courier_id) DO UPDATE SET availability = EXCLUDED.availability, updated_at = now(), updated_by = p_actor;
END $$;

-- Livreur : son propre profil (jamais celui d'un autre)
CREATE FUNCTION fn_courier_profile(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p courier_profiles;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  SELECT * INTO p FROM courier_profiles WHERE courier_id = p_actor;
  RETURN jsonb_build_object('vehicle', p.vehicle, 'availability', COALESCE(p.availability, 'available'),
    'zones', COALESCE((SELECT jsonb_agg(commune ORDER BY commune) FROM courier_zones WHERE courier_id = p_actor), '[]'::jsonb));
END $$;

-- ---------- Droits (même boucle que les migrations précédentes ; order_requests reste exclue) ----------
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
       AND NOT (r.relname IN ('proofs','avatars') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
