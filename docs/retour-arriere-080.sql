-- Retour arrière de la 080 (frais selon le départ). Refusé si des produits sont rattachés à un point : rien n'est supprimé.
BEGIN;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM products WHERE pickup_point_id IS NOT NULL) THEN RAISE EXCEPTION 'Retour arrière refusé : des produits sont rattachés à un point de retrait. Rien n''a été supprimé.'; END IF; END $$;
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('_create_order(uuid,uuid,text,bigint,int,text,text,text,text,text,text,uuid,boolean)'::regprocedure);
  EXECUTE replace(d, E'    IF p.storage = ''supplier'' AND p.pickup_point_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seller_stock WHERE seller_id = p_seller AND product_id = p_product AND qty - reserved_qty > 0) THEN\n      v_delivery := _delivery_fee_from(p.pickup_point_id, p_commune, v_delivery);\n      v_courier := CASE WHEN _setting(''courier_share_bps'') > 0 THEN ((v_delivery * _setting(''courier_share_bps'') + 5000) / 10000)::bigint ELSE _setting(''courier_pay'') END;\n    END IF;\n', '');
  d := pg_get_functiondef('fn_supplier_set_pickup(uuid,uuid,text)'::regprocedure);
  EXECUTE replace(d, 'SET pickup_detail = v_detail, pickup_point_id = NULL WHERE', 'SET pickup_detail = v_detail WHERE');
END $$;
CREATE OR REPLACE FUNCTION fn_product_use_pickup_point(p_actor uuid, p_product uuid, p_point uuid) RETURNS void LANGUAGE plpgsql AS $f$
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
END $f$;
CREATE OR REPLACE FUNCTION fn_pickup_point_save(p_actor uuid, p_id uuid, p_name text, p_zone text, p_address text, p_contact text) RETURNS jsonb LANGUAGE plpgsql AS $f$
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
END $f$;
DROP FUNCTION IF EXISTS fn_delivery_fee_preview(uuid, uuid, text);
DROP FUNCTION IF EXISTS _delivery_fee_from(uuid, text, bigint);
ALTER TABLE products DROP COLUMN IF EXISTS pickup_point_id;
DELETE FROM settings WHERE key IN ('feature_depart_fees','fee_depart_same_zone','fee_depart_same_commune','fee_depart_far_extra','fee_depart_min');
DELETE FROM schema_migrations WHERE name = '080_frais_selon_depart.sql';
COMMIT;
