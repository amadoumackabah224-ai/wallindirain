-- 025 : une tournée groupée est PROPOSÉE au livreur, qui l'accepte avant de partir ; bonus de tournée paramétrable (0 par défaut).
-- Rien ne change dans la paie tant que l'administrateur n'a pas saisi un montant : le réglage « tour_bonus_per_extra_order » vaut 0.
-- Le bonus (montant par commande livrée à partir de la 2e) est FIGÉ à la création de la tournée, versé une seule fois à la clôture,
-- uniquement pour les commandes réellement livrées, et jamais au-delà de la marge de livraison de la tournée (paie + bonus <= frais encaissés).
-- Le livreur ne peut pas récupérer un colis d'une tournée qu'il n'a pas acceptée ; s'il refuse (sans pénalité) ou si le chef annule avant acceptation,
-- les commandes redeviennent « confirmées » et retournent au chef. La paie par commande (courier_pay) n'est pas modifiée.

INSERT INTO settings(key, value, label) VALUES
  ('tour_bonus_per_extra_order', 0, 'Tournée groupée : bonus versé au livreur pour chaque commande livrée à partir de la 2e, en GNF (0 = aucun bonus)');

ALTER TABLE tours DROP CONSTRAINT tours_status_check;
ALTER TABLE tours ADD CONSTRAINT tours_status_check CHECK (status IN ('proposed', 'active', 'closed', 'cancelled', 'refused'));
ALTER TABLE tours ADD COLUMN bonus_per_extra bigint NOT NULL DEFAULT 0 CHECK (bonus_per_extra >= 0);
ALTER TABLE tours ADD COLUMN accepted_at timestamptz;
ALTER TABLE tours ADD COLUMN bonus_paid bigint CHECK (bonus_paid IS NULL OR bonus_paid > 0);
CREATE UNIQUE INDEX wallet_tour_bonus_once_uq ON wallet_entries (order_id, user_id, kind) WHERE kind = 'tour_bonus' AND amount > 0 AND order_id IS NOT NULL;

-- Rend au chef les commandes d'une tournée proposée mais pas acceptée (elles redeviennent « confirmées », sans livreur)
CREATE FUNCTION _tour_release_orders(t tours, p_actor uuid, p_note text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT o.id FROM tour_stops s JOIN orders o ON o.id = s.order_id
            WHERE s.tour_id = t.id AND s.active AND o.status = 'assigned' AND o.courier_id = t.courier_id ORDER BY o.id FOR UPDATE OF o LOOP
    UPDATE orders SET status = 'confirmed', courier_id = NULL, assigned_by = NULL WHERE id = r.id;
    PERFORM _log_status(r.id, 'assigned', 'confirmed', p_actor, p_note);
  END LOOP;
END $$;

-- Bonus de tournée : versé une seule fois, à la clôture, pour les commandes réellement livrées par le livreur de la tournée (à partir de la 2e) ;
-- jamais plus que la marge de livraison de ces commandes. Une écriture pour le livreur, la contrepartie pour la plateforme, rattachées à la dernière commande livrée.
CREATE FUNCTION _tour_pay_bonus(p_tour uuid) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION _tours_refresh() RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  UPDATE tour_stops s SET active = false
   WHERE s.active AND NOT EXISTS (
     SELECT 1 FROM orders o JOIN tours t ON t.id = s.tour_id
      WHERE o.id = s.order_id AND o.courier_id = t.courier_id AND o.status IN ('assigned', 'picked_up', 'on_the_way'));
  UPDATE tours t SET status = 'cancelled', closed_at = now()                                   -- tournée proposée dont toutes les commandes sont parties ailleurs
   WHERE t.status = 'proposed' AND NOT EXISTS (SELECT 1 FROM tour_stops s WHERE s.tour_id = t.id AND s.active);
  FOR r IN WITH c AS (UPDATE tours t SET status = 'closed', closed_at = now()
                       WHERE t.status = 'active' AND NOT EXISTS (SELECT 1 FROM tour_stops s WHERE s.tour_id = t.id AND s.active) RETURNING t.id)
           SELECT id FROM c LOOP
    PERFORM _tour_pay_bonus(r.id);
  END LOOP;
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

CREATE OR REPLACE FUNCTION fn_chief_cancel_tour(p_actor uuid, p_tour uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t tours; r record;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  SELECT * INTO t FROM tours WHERE id = p_tour AND status IN ('proposed', 'active') FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Tournée introuvable ou déjà terminée'); END IF;
  IF t.status = 'proposed' THEN PERFORM _tour_release_orders(t, p_actor, 'Tournée annulée avant acceptation'); END IF;
  UPDATE tours SET status = 'cancelled', closed_at = now() WHERE id = p_tour;
  UPDATE tour_stops SET active = false WHERE tour_id = p_tour AND active;
  IF t.status = 'active' THEN PERFORM _tour_pay_bonus(p_tour); END IF;
  PERFORM _audit(p_actor, 'tour_cancelled', 'tour', p_tour::text, '{}'::jsonb);
END $$;

-- L'ordre de passage se règle aussi tant que la tournée est seulement proposée
CREATE OR REPLACE FUNCTION fn_chief_reorder_tour(p_actor uuid, p_tour uuid, p_orders uuid[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t tours; v_n int; i int;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  SELECT * INTO t FROM tours WHERE id = p_tour FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Tournée introuvable'); END IF;
  IF t.status NOT IN ('proposed', 'active') THEN PERFORM _err('invalid_state', 'Cette tournée est terminée, refusée ou annulée'); END IF;
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

-- Le livreur accepte la tournée proposée : il peut alors récupérer ses colis
CREATE FUNCTION fn_courier_accept_tour(p_actor uuid, p_tour uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t tours;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  PERFORM _tours_refresh();
  SELECT * INTO t FROM tours WHERE id = p_tour AND courier_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Tournée introuvable'); END IF;
  IF t.status <> 'proposed' THEN PERFORM _err('invalid_state', 'Cette tournée n''est plus à accepter'); END IF;
  UPDATE tours SET status = 'active', accepted_at = now() WHERE id = t.id;
  PERFORM _audit(p_actor, 'tour_accepted', 'tour', t.id::text, '{}'::jsonb);
END $$;

-- Le livreur refuse : sans pénalité, les commandes reviennent au chef d'équipe
CREATE FUNCTION fn_courier_refuse_tour(p_actor uuid, p_tour uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t tours;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  PERFORM _tours_refresh();
  SELECT * INTO t FROM tours WHERE id = p_tour AND courier_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Tournée introuvable'); END IF;
  IF t.status <> 'proposed' THEN PERFORM _err('invalid_state', 'Cette tournée n''est plus à accepter'); END IF;
  PERFORM _tour_release_orders(t, p_actor, 'Tournée refusée par le livreur');
  UPDATE tours SET status = 'refused', closed_at = now() WHERE id = t.id;
  UPDATE tour_stops SET active = false WHERE tour_id = t.id AND active;
  PERFORM _audit(p_actor, 'tour_refused', 'tour', t.id::text, '{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION fn_courier_pickup(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  IF EXISTS (SELECT 1 FROM tour_stops s JOIN tours t ON t.id = s.tour_id WHERE s.order_id = p_order AND s.active AND t.status = 'proposed') THEN
    PERFORM _err('tour_not_accepted', 'Acceptez d''abord la tournée proposée avant de récupérer ce colis');
  END IF;
  UPDATE orders SET status = 'picked_up' WHERE id = p_order AND courier_id = p_actor AND status = 'assigned' RETURNING * INTO o;
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Commande introuvable ou non affectée à vous'); END IF;
  PERFORM _log_status(o.id, 'assigned', 'picked_up', p_actor, 'Colis récupéré');
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
