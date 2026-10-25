-- 020 : tournées groupées. Le chef regroupe plusieurs commandes pour un même livreur, dans un ordre de passage.
-- Chaque commande garde son propre suivi (récupération, départ, livraison, échec, retour, encaissement) : on réutilise l'affectation existante,
-- pas de second système. AUCUNE rémunération nouvelle : la paie par commande (figée à la création) est inchangée.
-- Le « coût réel » d'une tournée est une simple information saisie, pour mesurer la rentabilité ; il n'écrit rien dans les comptes.
-- Pas de limite arbitraire du nombre de commandes ; l'affectation reste imposée par le chef (pas d'acceptation, pas de plafond).

CREATE TABLE tours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_id  uuid NOT NULL REFERENCES users(id),
  created_by  uuid NOT NULL REFERENCES users(id),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'cancelled')),
  note        text CHECK (note IS NULL OR length(note) <= 200),
  actual_cost bigint CHECK (actual_cost IS NULL OR actual_cost >= 0),   -- coût réel saisi (information seulement)
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
CREATE INDEX tours_courier_idx ON tours(courier_id, status);

CREATE TABLE tour_stops (
  tour_id  uuid NOT NULL REFERENCES tours(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  position int  NOT NULL CHECK (position >= 1),
  active   boolean NOT NULL DEFAULT true,           -- faux quand la commande a quitté la tournée (livrée, échec, réaffectée…)
  PRIMARY KEY (tour_id, order_id),
  UNIQUE (tour_id, position)
);
CREATE UNIQUE INDEX tour_stops_one_active_uq ON tour_stops(order_id) WHERE active;   -- une commande n'est dans qu'une tournée active

-- Met à jour les tournées : une étape reste active tant que sa commande est entre les mains du livreur de la tournée ;
-- une tournée sans étape active est close. Vérifié à chaque lecture ou création (pas de minuteur).
CREATE FUNCTION _tours_refresh() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tour_stops s SET active = false
   WHERE s.active AND NOT EXISTS (
     SELECT 1 FROM orders o JOIN tours t ON t.id = s.tour_id
      WHERE o.id = s.order_id AND o.courier_id = t.courier_id AND o.status IN ('assigned', 'picked_up', 'on_the_way'));
  UPDATE tours t SET status = 'closed', closed_at = now()
   WHERE t.status = 'active' AND NOT EXISTS (SELECT 1 FROM tour_stops s WHERE s.tour_id = t.id AND s.active);
END $$;

-- Chef ou administrateur : crée une tournée (au moins 2 commandes) et affecte chaque commande au livreur
CREATE FUNCTION fn_chief_create_tour(p_actor uuid, p_courier uuid, p_orders uuid[], p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
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

-- Chef ou administrateur : annule la tournée. Les commandes restent affectées au livreur, une par une (rien n'est repris).
CREATE FUNCTION fn_chief_cancel_tour(p_actor uuid, p_tour uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  UPDATE tours SET status = 'cancelled', closed_at = now() WHERE id = p_tour AND status = 'active';
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Tournée introuvable ou déjà terminée'); END IF;
  UPDATE tour_stops SET active = false WHERE tour_id = p_tour AND active;
  PERFORM _audit(p_actor, 'tour_cancelled', 'tour', p_tour::text, '{}'::jsonb);
END $$;

-- Chef ou administrateur : coût réel de la tournée (carburant, temps…), à titre d'information pour mesurer la rentabilité
CREATE FUNCTION fn_chief_set_tour_cost(p_actor uuid, p_tour uuid, p_cost bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  IF p_cost IS NOT NULL AND (p_cost < 0 OR p_cost > 100000000) THEN PERFORM _err('invalid_input', 'Coût invalide'); END IF;
  SELECT actual_cost INTO v_old FROM tours WHERE id = p_tour FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Tournée introuvable'); END IF;
  UPDATE tours SET actual_cost = p_cost WHERE id = p_tour;
  PERFORM _audit(p_actor, 'tour_cost_set', 'tour', p_tour::text, jsonb_build_object('from', v_old, 'to', p_cost));
END $$;

-- Chef ou administrateur : tournées (actives, et les 30 dernières terminées) avec étapes et chiffres de rentabilité.
-- Lecture seule : frais de livraison encaissés sur les commandes livrées, paie du livreur actuellement prévue par le système,
-- coût réel saisi. La marge est calculée sur le coût réel s'il est saisi, sinon sur la paie prévue.
CREATE FUNCTION fn_chief_tours(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'created_at') DESC) FROM (
    SELECT jsonb_build_object(
      'id', t.id, 'status', t.status, 'note', t.note, 'created_at', t.created_at, 'closed_at', t.closed_at,
      'courier_id', t.courier_id, 'courier_name', u.full_name, 'actual_cost', t.actual_cost,
      'stops', (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'ref', o.ref, 'commune', o.commune, 'status', o.status, 'position', s.position, 'active', s.active) ORDER BY s.position)
                  FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id),
      'orders', (SELECT count(*) FROM tour_stops s WHERE s.tour_id = t.id),
      'delivered', (SELECT count(*) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'),
      'delivery_fees', COALESCE((SELECT sum(o.delivery_fee) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0),
      'courier_pay_system', COALESCE((SELECT sum(o.courier_pay) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0)) AS x
    FROM tours t JOIN users u ON u.id = t.courier_id
    WHERE t.status = 'active' OR t.id IN (SELECT id FROM tours WHERE status <> 'active' ORDER BY created_at DESC LIMIT 30)) q), '[]'::jsonb);
END $$;

-- Livreur : ses tournées actives, avec l'ordre de passage (le détail de chaque commande reste dans « Mes livraisons »)
CREATE FUNCTION fn_courier_tours(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  PERFORM _tours_refresh();
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'note', t.note,
      'stops', (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'ref', o.ref, 'commune', o.commune, 'status', o.status, 'position', s.position, 'active', s.active) ORDER BY s.position)
                  FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id)) ORDER BY t.created_at)
    FROM tours t WHERE t.courier_id = p_actor AND t.status = 'active'), '[]'::jsonb);
END $$;

-- Remise à zéro de l'activité : les tournées référencent les commandes, elles sont vidées avec elles (reste identique à la 019)
CREATE OR REPLACE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 order_history, calls, risky_customers, sheet_imports, order_requests, mission_offers, tour_stops, tours, orders, arrivals, seller_stock, messages, one_time_codes, proofs
    RESTART IDENTITY;
  UPDATE products SET stock_qty = 0, reserved_qty = 0;
  PERFORM _audit(p_actor, 'activity_reset', 'system', NULL, jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries));
  RETURN jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries);
END $$;

-- ---------- Droits (même boucle ; order_requests reste exclue) ----------
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
