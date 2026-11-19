-- 080 : frais de livraison selon le point de départ (docs/ANALYSE-frais-selon-depart.md).
-- Un produit gardé chez le fournisseur peut être rattaché à UN de ses points de retrait (products.pickup_point_id).
-- Si le réglage feature_depart_fees = 1, le frais de livraison de la commande se calcule alors du point vers la zone du client, par paliers :
--   même zone (quartier ou ville) : fee_depart_same_zone ; même commune : fee_depart_same_commune ; autre commune : grille actuelle + fee_depart_far_extra.
-- Les paliers proches ne dépassent jamais la grille actuelle et ne descendent jamais sous fee_depart_min (le livreur reste payé). Entrepôt Wallindirain : AUCUN changement.
-- Le frais est figé à la création de la commande, comme aujourd'hui. Réglage éteint par défaut. Retour arrière : docs/retour-arriere-080.sql (refusé si des produits sont rattachés).
INSERT INTO settings(key, value, label) VALUES
  ('feature_depart_fees',      0,     'Frais de livraison selon le point de départ du fournisseur : 1 = oui, 0 = non'),
  ('fee_depart_same_zone',     15000, 'Frais si le point de départ est dans la même zone que le client (GNF)'),
  ('fee_depart_same_commune',  20000, 'Frais si le point de départ est dans la même commune que le client (GNF)'),
  ('fee_depart_far_extra',     0,     'Supplément ajouté à la grille si le point de départ est dans une autre commune (GNF)'),
  ('fee_depart_min',           10000, 'Frais de livraison minimum pour un départ depuis un point (GNF)')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE products ADD COLUMN pickup_point_id uuid REFERENCES pickup_points(id);

-- Frais selon le départ : renvoie la grille (p_grid) si la fonction est éteinte, si le produit n'a pas de point, ou si le point est inactif
CREATE FUNCTION _delivery_fee_from(p_point uuid, p_commune text, p_grid bigint) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE v_zone text; o delivery_rates; d delivery_rates; v_tier bigint;
BEGIN
  IF _setting('feature_depart_fees') <> 1 OR p_point IS NULL THEN RETURN p_grid; END IF;
  SELECT zone INTO v_zone FROM pickup_points WHERE id = p_point AND active;
  IF NOT FOUND THEN RETURN p_grid; END IF;
  SELECT * INTO o FROM delivery_rates WHERE lower(commune) = lower(v_zone);
  SELECT * INTO d FROM delivery_rates WHERE commune = p_commune;
  IF o.commune IS NULL OR d.commune IS NULL THEN RETURN p_grid; END IF;         -- zone du point inconnue : grille actuelle
  IF o.commune = d.commune THEN v_tier := _setting('fee_depart_same_zone');
  ELSIF COALESCE(o.parent, o.commune) = COALESCE(d.parent, d.commune) THEN v_tier := _setting('fee_depart_same_commune');
  ELSE RETURN p_grid + _setting('fee_depart_far_extra');
  END IF;
  RETURN LEAST(GREATEST(v_tier, _setting('fee_depart_min')), p_grid);          -- jamais au-dessus de la grille, jamais sous le minimum
END $$;

-- Aperçu en lecture seule (vendeur, administrateur)
CREATE FUNCTION fn_delivery_fee_preview(p_actor uuid, p_product uuid, p_commune text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE v_grid bigint; p products; v_fee bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller','admin']::user_role[]);
  SELECT fee INTO v_grid FROM delivery_rates WHERE commune = p_commune AND active;
  IF NOT FOUND THEN PERFORM _err('invalid_input', 'Zone non desservie'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  v_fee := CASE WHEN p.storage = 'supplier' THEN _delivery_fee_from(p.pickup_point_id, p_commune, v_grid) ELSE v_grid END;
  RETURN jsonb_build_object('fee', v_fee, 'grid', v_grid, 'reduced', v_fee < v_grid, 'from_point', p.storage = 'supplier' AND p.pickup_point_id IS NOT NULL AND _setting('feature_depart_fees') = 1);
END $$;

-- La zone d'un point doit être une zone de livraison connue (sinon les paliers ne peuvent pas s'appliquer)
CREATE OR REPLACE FUNCTION fn_pickup_point_save(p_actor uuid, p_id uuid, p_name text, p_zone text, p_address text, p_contact text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p pickup_points; v_zone text;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier','seller']::user_role[]);
  IF _setting('feature_pickup_points') <> 1 THEN PERFORM _err('feature_off', 'Les points de retrait ne sont pas activés'); END IF;
  IF length(trim(COALESCE(p_name, ''))) NOT BETWEEN 2 AND 80 OR length(trim(COALESCE(p_address, ''))) NOT BETWEEN 3 AND 200
     OR (NULLIF(trim(COALESCE(p_contact, '')), '') IS NOT NULL AND trim(p_contact) !~ '^[0-9+ ]{8,16}$') THEN PERFORM _err('invalid_input', 'Nom et adresse obligatoires ; téléphone valide si indiqué'); END IF;
  SELECT commune INTO v_zone FROM delivery_rates WHERE lower(commune) = lower(trim(COALESCE(p_zone, ''))) AND active;
  IF NOT FOUND THEN PERFORM _err('invalid_input', 'Choisissez une zone de la liste'); END IF;
  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM pickup_points WHERE owner_id = p_actor AND active) >= 20 THEN PERFORM _err('too_many', 'Vingt points de retrait au maximum'); END IF;
    INSERT INTO pickup_points(owner_id, name, zone, address, contact)
    VALUES (p_actor, trim(p_name), v_zone, trim(p_address), NULLIF(trim(COALESCE(p_contact, '')), '')) RETURNING * INTO p;
  ELSE
    UPDATE pickup_points SET name = trim(p_name), zone = v_zone, address = trim(p_address), contact = NULLIF(trim(COALESCE(p_contact, '')), '')
     WHERE id = p_id AND owner_id = p_actor AND active RETURNING * INTO p;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Point de retrait introuvable'); END IF;
  END IF;
  PERFORM _audit(p_actor, 'pickup_point_save', 'pickup_point', p.id::text, '{}'::jsonb);
  RETURN _pp_json(p);
END $$;

-- Appliquer un point à un produit : copie le texte ET rattache le point (le départ du frais)
CREATE OR REPLACE FUNCTION fn_product_use_pickup_point(p_actor uuid, p_product uuid, p_point uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p pickup_points;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF _setting('feature_pickup_points') <> 1 THEN PERFORM _err('feature_off', 'Les points de retrait ne sont pas activés'); END IF;
  SELECT * INTO p FROM pickup_points WHERE id = p_point AND owner_id = p_actor AND active;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Point de retrait introuvable'); END IF;
  UPDATE products SET pickup_point_id = p.id, pickup_detail = left(p.name || ' – ' || p.zone || ' – ' || p.address || COALESCE(' – ' || p.contact, ''), 200)
   WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL AND storage = 'supplier';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable, ou non gardé chez vous'); END IF;
  PERFORM _audit(p_actor, 'product_pickup_set', 'product', p_product::text, jsonb_build_object('point', p.id));
END $$;

-- Une adresse saisie à la main détache le point (le départ n'est alors plus connu : grille actuelle)
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('fn_supplier_set_pickup(uuid,uuid,text)'::regprocedure);
  IF position('SET pickup_detail = v_detail WHERE' IN d) = 0 THEN RAISE EXCEPTION 'fn_supplier_set_pickup : motif introuvable'; END IF;
  EXECUTE replace(d, 'SET pickup_detail = v_detail WHERE', 'SET pickup_detail = v_detail, pickup_point_id = NULL WHERE');
END $$;

-- Création de commande : frais recalculé depuis le point du produit (produit gardé chez le fournisseur, sans stock vendeur à l'entrepôt)
DO $$
DECLARE d text; a text := E'    IF NOT FOUND THEN PERFORM _err(''not_found'', ''Produit indisponible''); END IF;\n    IF EXISTS (SELECT 1 FROM orders WHERE customer_phone = p_cphone AND product_id = p_product';
  b text := E'    IF NOT FOUND THEN PERFORM _err(''not_found'', ''Produit indisponible''); END IF;\n    IF p.storage = ''supplier'' AND p.pickup_point_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seller_stock WHERE seller_id = p_seller AND product_id = p_product AND qty - reserved_qty > 0) THEN\n      v_delivery := _delivery_fee_from(p.pickup_point_id, p_commune, v_delivery);\n      v_courier := CASE WHEN _setting(''courier_share_bps'') > 0 THEN ((v_delivery * _setting(''courier_share_bps'') + 5000) / 10000)::bigint ELSE _setting(''courier_pay'') END;\n    END IF;\n    IF EXISTS (SELECT 1 FROM orders WHERE customer_phone = p_cphone AND product_id = p_product';
BEGIN
  d := pg_get_functiondef('_create_order(uuid,uuid,text,bigint,int,text,text,text,text,text,text,uuid,boolean)'::regprocedure);
  IF position(a IN d) = 0 THEN RAISE EXCEPTION '_create_order : motif introuvable'; END IF;
  EXECUTE replace(d, a, b);
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
