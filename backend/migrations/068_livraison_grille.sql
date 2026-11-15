-- 068 : grille tarifaire de la « livraison à la demande » (base). Départ + groupes de quartiers d'arrivée + prix poids léger / poids lourd.
-- Éteint par défaut (feature_livraison_demande = 0). N'altère ni les zones ni les frais des commandes de vendeurs.
-- Un tarif n'est jamais supprimé : on le désactive (l'historique reste).
INSERT INTO settings(key, value, label) VALUES
  ('feature_livraison_demande', 0, 'Livraison à la demande pour des personnes qui ne sont pas vendeurs (0 = non, 1 = oui)'),
  ('delivery_heavy_kg', 10, 'Poids à partir duquel un colis est « lourd » (en kg)')
ON CONFLICT (key) DO NOTHING;

-- Normalisation d'un nom de quartier : minuscules, sans accents, espaces simples. Remplacement caractère par caractère (fiable quel que soit l'encodage de la base).
CREATE FUNCTION _dlv_norm(t text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text := lower(btrim(COALESCE(t, '')));
        f text[] := ARRAY['é','è','ê','ë','à','â','ä','î','ï','ô','ö','ù','û','ü','ç','É','È','Ê','Ë','À','Â','Ä','Î','Ï','Ô','Ö','Ù','Û','Ü','Ç'];
        r text[] := ARRAY['e','e','e','e','a','a','a','i','i','o','o','u','u','u','c','e','e','e','e','a','a','a','i','i','o','o','u','u','u','c'];
        i int;
BEGIN
  FOR i IN 1..array_length(f, 1) LOOP s := replace(s, f[i], r[i]); END LOOP;
  RETURN regexp_replace(s, '\s+', ' ', 'g');
END $$;

CREATE TABLE dlv_tariffs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_place  text NOT NULL CHECK (length(from_place) BETWEEN 2 AND 60),
  from_norm   text NOT NULL,
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  places      text[] NOT NULL CHECK (cardinality(places) BETWEEN 1 AND 80),
  places_norm text[] NOT NULL,
  price_light bigint NOT NULL CHECK (price_light BETWEEN 0 AND 10000000),
  price_heavy bigint NOT NULL CHECK (price_heavy BETWEEN 0 AND 10000000),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dlv_tariffs_from ON dlv_tariffs(from_norm) WHERE active;

-- Nettoie et contrôle une liste de quartiers (sans doublon, 60 caractères au plus par nom).
CREATE FUNCTION _dlv_clean_places(p_places text[]) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r text[]; seen text[] := '{}'; p text; n text;
BEGIN
  FOREACH p IN ARRAY COALESCE(p_places, '{}') LOOP
    p := regexp_replace(btrim(p), '\s+', ' ', 'g');
    IF p = '' THEN CONTINUE; END IF;
    IF length(p) > 60 THEN PERFORM _err('invalid_input', 'Nom de quartier trop long'); END IF;
    n := _dlv_norm(p);
    IF n = ANY(seen) THEN CONTINUE; END IF;
    seen := seen || n; r := COALESCE(r, '{}') || p;
  END LOOP;
  IF r IS NULL THEN PERFORM _err('invalid_input', 'Indiquez au moins un quartier d''arrivée'); END IF;
  RETURN r;
END $$;

CREATE FUNCTION _dlv_check_overlap(p_from_norm text, p_places_norm text[], p_self uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  SELECT x INTO v FROM dlv_tariffs t, unnest(t.places_norm) x
   WHERE t.active AND t.from_norm = p_from_norm AND t.id IS DISTINCT FROM p_self AND x = ANY(p_places_norm) LIMIT 1;
  IF v IS NOT NULL THEN PERFORM _err('duplicate', 'Le quartier « ' || v || ' » est déjà dans un autre groupe de ce départ'); END IF;
END $$;

CREATE FUNCTION fn_admin_dlv_tariff_save(p_actor uuid, p_id uuid, p_from text, p_places text[], p_light bigint, p_heavy bigint, p_active boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_places text[]; v_norm text[]; v_id uuid := p_id; v_from text := regexp_replace(btrim(COALESCE(p_from, '')), '\s+', ' ', 'g');
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF length(v_from) < 2 OR length(v_from) > 60 THEN PERFORM _err('invalid_input', 'Quartier de départ invalide'); END IF;
  IF p_light IS NULL OR p_heavy IS NULL OR p_light < 0 OR p_heavy < 0 OR p_light > 10000000 OR p_heavy > 10000000 THEN PERFORM _err('invalid_input', 'Prix invalide'); END IF;
  IF p_heavy < p_light THEN PERFORM _err('invalid_input', 'Le prix poids lourd ne peut pas être inférieur au prix poids léger'); END IF;
  v_places := _dlv_clean_places(p_places);
  SELECT array_agg(_dlv_norm(x)) INTO v_norm FROM unnest(v_places) x;
  IF p_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dlv_tariffs WHERE id = p_id) THEN PERFORM _err('not_found', 'Tarif introuvable'); END IF;
  IF COALESCE(p_active, true) THEN PERFORM _dlv_check_overlap(_dlv_norm(v_from), v_norm, p_id); END IF;
  IF p_id IS NULL THEN
    INSERT INTO dlv_tariffs(from_place, from_norm, label, places, places_norm, price_light, price_heavy, active)
    VALUES (v_from, _dlv_norm(v_from), left(array_to_string(v_places[1:3], ', ') || CASE WHEN cardinality(v_places) > 3 THEN '…' ELSE '' END, 120), v_places, v_norm, p_light, p_heavy, COALESCE(p_active, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE dlv_tariffs SET from_place = v_from, from_norm = _dlv_norm(v_from),
           label = left(array_to_string(v_places[1:3], ', ') || CASE WHEN cardinality(v_places) > 3 THEN '…' ELSE '' END, 120),
           places = v_places, places_norm = v_norm, price_light = p_light, price_heavy = p_heavy, active = COALESCE(p_active, true), updated_at = now()
     WHERE id = p_id;
  END IF;
  PERFORM _audit(p_actor, 'dlv_tariff_saved', 'dlv_tariff', v_id::text, jsonb_build_object('from', v_from, 'places', cardinality(v_places), 'light', p_light, 'heavy', p_heavy, 'active', COALESCE(p_active, true)));
  RETURN v_id;
END $$;

-- Importe toute une grille d'un départ : p_tiers = [{places:[...], light, heavy}, …]. Les anciens groupes actifs du même départ sont désactivés (jamais supprimés).
CREATE FUNCTION fn_admin_dlv_import(p_actor uuid, p_from text, p_tiers jsonb) RETURNS int LANGUAGE plpgsql AS $$
DECLARE t jsonb; n int := 0; v_from text := regexp_replace(btrim(COALESCE(p_from, '')), '\s+', ' ', 'g');
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF length(v_from) < 2 OR length(v_from) > 60 THEN PERFORM _err('invalid_input', 'Quartier de départ invalide'); END IF;
  IF p_tiers IS NULL OR jsonb_typeof(p_tiers) <> 'array' OR jsonb_array_length(p_tiers) = 0 THEN PERFORM _err('invalid_input', 'Aucun groupe à importer'); END IF;
  IF jsonb_array_length(p_tiers) > 40 THEN PERFORM _err('invalid_input', '40 groupes au plus'); END IF;
  UPDATE dlv_tariffs SET active = false, updated_at = now() WHERE active AND from_norm = _dlv_norm(v_from);
  FOR t IN SELECT * FROM jsonb_array_elements(p_tiers) LOOP
    PERFORM fn_admin_dlv_tariff_save(p_actor, NULL, v_from, ARRAY(SELECT jsonb_array_elements_text(t->'places')), (t->>'light')::bigint, (t->>'heavy')::bigint, true);
    n := n + 1;
  END LOOP;
  PERFORM _audit(p_actor, 'dlv_grid_imported', 'dlv_tariff', _dlv_norm(v_from), jsonb_build_object('from', v_from, 'tiers', n));
  RETURN n;
END $$;

CREATE FUNCTION fn_admin_dlv_list(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN jsonb_build_object('enabled', _setting('feature_livraison_demande') = 1, 'heavy_kg', _setting('delivery_heavy_kg'),
    'tariffs', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'from', from_place, 'places', places, 'light', price_light, 'heavy', price_heavy, 'active', active) ORDER BY from_place, active DESC, price_light, created_at) FROM dlv_tariffs), '[]'::jsonb));
END $$;

-- Prix d'une course : départ, arrivée, poids (kg). Réservé à l'admin tant que la fonction est éteinte.
CREATE FUNCTION fn_dlv_quote(p_actor uuid, p_from text, p_to text, p_kg numeric) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE v_role user_role; t dlv_tariffs; v_heavy boolean;
BEGIN
  SELECT role INTO v_role FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF v_role IS NULL THEN PERFORM _err('forbidden', 'Action non autorisée'); END IF;
  IF v_role <> 'admin' AND _setting('feature_livraison_demande') <> 1 THEN PERFORM _err('forbidden', 'La livraison à la demande n''est pas ouverte'); END IF;
  IF p_kg IS NULL OR p_kg <= 0 OR p_kg > 1000 THEN PERFORM _err('invalid_input', 'Poids invalide (en kg)'); END IF;
  SELECT * INTO t FROM dlv_tariffs WHERE active AND from_norm = _dlv_norm(p_from) AND _dlv_norm(p_to) = ANY(places_norm) LIMIT 1;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Ce trajet n''a pas encore de tarif'); END IF;
  v_heavy := p_kg >= _setting('delivery_heavy_kg');
  RETURN jsonb_build_object('weight_class', CASE WHEN v_heavy THEN 'heavy' ELSE 'light' END, 'price', CASE WHEN v_heavy THEN t.price_heavy ELSE t.price_light END, 'tariff_id', t.id);
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
