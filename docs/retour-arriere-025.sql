-- RETOUR ARRIÈRE de la migration 025 (acceptation de tournée, bonus). JAMAIS AUTOMATIQUE.
-- REFUSE de s'exécuter si un bonus de tournée a déjà été versé (donnée financière à conserver). À faire AVANT les retours arrière 024, 023…
-- Les tournées « proposées » ou « refusées » deviennent « annulées » (les commandes restent affectées à leur livreur). Retirer aussi le code déployé correspondant.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM wallet_entries WHERE kind = 'tour_bonus') THEN
    RAISE EXCEPTION 'Retour arrière impossible : des bonus de tournée ont été versés (donnée financière à conserver)';
  END IF;
END $$;
UPDATE tours SET status = 'cancelled', closed_at = COALESCE(closed_at, now()) WHERE status IN ('proposed', 'refused');
DROP INDEX wallet_tour_bonus_once_uq;
ALTER TABLE tours DROP CONSTRAINT tours_status_check;
ALTER TABLE tours ADD CONSTRAINT tours_status_check CHECK (status IN ('active', 'closed', 'cancelled'));
ALTER TABLE tours DROP COLUMN bonus_paid;
ALTER TABLE tours DROP COLUMN accepted_at;
ALTER TABLE tours DROP COLUMN bonus_per_extra;
DELETE FROM settings WHERE key = 'tour_bonus_per_extra_order';
DROP FUNCTION fn_courier_accept_tour(uuid, uuid);
DROP FUNCTION fn_courier_refuse_tour(uuid, uuid);
CREATE OR REPLACE FUNCTION fn_chief_create_tour(p_actor uuid, p_courier uuid, p_orders uuid[], p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_ids uuid[]; v_id uuid := gen_random_uuid(); o orders; i int; v_pos int := 0; r record;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_courier AND role = 'courier' AND status = 'active' AND deleted_at IS NULL) THEN
    PERFORM _err('not_found', 'Livreur actif introuvable');
  END IF;
  IF p_orders IS NULL OR cardinality(p_orders) < 2 THEN PERFORM _err('invalid_input', 'Une tournée regroupe au moins 2 commandes'); END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(p_orders) x) <> cardinality(p_orders) THEN PERFORM _err('invalid_input', 'Une commande est indiquée deux fois'); END IF;
  PERFORM _expire_offers();
  PERFORM _tours_refresh();
  -- verrouille toutes les commandes dans un ordre stable (pas d'interblocage), puis contrôle chacune
  FOR r IN SELECT id FROM orders WHERE id = ANY (p_orders) ORDER BY id FOR UPDATE LOOP NULL; END LOOP;
  IF (SELECT count(*) FROM orders WHERE id = ANY (p_orders)) <> cardinality(p_orders) THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  FOR i IN 1 .. cardinality(p_orders) LOOP
    SELECT * INTO o FROM orders WHERE id = p_orders[i];
    IF EXISTS (SELECT 1 FROM tour_stops WHERE order_id = o.id AND active) THEN
      PERFORM _err('order_in_tour', 'La commande ' || o.ref || ' fait déjà partie d''une tournée en cours');
    END IF;
    IF NOT (o.status IN ('confirmed', 'failed') OR (o.status = 'assigned' AND o.courier_id = p_courier)) THEN
      PERFORM _err('invalid_state', 'La commande ' || o.ref || ' ne peut pas entrer dans une tournée (statut ' || o.status || ')');
    END IF;
  END LOOP;
  INSERT INTO tours(id, courier_id, created_by, note) VALUES (v_id, p_courier, p_actor, NULLIF(trim(COALESCE(p_note, '')), ''));
  FOR i IN 1 .. cardinality(p_orders) LOOP
    SELECT * INTO o FROM orders WHERE id = p_orders[i];
    IF o.status <> 'assigned' THEN PERFORM fn_chief_assign(p_actor, o.id, p_courier); END IF;
    v_pos := v_pos + 1;
    INSERT INTO tour_stops(tour_id, order_id, position) VALUES (v_id, o.id, v_pos);
  END LOOP;
  PERFORM _audit(p_actor, 'tour_created', 'tour', v_id::text, jsonb_build_object('courier', p_courier, 'orders', cardinality(p_orders)));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION fn_chief_cancel_tour(p_actor uuid, p_tour uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  UPDATE tours SET status = 'cancelled', closed_at = now() WHERE id = p_tour AND status = 'active';
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Tournée introuvable ou déjà terminée'); END IF;
  UPDATE tour_stops SET active = false WHERE tour_id = p_tour AND active;
  PERFORM _audit(p_actor, 'tour_cancelled', 'tour', p_tour::text, '{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION _tours_refresh() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tour_stops s SET active = false
   WHERE s.active AND NOT EXISTS (
     SELECT 1 FROM orders o JOIN tours t ON t.id = s.tour_id
      WHERE o.id = s.order_id AND o.courier_id = t.courier_id AND o.status IN ('assigned', 'picked_up', 'on_the_way'));
  UPDATE tours t SET status = 'closed', closed_at = now()
   WHERE t.status = 'active' AND NOT EXISTS (SELECT 1 FROM tour_stops s WHERE s.tour_id = t.id AND s.active);
END $$;

CREATE OR REPLACE FUNCTION fn_courier_tours(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  PERFORM _tours_refresh();
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'note', t.note,
      'stops', (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'ref', o.ref, 'commune', o.commune, 'status', o.status, 'position', s.position, 'active', s.active) ORDER BY s.position)
                  FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id)) ORDER BY t.created_at)
    FROM tours t WHERE t.courier_id = p_actor AND t.status = 'active'), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION fn_chief_tours(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'created_at') DESC) FROM (
    SELECT jsonb_build_object(
      'id', t.id, 'status', t.status, 'note', t.note, 'created_at', t.created_at, 'closed_at', t.closed_at,
      'courier_id', t.courier_id, 'courier_name', u.full_name, 'actual_cost', t.actual_cost,
      'stops', (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'ref', o.ref, 'commune', o.commune, 'status', o.status, 'position', s.position, 'active', s.active, 'fee', o.delivery_fee, 'pay', o.courier_pay) ORDER BY s.position)
                  FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id),
      'orders', (SELECT count(*) FROM tour_stops s WHERE s.tour_id = t.id),
      'delivered', (SELECT count(*) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'),
      'delivery_fees', COALESCE((SELECT sum(o.delivery_fee) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0),
      'planned_fees', COALESCE((SELECT sum(o.delivery_fee) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND (s.active OR o.status = 'delivered')), 0),
      'planned_pay', COALESCE((SELECT sum(o.courier_pay) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND (s.active OR o.status = 'delivered')), 0),
      'courier_pay_system', COALESCE((SELECT sum(o.courier_pay) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0)) AS x
    FROM tours t JOIN users u ON u.id = t.courier_id
    WHERE t.status = 'active' OR t.id IN (SELECT id FROM tours WHERE status <> 'active' ORDER BY created_at DESC LIMIT 30)) q), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION fn_courier_pickup(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  UPDATE orders SET status = 'picked_up' WHERE id = p_order AND courier_id = p_actor AND status = 'assigned' RETURNING * INTO o;
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Commande introuvable ou non affectée à vous'); END IF;
  PERFORM _log_status(o.id, 'assigned', 'picked_up', p_actor, 'Colis récupéré');
END $$;

CREATE OR REPLACE FUNCTION fn_ledger_check() RETURNS TABLE(problem text, detail text)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT 'commande livrée sans répartition'::text, o.ref FROM orders o
   WHERE o.status = 'delivered' AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.order_id = o.id AND w.kind = 'seller_gain');
  RETURN QUERY
  SELECT 'stock réservé incohérent'::text, p.id::text FROM products p
   WHERE p.reserved_qty <> COALESCE((SELECT sum(o.qty_from_catalog) FROM orders o
         WHERE o.product_id = p.id AND o.status IN ('new','in_call','confirmed','assigned','picked_up','on_the_way','failed','return_pending')), 0);
  RETURN QUERY
  SELECT 'stock vendeur réservé incohérent'::text, s.seller_id::text || '/' || s.product_id::text FROM seller_stock s
   WHERE s.reserved_qty <> COALESCE((SELECT sum(o.qty_from_seller) FROM orders o
         WHERE o.product_id = s.product_id AND o.seller_id = s.seller_id
           AND o.status IN ('new','in_call','confirmed','assigned','picked_up','on_the_way','failed','return_pending')), 0);
  RETURN QUERY
  SELECT 'paie du livreur supérieure aux frais de livraison'::text, o.ref FROM orders o WHERE o.courier_pay > o.delivery_fee;
  RETURN QUERY
  SELECT 'écritures de règlement en double'::text, w.order_id::text || '/' || w.kind FROM wallet_entries w
   WHERE w.order_id IS NOT NULL
     AND (w.kind IN ('seller_gain','supplier_payment','platform_revenue','float_release','return_fees',
                     'return_fee_supplier','prepaid_refund','transport_loss','referral_bonus')
          OR (w.kind = 'team_pay' AND w.amount > 0))
   GROUP BY w.order_id, w.user_id, w.kind HAVING count(*) > 1;
END $$;

CREATE OR REPLACE FUNCTION fn_chief_reorder_tour(p_actor uuid, p_tour uuid, p_orders uuid[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t tours; v_n int; i int;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  SELECT * INTO t FROM tours WHERE id = p_tour FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Tournée introuvable'); END IF;
  IF t.status <> 'active' THEN PERFORM _err('invalid_state', 'Cette tournée est terminée ou annulée'); END IF;
  SELECT count(*) INTO v_n FROM tour_stops WHERE tour_id = p_tour AND active;
  IF p_orders IS NULL OR cardinality(p_orders) <> v_n
     OR (SELECT count(DISTINCT x) FROM unnest(p_orders) x) <> v_n
     OR EXISTS (SELECT 1 FROM unnest(p_orders) x WHERE NOT EXISTS (SELECT 1 FROM tour_stops s WHERE s.tour_id = p_tour AND s.active AND s.order_id = x)) THEN
    PERFORM _err('invalid_input', 'Indiquez toutes les commandes en cours de la tournée, chacune une seule fois');
  END IF;
  UPDATE tour_stops SET position = position + 10000 WHERE tour_id = p_tour;                       -- évite les conflits de position pendant la mise à jour
  FOR i IN 1 .. v_n LOOP UPDATE tour_stops SET position = i WHERE tour_id = p_tour AND order_id = p_orders[i]; END LOOP;
  UPDATE tour_stops s SET position = v_n + r.rn FROM (SELECT order_id, row_number() OVER (ORDER BY position) AS rn FROM tour_stops WHERE tour_id = p_tour AND position >= 10000) r
   WHERE s.tour_id = p_tour AND s.order_id = r.order_id;                                          -- arrêts déjà sortis de la tournée : à la suite
  PERFORM _audit(p_actor, 'tour_reordered', 'tour', p_tour::text, jsonb_build_object('orders', v_n));
END $$;

DROP FUNCTION _tour_pay_bonus(uuid);
DROP FUNCTION _tour_release_orders(tours, uuid, text);

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
       AND NOT (r.relname IN ('proofs','avatars','product_images') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

DELETE FROM schema_migrations WHERE name = '025_tournee_acceptation_bonus.sql';
COMMIT;
