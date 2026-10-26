-- RETOUR ARRIÈRE de la migration 026 (modes de paie de tournée). JAMAIS AUTOMATIQUE.
-- REFUSE de s'exécuter si un ajustement de tournée a déjà été versé ou si une tournée utilise le mode A ou B (donnée financière à conserver).
-- À faire AVANT le retour arrière 025. Retirer aussi le code déployé correspondant.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM wallet_entries WHERE kind = 'tour_adjust') OR EXISTS (SELECT 1 FROM tours WHERE pay_mode <> 'normal') THEN
    RAISE EXCEPTION 'Retour arrière impossible : des tournées en mode A ou B existent (donnée financière à conserver)';
  END IF;
END $$;
DROP INDEX wallet_tour_adjust_once_uq;
DROP FUNCTION fn_chief_create_tour(uuid, uuid, uuid[], text, text);
DROP FUNCTION _tour_plan(uuid);
CREATE OR REPLACE FUNCTION _tour_pay_bonus(p_tour uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t tours; v_n int; v_margin bigint; v_amount bigint; v_anchor uuid;
BEGIN
  SELECT * INTO t FROM tours WHERE id = p_tour FOR UPDATE;
  IF NOT FOUND OR t.bonus_paid IS NOT NULL OR t.bonus_per_extra <= 0 THEN RETURN; END IF;
  SELECT count(*), COALESCE(sum(o.delivery_fee - o.courier_pay), 0) INTO v_n, v_margin
    FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered' AND o.courier_id = t.courier_id;
  IF v_n < 2 THEN RETURN; END IF;
  v_amount := LEAST(t.bonus_per_extra * (v_n - 1), GREATEST(v_margin, 0));
  IF v_amount <= 0 THEN RETURN; END IF;
  SELECT o.id INTO v_anchor FROM tour_stops s JOIN orders o ON o.id = s.order_id
   WHERE s.tour_id = t.id AND o.status = 'delivered' AND o.courier_id = t.courier_id ORDER BY o.delivered_at DESC, o.id LIMIT 1;
  UPDATE tours SET bonus_paid = v_amount WHERE id = t.id AND bonus_paid IS NULL;
  PERFORM _wallet_add(t.courier_id, 'tour_bonus', v_amount, v_anchor, now(), 'Bonus de tournée');
  PERFORM _wallet_add(_platform(), 'tour_bonus', -v_amount, v_anchor, now(), 'Bonus de tournée livreur');
END $$;
CREATE OR REPLACE FUNCTION fn_chief_create_tour(p_actor uuid, p_courier uuid, p_orders uuid[], p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_ids uuid[]; v_id uuid := gen_random_uuid(); o orders; i int; v_pos int := 0; r record; v_bonus bigint := _setting('tour_bonus_per_extra_order'); v_pay bigint; v_fee bigint;
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
  -- le bonus (réglage, 0 par défaut) est figé à la création ; il ne doit jamais dépasser la marge de livraison de la tournée
  SELECT COALESCE(sum(courier_pay), 0), COALESCE(sum(delivery_fee), 0) INTO v_pay, v_fee FROM orders WHERE id = ANY (p_orders);
  IF v_bonus > 0 AND v_pay + v_bonus * (cardinality(p_orders) - 1) > v_fee THEN
    PERFORM _err('tour_bonus_exceeds_fee', 'Bonus de tournée refusé : la paie (' || v_pay || ' GNF) plus le bonus (' || v_bonus * (cardinality(p_orders) - 1) || ' GNF) dépasse les frais de livraison (' || v_fee || ' GNF)');
  END IF;
  INSERT INTO tours(id, courier_id, created_by, note, status, bonus_per_extra) VALUES (v_id, p_courier, p_actor, NULLIF(trim(COALESCE(p_note, '')), ''), 'proposed', v_bonus);
  FOR i IN 1 .. cardinality(p_orders) LOOP
    SELECT * INTO o FROM orders WHERE id = p_orders[i];
    IF o.status <> 'assigned' THEN PERFORM fn_chief_assign(p_actor, o.id, p_courier); END IF;
    v_pos := v_pos + 1;
    INSERT INTO tour_stops(tour_id, order_id, position) VALUES (v_id, o.id, v_pos);
  END LOOP;
  PERFORM _audit(p_actor, 'tour_created', 'tour', v_id::text, jsonb_build_object('courier', p_courier, 'orders', cardinality(p_orders), 'bonus_per_extra', v_bonus));
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION fn_courier_tours(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  PERFORM _tours_refresh();
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'note', t.note, 'status', t.status, 'created_at', t.created_at, 'bonus_per_extra', t.bonus_per_extra,
      'bonus_max', t.bonus_per_extra * GREATEST((SELECT count(*) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND (s.active OR o.status = 'delivered')) - 1, 0),
      'stops', (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'ref', o.ref, 'commune', o.commune, 'status', o.status, 'position', s.position, 'active', s.active, 'pay', o.courier_pay) ORDER BY s.position)
                  FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id)) ORDER BY t.created_at)
    FROM tours t WHERE t.courier_id = p_actor AND t.status IN ('proposed', 'active')), '[]'::jsonb);
END $$;
CREATE OR REPLACE FUNCTION fn_chief_tours(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'created_at') DESC) FROM (
    SELECT jsonb_build_object(
      'id', t.id, 'status', t.status, 'note', t.note, 'created_at', t.created_at, 'closed_at', t.closed_at,
      'courier_id', t.courier_id, 'courier_name', u.full_name, 'actual_cost', t.actual_cost, 'accepted_at', t.accepted_at, 'bonus_per_extra', t.bonus_per_extra, 'bonus_paid', t.bonus_paid,
      'planned_bonus', t.bonus_per_extra * GREATEST((SELECT count(*) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND (s.active OR o.status = 'delivered')) - 1, 0),
      'stops', (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'ref', o.ref, 'commune', o.commune, 'status', o.status, 'position', s.position, 'active', s.active, 'fee', o.delivery_fee, 'pay', o.courier_pay) ORDER BY s.position)
                  FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id),
      'orders', (SELECT count(*) FROM tour_stops s WHERE s.tour_id = t.id),
      'delivered', (SELECT count(*) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'),
      'delivery_fees', COALESCE((SELECT sum(o.delivery_fee) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0),
      'planned_fees', COALESCE((SELECT sum(o.delivery_fee) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND (s.active OR o.status = 'delivered')), 0),
      'planned_pay', COALESCE((SELECT sum(o.courier_pay) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND (s.active OR o.status = 'delivered')), 0),
      'courier_pay_system', COALESCE((SELECT sum(o.courier_pay) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0)) AS x
    FROM tours t JOIN users u ON u.id = t.courier_id
    WHERE t.status IN ('proposed', 'active') OR t.id IN (SELECT id FROM tours WHERE status NOT IN ('proposed', 'active') ORDER BY created_at DESC LIMIT 30)) q), '[]'::jsonb);
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
  RETURN QUERY
  SELECT 'bonus de tournée en double'::text, w.order_id::text FROM wallet_entries w
   WHERE w.kind = 'tour_bonus' AND w.amount > 0 AND w.order_id IS NOT NULL
   GROUP BY w.order_id, w.user_id HAVING count(*) > 1;
END $$;
ALTER TABLE tours DROP COLUMN adjust_paid;
ALTER TABLE tours DROP COLUMN mode_bps;
ALTER TABLE tours DROP COLUMN pay_mode;
DROP FUNCTION _tour_target_pay(text, integer, bigint, bigint, bigint);
DELETE FROM settings WHERE key IN ('tour_share_bps', 'tour_extra_share_bps');

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

DELETE FROM schema_migrations WHERE name = '026_tournee_modes_paie.sql';
COMMIT;
