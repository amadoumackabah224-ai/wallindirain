-- 019 : propositions de mission. Le chef PROPOSE une commande à un livreur ; le livreur voit sa rémunération, puis accepte ou refuse.
-- Accepter = l'affectation existante (fn_chief_assign), donc aucun second système. Refuser ou laisser expirer : aucune pénalité financière.
-- L'affectation directe par le chef reste possible et imposée (sans acceptation). Aucune valeur financière n'est modifiée.
-- L'expiration est vérifiée à chaque appel (l'hébergement gratuit s'endort : pas de dépendance à un minuteur).

INSERT INTO settings(key, value, label) VALUES
  ('mission_offer_minutes', 10, 'Proposition de mission : minutes accordées au livreur pour répondre (minimum 1)'),
  ('mission_max_offers',     3, 'Proposition de mission : nombre maximum de propositions par commande avant affectation manuelle (minimum 1)'),
  ('courier_max_open',       3, 'Livreur : nombre maximum de missions en cours (affectées ou proposées) pour recevoir une proposition (minimum 1 ; l''affectation directe du chef n''est pas limitée)');

CREATE TABLE mission_offers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id),
  courier_id   uuid NOT NULL REFERENCES users(id),
  offered_by   uuid NOT NULL REFERENCES users(id),
  status       text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'refused', 'expired', 'cancelled')),
  refuse_reason text CHECK (refuse_reason IN ('too_far', 'busy', 'vehicle', 'other')),
  offered_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  responded_at timestamptz,
  UNIQUE (order_id, courier_id)                      -- une commande n'est proposée qu'une fois au même livreur
);
CREATE UNIQUE INDEX mission_offers_one_open_uq ON mission_offers(order_id) WHERE status = 'offered';   -- une seule proposition ouverte par commande
CREATE INDEX mission_offers_courier_idx ON mission_offers(courier_id, status);

-- Clôture les propositions échues ou devenues sans objet (commande affectée à la main, annulée, etc.)
CREATE FUNCTION _expire_offers() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mission_offers m SET status = 'expired', responded_at = now() WHERE m.status = 'offered' AND m.expires_at <= now();
  UPDATE mission_offers m SET status = 'cancelled', responded_at = now()
   WHERE m.status = 'offered' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = m.order_id AND o.status IN ('confirmed', 'failed'));
END $$;

CREATE FUNCTION _courier_load(p_courier uuid) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM orders WHERE courier_id = p_courier AND status IN ('assigned', 'picked_up', 'on_the_way'))::int
       + (SELECT count(*) FROM mission_offers WHERE courier_id = p_courier AND status = 'offered')::int
$$;

-- Chef ou administrateur : propose une commande confirmée (ou en échec) à un livreur disponible
CREATE FUNCTION fn_chief_offer_order(p_actor uuid, p_order uuid, p_courier uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE o orders; v_id uuid := gen_random_uuid(); v_exp timestamptz; v_minutes int; v_avail text;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _expire_offers();
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_courier AND role = 'courier' AND status = 'active' AND deleted_at IS NULL) THEN
    PERFORM _err('not_found', 'Livreur actif introuvable');
  END IF;
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status NOT IN ('confirmed', 'failed') THEN PERFORM _err('invalid_state', 'Seules les commandes confirmées ou en échec peuvent être proposées'); END IF;
  IF EXISTS (SELECT 1 FROM mission_offers WHERE order_id = o.id AND status = 'offered') THEN PERFORM _err('offer_open', 'Cette commande est déjà proposée à un livreur : attendez sa réponse ou annulez la proposition'); END IF;
  IF EXISTS (SELECT 1 FROM mission_offers WHERE order_id = o.id AND courier_id = p_courier) THEN PERFORM _err('already_offered', 'Cette commande a déjà été proposée à ce livreur'); END IF;
  IF (SELECT count(*) FROM mission_offers WHERE order_id = o.id) >= GREATEST(1, _setting('mission_max_offers')) THEN
    PERFORM _err('max_offers_reached', 'Nombre maximum de propositions atteint pour cette commande : affectez-la directement');
  END IF;
  SELECT COALESCE(availability, 'available') INTO v_avail FROM courier_profiles WHERE courier_id = p_courier;
  IF COALESCE(v_avail, 'available') <> 'available' THEN PERFORM _err('courier_unavailable', 'Ce livreur s''est déclaré indisponible'); END IF;
  IF _courier_load(p_courier) >= GREATEST(1, _setting('courier_max_open')) THEN PERFORM _err('courier_busy', 'Ce livreur a déjà le maximum de missions en cours'); END IF;
  v_minutes := GREATEST(1, _setting('mission_offer_minutes'))::int;
  v_exp := now() + make_interval(mins => v_minutes);
  INSERT INTO mission_offers(id, order_id, courier_id, offered_by, expires_at) VALUES (v_id, o.id, p_courier, p_actor, v_exp);
  PERFORM _audit(p_actor, 'mission_offered', 'order', o.id::text, jsonb_build_object('courier', p_courier, 'expires_at', v_exp));
  RETURN jsonb_build_object('id', v_id, 'expires_at', v_exp);
END $$;

-- Chef ou administrateur : retire une proposition ouverte
CREATE FUNCTION fn_chief_cancel_offer(p_actor uuid, p_offer uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m mission_offers;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  UPDATE mission_offers SET status = 'cancelled', responded_at = now() WHERE id = p_offer AND status = 'offered' AND expires_at > now() RETURNING * INTO m;
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Proposition introuvable ou déjà terminée'); END IF;
  PERFORM _audit(p_actor, 'mission_offer_cancelled', 'order', m.order_id::text, jsonb_build_object('courier', m.courier_id));
END $$;

-- Livreur : ses propositions ouvertes. Rémunération visible avant d'accepter ; l'adresse précise et le client ne le sont pas encore.
CREATE FUNCTION fn_courier_offers(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  PERFORM _expire_offers();
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'ref', o.ref, 'commune', o.commune, 'product', COALESCE(p.name, o.own_product_name), 'qty', o.qty,
                      'amount_to_collect', o.sale_total, 'courier_pay', o.courier_pay, 'expires_at', m.expires_at, 'retry', o.status = 'failed') ORDER BY m.expires_at)
                    FROM mission_offers m JOIN orders o ON o.id = m.order_id LEFT JOIN products p ON p.id = o.product_id
                   WHERE m.courier_id = p_actor AND m.status = 'offered'), '[]'::jsonb);
END $$;

-- Livreur : accepte. La commande est affectée par le mécanisme existant ; une seule acceptation est possible.
CREATE FUNCTION fn_courier_accept_offer(p_actor uuid, p_offer uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m mission_offers; o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  SELECT * INTO m FROM mission_offers WHERE id = p_offer AND courier_id = p_actor;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Proposition introuvable'); END IF;
  SELECT * INTO o FROM orders WHERE id = m.order_id FOR UPDATE;
  SELECT * INTO m FROM mission_offers WHERE id = p_offer FOR UPDATE;
  PERFORM _expire_offers();
  SELECT * INTO m FROM mission_offers WHERE id = p_offer;
  IF m.status = 'expired' THEN PERFORM _err('offer_expired', 'Le délai de réponse est dépassé'); END IF;
  IF m.status <> 'offered' THEN PERFORM _err('offer_unavailable', 'Cette proposition n''est plus disponible'); END IF;
  PERFORM fn_chief_assign(m.offered_by, m.order_id, p_actor);
  UPDATE mission_offers SET status = 'accepted', responded_at = now() WHERE id = m.id;
  PERFORM _audit(p_actor, 'mission_accepted', 'order', m.order_id::text, jsonb_build_object('offer', m.id));
END $$;

-- Livreur : refuse, avec un motif facultatif parmi une liste. Aucune pénalité financière.
CREATE FUNCTION fn_courier_refuse_offer(p_actor uuid, p_offer uuid, p_reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m mission_offers;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  IF p_reason IS NOT NULL AND p_reason NOT IN ('too_far', 'busy', 'vehicle', 'other') THEN PERFORM _err('invalid_input', 'Motif invalide'); END IF;
  PERFORM _expire_offers();
  UPDATE mission_offers SET status = 'refused', refuse_reason = p_reason, responded_at = now()
   WHERE id = p_offer AND courier_id = p_actor AND status = 'offered' RETURNING * INTO m;
  IF NOT FOUND THEN PERFORM _err('offer_unavailable', 'Cette proposition n''est plus disponible'); END IF;
  PERFORM _audit(p_actor, 'mission_refused', 'order', m.order_id::text, jsonb_build_object('offer', m.id, 'reason', p_reason));
END $$;

-- Chef ou administrateur : propositions ouvertes et nombre de propositions déjà faites par commande
CREATE FUNCTION fn_chief_offers(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _expire_offers();
  RETURN jsonb_build_object(
    'open', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'order_id', m.order_id, 'courier_id', m.courier_id, 'courier_name', u.full_name, 'expires_at', m.expires_at) ORDER BY m.expires_at)
                        FROM mission_offers m JOIN users u ON u.id = m.courier_id WHERE m.status = 'offered'), '[]'::jsonb),
    'counts', COALESCE((SELECT jsonb_object_agg(order_id::text, n) FROM (SELECT order_id, count(*)::int AS n FROM mission_offers GROUP BY order_id) c), '{}'::jsonb),
    'max_offers', GREATEST(1, _setting('mission_max_offers')));
END $$;

-- Remise à zéro de l'activité : les propositions référencent les commandes, elles sont vidées avec elles (reste identique à la 017)
CREATE OR REPLACE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 order_history, calls, risky_customers, sheet_imports, order_requests, mission_offers, orders, arrivals, seller_stock, messages, one_time_codes, proofs
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
