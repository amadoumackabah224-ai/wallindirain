-- 036 : accords individuels de rémunération. Chaque compte peut avoir ses propres conditions, conclues avec la personne : activées par l'administrateur,
-- datées, jamais rétroactives, historique conservé. Livreur (indépendant ou de Wallindirain) : paie par livraison, supplément de tournée, déplacement à vide, prime.
-- Agent / chef d'équipe : rémunération par commande confirmée et livrée. Sans accord, les règles communes continuent de s'appliquer. Aucun accord n'est créé par la migration.

ALTER TABLE courier_pay_scales ADD COLUMN courier_id uuid REFERENCES users(id);   -- NULL = barème commun des livreurs Wallindirain ; sinon accord individuel de ce livreur
CREATE INDEX courier_pay_scales_courier_idx ON courier_pay_scales(courier_id, effective_from DESC) WHERE courier_id IS NOT NULL;

CREATE TABLE agent_terms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES users(id),
  pay_per_order  bigint CHECK (pay_per_order IS NULL OR pay_per_order >= 0),   -- NULL = fin de l'accord : retour à la rémunération commune
  effective_from timestamptz NOT NULL,
  note           text CHECK (note IS NULL OR length(note) <= 200),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_terms_idx ON agent_terms(agent_id, effective_from DESC);
CREATE TRIGGER agent_terms_immutable BEFORE UPDATE OR DELETE ON agent_terms FOR EACH ROW EXECUTE FUNCTION trg_append_only();

CREATE OR REPLACE FUNCTION _company_scale() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN per_delivery > 0 THEN id END FROM courier_pay_scales WHERE courier_id IS NULL AND effective_from <= now() ORDER BY effective_from DESC, created_at DESC LIMIT 1
$$;

-- Barème retenu pour un livreur à l'affectation : son accord individuel s'il en a un en vigueur (indépendant ou Wallindirain), sinon le barème commun des livreurs de Wallindirain
CREATE FUNCTION _courier_scale(p_courier uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE r record;
BEGIN
  SELECT id, per_delivery INTO r FROM courier_pay_scales WHERE courier_id = p_courier AND effective_from <= now() ORDER BY effective_from DESC, created_at DESC LIMIT 1;
  IF FOUND AND r.per_delivery > 0 THEN RETURN r.id; END IF;
  IF _courier_kind(p_courier) = 'company' THEN RETURN _company_scale(); END IF;
  RETURN NULL;     -- indépendant sans accord : règles communes des indépendants
END $$;

-- Rémunération de l'agent pour une commande livrée : son accord en vigueur au moment de la confirmation, sinon le montant figé à la commande
CREATE FUNCTION _agent_pay_for(o orders) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE r record;
BEGIN
  SELECT pay_per_order INTO r FROM agent_terms WHERE agent_id = o.confirmed_by AND effective_from <= COALESCE(o.confirmed_at, now()) ORDER BY effective_from DESC, created_at DESC LIMIT 1;
  IF FOUND AND r.pay_per_order IS NOT NULL THEN RETURN r.pay_per_order; END IF;
  RETURN o.agent_pay;
END $$;

CREATE OR REPLACE FUNCTION _courier_pay_quote(o orders, p_courier uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN _courier_scale(p_courier) IS NOT NULL
              THEN LEAST((SELECT per_delivery FROM courier_pay_scales WHERE id = _courier_scale(p_courier)), o.delivery_fee) ELSE o.courier_pay END
$$;

CREATE OR REPLACE FUNCTION fn_chief_assign(p_actor uuid, p_order uuid, p_courier uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief','admin']::user_role[]);
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_courier AND role = 'courier' AND status = 'active' AND deleted_at IS NULL) THEN
    PERFORM _err('not_found', 'Livreur actif introuvable');
  END IF;
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status NOT IN ('confirmed','failed','assigned') THEN
    PERFORM _err('invalid_state', 'Seules les commandes confirmées ou en échec peuvent être affectées');
  END IF;
  UPDATE orders SET status = 'assigned', courier_id = p_courier, assigned_by = p_actor,
                    failure_reason = NULL, code_attempts = 0,
                    courier_kind = _courier_kind(p_courier),
                    courier_scale_id = _courier_scale(p_courier)
   WHERE id = o.id;
  PERFORM _log_status(o.id, o.status, 'assigned', p_actor, 'Affectée');
END $$;

CREATE OR REPLACE FUNCTION _settle_delivery(o orders) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_avail timestamptz := now() + make_interval(hours => o.unlock_hours);
  v_sup bigint := o.supplier_unit_price * o.qty;
  v_margin bigint := o.margin_unit * o.qty;
  v_prepaid bigint := o.qty_from_seller * o.seller_unit_price;
  v_due_a bigint := o.qty_from_catalog * o.seller_unit_price;
  v_gain bigint; v_gross bigint; v_supplier uuid; v_pay bigint; v_sc courier_pay_scales; v_n int; v_agent bigint;
BEGIN
  v_gain  := o.sale_total - o.delivery_fee - o.call_fee - o.platform_fee - v_due_a;
  v_gross := o.delivery_fee + o.call_fee + o.platform_fee + v_margin;
  IF v_gain < 0 OR v_sup + v_gain + v_gross <> o.sale_total + v_prepaid THEN
    PERFORM _err('ledger_mismatch', 'Incohérence comptable détectée : livraison annulée');
  END IF;
  PERFORM _wallet_add(o.seller_id, 'seller_gain', v_gain, o.id, v_avail, 'Commande ' || o.ref);
  IF o.product_id IS NOT NULL THEN
    SELECT supplier_id INTO v_supplier FROM products WHERE id = o.product_id;
    PERFORM _wallet_add(v_supplier, 'supplier_payment', v_sup, o.id, v_avail, 'Commande ' || o.ref);
  END IF;
  PERFORM _wallet_add(_platform(), 'platform_revenue', v_gross, o.id, now(), 'Livraison + call center + frais + marge ' || o.ref);
  PERFORM _wallet_add(_float(), 'float_release', -v_prepaid, o.id, now(), 'Stock prépayé libéré ' || o.ref);
  -- paie du livreur : le barème retenu à l'AFFECTATION (livreur de Wallindirain) ou la paie figée à la commande (indépendant, comme avant)
  v_pay := _order_pay(o);
  UPDATE orders SET courier_pay_paid = v_pay WHERE id = o.id;
  PERFORM _wallet_add(o.courier_id, 'team_pay', v_pay, o.id, now(), 'Livraison ' || o.ref);
  PERFORM _wallet_add(_platform(), 'team_pay', -v_pay, o.id, now(), 'Livreur ' || o.ref);
  -- prime du jour (barème Wallindirain, 0 = aucune) : une seule fois par jour et par livreur
  IF o.courier_scale_id IS NOT NULL THEN
    SELECT * INTO v_sc FROM courier_pay_scales WHERE id = o.courier_scale_id;
    IF v_sc.prime_threshold > 0 THEN
      PERFORM pg_advisory_xact_lock(hashtext('prime:' || o.courier_id::text));
      SELECT count(*) INTO v_n FROM orders WHERE courier_id = o.courier_id AND status = 'delivered' AND courier_scale_id IS NOT NULL AND delivered_at >= date_trunc('day', now());
      IF v_n >= v_sc.prime_threshold AND NOT EXISTS (SELECT 1 FROM wallet_entries WHERE user_id = o.courier_id AND kind = 'courier_prime' AND amount > 0 AND created_at >= date_trunc('day', now())) THEN
        PERFORM _wallet_add(o.courier_id, 'courier_prime', v_sc.prime_amount, o.id, now(), 'Prime du jour ' || o.ref);
        PERFORM _wallet_add(_platform(), 'courier_prime', -v_sc.prime_amount, o.id, now(), 'Prime livreur ' || o.ref);
      END IF;
    END IF;
  END IF;
  -- 034 : rémunération de l'agent qui a confirmé la commande, versée seulement à la livraison (une seule fois ; ignorée si déjà versée avant 034)
  v_agent := _agent_pay_for(o);
  IF o.confirmed_by IS NOT NULL AND v_agent > 0
     AND NOT EXISTS (SELECT 1 FROM wallet_entries WHERE order_id = o.id AND user_id = o.confirmed_by AND kind = 'team_pay') THEN
    PERFORM _wallet_add(o.confirmed_by, 'team_pay', v_agent, o.id, now(), 'Commande ' || o.ref || ' confirmée et livrée');
    PERFORM _wallet_add(_platform(), 'team_pay', -v_agent, o.id, now(), 'Agent ' || o.ref);
  END IF;
  INSERT INTO courier_cash_entries(courier_id, order_id, amount) VALUES (o.courier_id, o.id, o.sale_total);
END $$;

-- ---------- Administrateur : accord individuel d'un livreur (indépendant ou de Wallindirain) ----------
CREATE FUNCTION fn_admin_set_courier_agreement(p_actor uuid, p_courier uuid, p_per_delivery bigint, p_tour_extra bigint, p_failed_trip bigint, p_prime_threshold int, p_prime_amount bigint,
                                               p_effective_from timestamptz DEFAULT NULL, p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_eff timestamptz; v_min_fee bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  PERFORM _courier_exists(p_courier);
  IF p_per_delivery IS NULL OR p_per_delivery <= 0 THEN PERFORM _err('invalid_input', 'Indiquez la paie par livraison de l''accord'); END IF;
  IF COALESCE(p_tour_extra, 0) < 0 OR COALESCE(p_failed_trip, 0) < 0 OR COALESCE(p_prime_threshold, 0) < 0 OR COALESCE(p_prime_amount, 0) < 0 THEN PERFORM _err('invalid_input', 'Valeurs invalides (aucun montant négatif)'); END IF;
  p_tour_extra := COALESCE(p_tour_extra, 0); p_failed_trip := COALESCE(p_failed_trip, 0); p_prime_threshold := COALESCE(p_prime_threshold, 0); p_prime_amount := COALESCE(p_prime_amount, 0);
  IF p_prime_threshold > 50 THEN PERFORM _err('invalid_input', 'Seuil de la prime invalide (50 livraisons au maximum)'); END IF;
  IF (p_prime_threshold = 0) <> (p_prime_amount = 0) THEN PERFORM _err('invalid_input', 'Prime : indiquez à la fois le nombre de livraisons et le montant (ou les deux à 0)'); END IF;
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères)'); END IF;
  v_eff := COALESCE(p_effective_from, now());
  IF v_eff < now() - interval '5 minutes' THEN PERFORM _err('invalid_input', 'La date d''entrée en vigueur ne peut pas être dans le passé'); END IF;
  SELECT min(fee) INTO v_min_fee FROM delivery_rates WHERE active;
  IF v_min_fee IS NOT NULL AND (p_per_delivery > v_min_fee OR p_failed_trip > v_min_fee) THEN
    PERFORM _err('courier_pay_exceeds_fee', 'Accord refusé : un montant dépasse le tarif de la zone active la moins chère (' || v_min_fee || ' GNF)');
  END IF;
  INSERT INTO courier_pay_scales(id, courier_id, per_delivery, tour_extra, failed_trip, prime_threshold, prime_amount, effective_from, note, created_by)
  VALUES (v_id, p_courier, p_per_delivery, p_tour_extra, p_failed_trip, p_prime_threshold, p_prime_amount, v_eff, NULLIF(trim(COALESCE(p_note, '')), ''), p_actor);
  PERFORM _audit(p_actor, 'courier_agreement_set', 'courier', p_courier::text,
                 jsonb_build_object('per_delivery', p_per_delivery, 'tour_extra', p_tour_extra, 'failed_trip', p_failed_trip, 'prime_threshold', p_prime_threshold, 'prime_amount', p_prime_amount, 'effective_from', v_eff));
  RETURN v_id;
END $$;

CREATE FUNCTION fn_admin_end_courier_agreement(p_actor uuid, p_courier uuid, p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  PERFORM _courier_exists(p_courier);
  IF NOT EXISTS (SELECT 1 FROM courier_pay_scales WHERE courier_id = p_courier AND per_delivery > 0) THEN PERFORM _err('invalid_state', 'Ce livreur n''a pas d''accord individuel'); END IF;
  IF (SELECT per_delivery FROM courier_pay_scales WHERE courier_id = p_courier AND effective_from <= now() ORDER BY effective_from DESC, created_at DESC LIMIT 1) IS NOT DISTINCT FROM 0 THEN
    PERFORM _err('invalid_state', 'Aucun accord individuel en vigueur');
  END IF;
  INSERT INTO courier_pay_scales(id, courier_id, per_delivery, effective_from, note, created_by) VALUES (v_id, p_courier, 0, now(), NULLIF(trim(COALESCE(p_note, '')), ''), p_actor);
  PERFORM _audit(p_actor, 'courier_agreement_ended', 'courier', p_courier::text);
  RETURN v_id;
END $$;

-- ---------- Administrateur : accord individuel d'un agent ou d'un chef d'équipe ----------
CREATE FUNCTION fn_admin_set_agent_agreement(p_actor uuid, p_agent uuid, p_pay bigint, p_effective_from timestamptz DEFAULT NULL, p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_eff timestamptz;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_agent AND role IN ('agent','call_chief') AND deleted_at IS NULL) THEN PERFORM _err('not_found', 'Agent introuvable'); END IF;
  IF p_pay IS NULL OR p_pay < 0 OR p_pay > 1000000 THEN PERFORM _err('invalid_input', 'Rémunération invalide'); END IF;
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères)'); END IF;
  v_eff := COALESCE(p_effective_from, now());
  IF v_eff < now() - interval '5 minutes' THEN PERFORM _err('invalid_input', 'La date d''entrée en vigueur ne peut pas être dans le passé'); END IF;
  INSERT INTO agent_terms(id, agent_id, pay_per_order, effective_from, note, created_by) VALUES (v_id, p_agent, p_pay, v_eff, NULLIF(trim(COALESCE(p_note, '')), ''), p_actor);
  PERFORM _audit(p_actor, 'agent_agreement_set', 'user', p_agent::text, jsonb_build_object('pay', p_pay, 'effective_from', v_eff));
  RETURN v_id;
END $$;

CREATE FUNCTION fn_admin_end_agent_agreement(p_actor uuid, p_agent uuid, p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF (SELECT pay_per_order FROM agent_terms WHERE agent_id = p_agent AND effective_from <= now() ORDER BY effective_from DESC, created_at DESC LIMIT 1) IS NULL THEN
    PERFORM _err('invalid_state', 'Aucun accord individuel en vigueur');
  END IF;
  INSERT INTO agent_terms(id, agent_id, pay_per_order, effective_from, note, created_by) VALUES (v_id, p_agent, NULL, now(), NULLIF(trim(COALESCE(p_note, '')), ''), p_actor);
  PERFORM _audit(p_actor, 'agent_agreement_ended', 'user', p_agent::text);
  RETURN v_id;
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
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
