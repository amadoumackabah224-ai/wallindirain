-- 079 : points de retrait multiples (étape 1 de docs/ETUDE-entrepots-multiples.md). Un fournisseur ou un vendeur DÉCLARE plusieurs lieux de retrait (nom, zone, adresse, contact).
-- Pas de stock par point, pas de frais par point, aucun mouvement d'argent : le compteur de stock reste unique. Le point sert à renseigner le lieu de récupération d'un produit
-- (texte existant `products.pickup_detail`) et à proposer le point le plus proche de la zone du client. Réglage feature_pickup_points, éteint par défaut.
-- Retour arrière : docs/retour-arriere-079.sql (refusé s'il existe des points : rien n'est supprimé).
INSERT INTO settings(key, value, label) VALUES
  ('feature_pickup_points', 0, 'Points de retrait multiples (fournisseurs et vendeurs) : 1 = oui, 0 = non')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE pickup_points (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  zone       text NOT NULL CHECK (length(zone) BETWEEN 2 AND 80),
  address    text NOT NULL CHECK (length(address) BETWEEN 3 AND 200),
  contact    text CHECK (contact IS NULL OR contact ~ '^[0-9+ ]{8,16}$'),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pickup_points_owner_idx ON pickup_points(owner_id) WHERE active;

CREATE FUNCTION _pp_json(p pickup_points) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'zone', p.zone, 'address', p.address, 'contact', p.contact, 'active', p.active)
$$;

CREATE FUNCTION fn_pickup_points_mine(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier','seller']::user_role[]);
  RETURN jsonb_build_object('enabled', _setting('feature_pickup_points') = 1,
    'points', COALESCE((SELECT jsonb_agg(_pp_json(x) ORDER BY x.created_at) FROM pickup_points x WHERE x.owner_id = p_actor AND x.active), '[]'::jsonb));
END $$;

CREATE FUNCTION fn_pickup_point_save(p_actor uuid, p_id uuid, p_name text, p_zone text, p_address text, p_contact text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p pickup_points;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier','seller']::user_role[]);
  IF _setting('feature_pickup_points') <> 1 THEN PERFORM _err('feature_off', 'Les points de retrait ne sont pas activés'); END IF;
  IF length(trim(COALESCE(p_name, ''))) NOT BETWEEN 2 AND 80 OR length(trim(COALESCE(p_zone, ''))) NOT BETWEEN 2 AND 80 OR length(trim(COALESCE(p_address, ''))) NOT BETWEEN 3 AND 200
     OR (NULLIF(trim(COALESCE(p_contact, '')), '') IS NOT NULL AND trim(p_contact) !~ '^[0-9+ ]{8,16}$') THEN PERFORM _err('invalid_input', 'Nom, zone et adresse obligatoires ; téléphone valide si indiqué'); END IF;
  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM pickup_points WHERE owner_id = p_actor AND active) >= 20 THEN PERFORM _err('too_many', 'Vingt points de retrait au maximum'); END IF;
    INSERT INTO pickup_points(owner_id, name, zone, address, contact)
    VALUES (p_actor, trim(COALESCE(p_name, '')), trim(COALESCE(p_zone, '')), trim(COALESCE(p_address, '')), NULLIF(trim(COALESCE(p_contact, '')), '')) RETURNING * INTO p;
  ELSE
    UPDATE pickup_points SET name = trim(COALESCE(p_name, '')), zone = trim(COALESCE(p_zone, '')), address = trim(COALESCE(p_address, '')), contact = NULLIF(trim(COALESCE(p_contact, '')), '')
     WHERE id = p_id AND owner_id = p_actor AND active RETURNING * INTO p;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Point de retrait introuvable'); END IF;
  END IF;
  PERFORM _audit(p_actor, 'pickup_point_save', 'pickup_point', p.id::text, '{}'::jsonb);
  RETURN _pp_json(p);
END $$;

CREATE FUNCTION fn_pickup_point_remove(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier','seller']::user_role[]);
  UPDATE pickup_points SET active = false WHERE id = p_id AND owner_id = p_actor AND active;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Point de retrait introuvable'); END IF;
  PERFORM _audit(p_actor, 'pickup_point_remove', 'pickup_point', p_id::text, '{}'::jsonb);
END $$;

-- Le fournisseur applique un de ses points au lieu de récupération d'un produit gardé chez lui (copie du texte : rien d'autre ne change)
CREATE FUNCTION fn_product_use_pickup_point(p_actor uuid, p_product uuid, p_point uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p pickup_points;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF _setting('feature_pickup_points') <> 1 THEN PERFORM _err('feature_off', 'Les points de retrait ne sont pas activés'); END IF;
  SELECT * INTO p FROM pickup_points WHERE id = p_point AND owner_id = p_actor AND active;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Point de retrait introuvable'); END IF;
  UPDATE products SET pickup_detail = left(p.name || ' – ' || p.zone || ' – ' || p.address || COALESCE(' – ' || p.contact, ''), 200)
   WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL AND storage = 'supplier';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable, ou non gardé chez vous'); END IF;
  PERFORM _audit(p_actor, 'product_pickup_set', 'product', p_product::text, jsonb_build_object('point', p.id));
END $$;

-- Suggestion : le point du fournisseur du produit le plus proche de la zone du client (même zone, sinon même ville parente). Lecture seule.
CREATE FUNCTION fn_pickup_suggest(p_actor uuid, p_product uuid, p_zone text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE v_sup uuid; v_parent text; r pickup_points;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin','seller','warehouse']::user_role[]);
  IF _setting('feature_pickup_points') <> 1 THEN RETURN jsonb_build_object('point', NULL); END IF;
  SELECT supplier_id INTO v_sup FROM products WHERE id = p_product AND deleted_at IS NULL;
  IF v_sup IS NULL THEN RETURN jsonb_build_object('point', NULL); END IF;
  SELECT parent INTO v_parent FROM delivery_rates WHERE commune = p_zone;
  SELECT x.* INTO r FROM pickup_points x
   WHERE x.owner_id = v_sup AND x.active
   ORDER BY (lower(x.zone) = lower(COALESCE(p_zone, ''))) DESC,
            (v_parent IS NOT NULL AND (lower(x.zone) = lower(v_parent) OR x.zone IN (SELECT commune FROM delivery_rates WHERE parent = v_parent))) DESC,
            x.created_at
   LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('point', NULL); END IF;
  RETURN jsonb_build_object('point', _pp_json(r), 'same_zone', lower(r.zone) = lower(COALESCE(p_zone, '')));
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
