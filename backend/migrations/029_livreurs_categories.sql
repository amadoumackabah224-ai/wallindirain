-- 029 : deux catégories de livreurs — « indépendant » (sa propre moto, règles actuelles inchangées) et « de Wallindirain » (moto de l'entreprise, barème séparé).
--
-- SÉCURITÉ FINANCIÈRE
--  * Tant qu'AUCUN barème Wallindirain n'est enregistré (ou si le dernier a une paie par livraison de 0), tous les livreurs sont payés EXACTEMENT comme avant.
--  * Aucun montant n'est enregistré par cette migration. L'administrateur saisit le barème ensuite (réglages), avec une date d'entrée en vigueur.
--  * La catégorie et le barème sont RETENUS À L'AFFECTATION de chaque commande (colonnes de la commande) : un changement de catégorie ou de barème ne touche jamais une mission déjà affectée,
--    ni une commande déjà livrée (la paie versée est aussi enregistrée sur la commande).
--  * Les barèmes et l'historique des catégories sont en ajout seulement (jamais modifiés ni effacés).
--  * Les charges de la moto (carburant, entretien…) sont un JOURNAL de l'administrateur : elles ne touchent pas le portefeuille du livreur.

-- ---------- Catégorie du livreur, avec historique ----------
CREATE TABLE courier_kind_log (
  id             bigserial PRIMARY KEY,
  courier_id     uuid NOT NULL REFERENCES users(id),
  kind           text NOT NULL CHECK (kind IN ('independent', 'company')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  set_by         uuid REFERENCES users(id),
  note           text CHECK (note IS NULL OR length(note) <= 200),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courier_kind_log_courier_idx ON courier_kind_log(courier_id, id DESC);
CREATE TRIGGER courier_kind_log_immutable BEFORE UPDATE OR DELETE ON courier_kind_log FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- ---------- Barème des livreurs de Wallindirain (une ligne par version, jamais modifiée) ----------
CREATE TABLE courier_pay_scales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  per_delivery    bigint  NOT NULL CHECK (per_delivery >= 0),          -- paie fixe par livraison réussie (0 = pas de barème : règles communes)
  tour_extra      bigint  NOT NULL DEFAULT 0 CHECK (tour_extra >= 0),  -- supplément pour chaque livraison à partir de la 2e d'une tournée
  failed_trip     bigint  NOT NULL DEFAULT 0 CHECK (failed_trip >= 0), -- indemnité de déplacement à vide (livraison non aboutie)
  prime_threshold integer NOT NULL DEFAULT 0 CHECK (prime_threshold BETWEEN 0 AND 50),
  prime_amount    bigint  NOT NULL DEFAULT 0 CHECK (prime_amount >= 0),
  effective_from  timestamptz NOT NULL,
  note            text CHECK (note IS NULL OR length(note) <= 200),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((prime_threshold = 0) = (prime_amount = 0))
);
CREATE INDEX courier_pay_scales_eff_idx ON courier_pay_scales(effective_from DESC, created_at DESC);
CREATE TRIGGER courier_pay_scales_immutable BEFORE UPDATE OR DELETE ON courier_pay_scales FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- ---------- Charges de la moto prises en charge par l'entreprise (journal, hors portefeuille) ----------
CREATE TABLE courier_expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_id  uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('fuel', 'maintenance', 'repair', 'insurance', 'other')),
  amount      bigint NOT NULL CHECK (amount > 0),
  spent_on    date NOT NULL DEFAULT current_date,
  note        text CHECK (note IS NULL OR length(note) <= 200),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  voided_at   timestamptz,
  voided_by   uuid REFERENCES users(id),
  void_reason text CHECK (void_reason IS NULL OR length(void_reason) <= 200)
);
CREATE INDEX courier_expenses_courier_idx ON courier_expenses(courier_id, spent_on DESC);

-- ---------- Retenu à l'affectation, enregistré sur la commande ----------
ALTER TABLE orders ADD COLUMN courier_kind text CHECK (courier_kind IS NULL OR courier_kind IN ('independent', 'company'));
ALTER TABLE orders ADD COLUMN courier_scale_id uuid REFERENCES courier_pay_scales(id);
ALTER TABLE orders ADD COLUMN courier_pay_paid bigint CHECK (courier_pay_paid IS NULL OR courier_pay_paid >= 0);

CREATE UNIQUE INDEX wallet_failed_trip_once_uq ON wallet_entries (order_id, user_id, kind) WHERE kind = 'failed_trip' AND amount > 0 AND order_id IS NOT NULL;
CREATE UNIQUE INDEX wallet_courier_prime_once_uq ON wallet_entries (order_id, user_id, kind) WHERE kind = 'courier_prime' AND amount > 0 AND order_id IS NOT NULL;

-- ---------- Fonctions internes ----------
-- Catégorie actuelle (indépendant si aucune ligne)
CREATE FUNCTION _courier_kind(p_courier uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT kind FROM courier_kind_log WHERE courier_id = p_courier AND effective_from <= now() ORDER BY id DESC LIMIT 1), 'independent')
$$;

-- Barème Wallindirain en vigueur maintenant (NULL = aucun : règles communes). La dernière version en vigueur l'emporte ; une version à 0 revient aux règles communes.
CREATE FUNCTION _company_scale() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN per_delivery > 0 THEN id END FROM courier_pay_scales WHERE effective_from <= now() ORDER BY effective_from DESC, created_at DESC LIMIT 1
$$;

-- Paie d'une commande : versée si livrée ; sinon celle du barème retenu à l'affectation ; sinon la paie figée à la commande
CREATE FUNCTION _order_pay(o orders) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COALESCE(o.courier_pay_paid,
                  CASE WHEN o.courier_scale_id IS NOT NULL THEN LEAST((SELECT per_delivery FROM courier_pay_scales WHERE id = o.courier_scale_id), o.delivery_fee) ELSE o.courier_pay END)
$$;

-- Paie annoncée à un livreur avant d'accepter (pas encore affectée) : selon sa catégorie du moment
CREATE FUNCTION _courier_pay_quote(o orders, p_courier uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN _courier_kind(p_courier) = 'company' AND _company_scale() IS NOT NULL
              THEN LEAST((SELECT per_delivery FROM courier_pay_scales WHERE id = _company_scale()), o.delivery_fee) ELSE o.courier_pay END
$$;

-- ---------- Administrateur : changer la catégorie d'un livreur ----------
CREATE FUNCTION fn_admin_set_courier_kind(p_actor uuid, p_courier uuid, p_kind text, p_note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_cur text;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_kind IS NULL OR p_kind NOT IN ('independent', 'company') THEN PERFORM _err('invalid_input', 'Catégorie de livreur invalide'); END IF;
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères)'); END IF;
  PERFORM _courier_exists(p_courier);
  PERFORM pg_advisory_xact_lock(hashtext('courierkind:' || p_courier::text));
  v_cur := _courier_kind(p_courier);
  IF v_cur = p_kind THEN PERFORM _err('invalid_state', 'Ce livreur est déjà dans cette catégorie'); END IF;
  PERFORM _expire_offers();
  IF EXISTS (SELECT 1 FROM orders WHERE courier_id = p_courier AND status IN ('assigned', 'picked_up', 'on_the_way'))
     OR EXISTS (SELECT 1 FROM mission_offers WHERE courier_id = p_courier AND status = 'offered')
     OR EXISTS (SELECT 1 FROM tours WHERE courier_id = p_courier AND status IN ('proposed', 'active')) THEN
    PERFORM _err('courier_busy', 'Changement impossible : ce livreur a des missions, des propositions ou une tournée en cours. Attendez la fin ou retirez-les.');
  END IF;
  INSERT INTO courier_kind_log(courier_id, kind, set_by, note) VALUES (p_courier, p_kind, p_actor, NULLIF(trim(COALESCE(p_note, '')), ''));
  PERFORM _audit(p_actor, 'courier_kind_changed', 'courier', p_courier::text, jsonb_build_object('from', v_cur, 'to', p_kind));
END $$;

-- ---------- Administrateur : nouvelle version du barème Wallindirain (jamais rétroactive) ----------
CREATE FUNCTION fn_admin_set_company_scale(p_actor uuid, p_per_delivery bigint, p_tour_extra bigint, p_failed_trip bigint, p_prime_threshold int, p_prime_amount bigint,
                                           p_effective_from timestamptz DEFAULT NULL, p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_eff timestamptz; v_min_fee bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_per_delivery IS NULL OR p_tour_extra IS NULL OR p_failed_trip IS NULL OR p_prime_threshold IS NULL OR p_prime_amount IS NULL
     OR p_per_delivery < 0 OR p_tour_extra < 0 OR p_failed_trip < 0 OR p_prime_threshold < 0 OR p_prime_amount < 0 THEN
    PERFORM _err('invalid_input', 'Valeurs invalides (aucun montant négatif)');
  END IF;
  IF p_prime_threshold > 50 THEN PERFORM _err('invalid_input', 'Seuil de la prime invalide (50 livraisons au maximum)'); END IF;
  IF (p_prime_threshold = 0) <> (p_prime_amount = 0) THEN PERFORM _err('invalid_input', 'Prime : indiquez à la fois le nombre de livraisons et le montant (ou les deux à 0)'); END IF;
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères)'); END IF;
  v_eff := COALESCE(p_effective_from, now());
  IF v_eff < now() - interval '5 minutes' THEN PERFORM _err('invalid_input', 'La date d''entrée en vigueur ne peut pas être dans le passé : un barème ne s''applique jamais aux anciennes missions'); END IF;
  SELECT min(fee) INTO v_min_fee FROM delivery_rates WHERE active;
  IF v_min_fee IS NOT NULL AND (p_per_delivery > v_min_fee OR p_failed_trip > v_min_fee) THEN
    PERFORM _err('courier_pay_exceeds_fee', 'Barème refusé : un montant dépasse le tarif de la zone active la moins chère (' || v_min_fee || ' GNF)');
  END IF;
  INSERT INTO courier_pay_scales(id, per_delivery, tour_extra, failed_trip, prime_threshold, prime_amount, effective_from, note, created_by)
  VALUES (v_id, p_per_delivery, p_tour_extra, p_failed_trip, p_prime_threshold, p_prime_amount, v_eff, NULLIF(trim(COALESCE(p_note, '')), ''), p_actor);
  PERFORM _audit(p_actor, 'courier_scale_set', 'courier_scale', v_id::text,
                 jsonb_build_object('per_delivery', p_per_delivery, 'tour_extra', p_tour_extra, 'failed_trip', p_failed_trip, 'prime_threshold', p_prime_threshold, 'prime_amount', p_prime_amount, 'effective_from', v_eff));
  RETURN v_id;
END $$;

-- ---------- Administrateur : charges de la moto (journal) ----------
CREATE FUNCTION fn_admin_add_courier_expense(p_actor uuid, p_courier uuid, p_kind text, p_amount bigint, p_spent_on date DEFAULT NULL, p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  PERFORM _courier_exists(p_courier);
  IF p_kind IS NULL OR p_kind NOT IN ('fuel', 'maintenance', 'repair', 'insurance', 'other') THEN PERFORM _err('invalid_input', 'Type de charge invalide'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN PERFORM _err('invalid_input', 'Montant invalide'); END IF;
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères)'); END IF;
  IF p_spent_on IS NOT NULL AND (p_spent_on > current_date OR p_spent_on < current_date - 366) THEN PERFORM _err('invalid_input', 'Date invalide'); END IF;
  INSERT INTO courier_expenses(id, courier_id, kind, amount, spent_on, note, created_by)
  VALUES (v_id, p_courier, p_kind, p_amount, COALESCE(p_spent_on, current_date), NULLIF(trim(COALESCE(p_note, '')), ''), p_actor);
  PERFORM _audit(p_actor, 'courier_expense_added', 'courier', p_courier::text, jsonb_build_object('id', v_id, 'kind', p_kind, 'amount', p_amount));
  RETURN v_id;
END $$;

-- Une charge saisie par erreur est ANNULÉE (motif obligatoire), jamais effacée
CREATE FUNCTION fn_admin_void_courier_expense(p_actor uuid, p_expense uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e courier_expenses;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 OR length(p_reason) > 200 THEN PERFORM _err('invalid_input', 'Motif obligatoire (3 à 200 caractères)'); END IF;
  UPDATE courier_expenses SET voided_at = now(), voided_by = p_actor, void_reason = trim(p_reason) WHERE id = p_expense AND voided_at IS NULL RETURNING * INTO e;
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Charge introuvable ou déjà annulée'); END IF;
  PERFORM _audit(p_actor, 'courier_expense_voided', 'courier', e.courier_id::text, jsonb_build_object('id', e.id, 'amount', e.amount));
END $$;

-- ---------- Fonctions existantes : seules les lignes marquées changent (paie lue selon le barème retenu à l'affectation) ----------
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
                    courier_scale_id = CASE WHEN _courier_kind(p_courier) = 'company' THEN _company_scale() END
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
  v_gain bigint; v_gross bigint; v_supplier uuid; v_pay bigint; v_sc courier_pay_scales; v_n int;
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
  INSERT INTO courier_cash_entries(courier_id, order_id, amount) VALUES (o.courier_id, o.id, o.sale_total);
END $$;

CREATE OR REPLACE FUNCTION fn_courier_fail(p_actor uuid, p_order uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders; v_ft bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  IF p_reason NOT IN ('customer_absent','customer_refusal','address_not_found','other') THEN
    PERFORM _err('invalid_input', 'Motif d''échec invalide');
  END IF;
  UPDATE orders SET status = 'failed', failure_reason = p_reason
   WHERE id = p_order AND courier_id = p_actor AND status IN ('assigned','picked_up','on_the_way')
  RETURNING * INTO o;
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Commande introuvable ou non en cours de livraison'); END IF;
  PERFORM _log_status(o.id, NULL, 'failed', p_actor, p_reason);
  -- indemnité de déplacement à vide (barème Wallindirain, 0 = aucune) : une seule fois par commande et par livreur
  IF o.courier_scale_id IS NOT NULL THEN
    SELECT failed_trip INTO v_ft FROM courier_pay_scales WHERE id = o.courier_scale_id;
    IF v_ft > 0 AND NOT EXISTS (SELECT 1 FROM wallet_entries WHERE order_id = o.id AND user_id = p_actor AND kind = 'failed_trip' AND amount > 0) THEN
      PERFORM _wallet_add(p_actor, 'failed_trip', v_ft, o.id, now(), 'Déplacement à vide ' || o.ref);
      PERFORM _wallet_add(_platform(), 'failed_trip', -v_ft, o.id, now(), 'Déplacement à vide livreur ' || o.ref);
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION _tour_plan(p_tour uuid) RETURNS TABLE(order_id uuid, plan_pay bigint) LANGUAGE sql STABLE AS $$
  SELECT q.order_id, CASE WHEN q.scale_id IS NOT NULL
      THEN LEAST(q.fee, (SELECT per_delivery FROM courier_pay_scales WHERE id = q.scale_id) + CASE WHEN q.rn > 1 THEN (SELECT tour_extra FROM courier_pay_scales WHERE id = q.scale_id) ELSE 0 END)
      ELSE _tour_target_pay(t.pay_mode, t.mode_bps, q.rn, q.fee, q.base) END
    FROM tours t JOIN (SELECT s.tour_id, o.id AS order_id, o.delivery_fee AS fee, o.courier_pay AS base, o.courier_scale_id AS scale_id,
                              row_number() OVER (ORDER BY s.position) AS rn
                         FROM tour_stops s JOIN orders o ON o.id = s.order_id
                        WHERE s.tour_id = p_tour AND (s.active OR o.status = 'delivered')) q ON q.tour_id = t.id
   WHERE t.id = p_tour
$$;

CREATE OR REPLACE FUNCTION _tour_pay_bonus(p_tour uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t tours; v_n int; v_margin bigint; v_amount bigint; v_anchor uuid; v_base bigint; v_target bigint;
BEGIN
  SELECT * INTO t FROM tours WHERE id = p_tour FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  -- livreur de Wallindirain : supplément de tournée du barème retenu à l'affectation (pour chaque livraison à partir de la 2e), écrit une seule fois
  IF EXISTS (SELECT 1 FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered' AND o.courier_id = t.courier_id AND o.courier_scale_id IS NOT NULL) THEN
    IF t.bonus_paid IS NOT NULL THEN RETURN; END IF;
    SELECT count(*), COALESCE(sum(LEAST(sc.tour_extra, GREATEST(d.fee - COALESCE(d.paid, d.base), 0))) FILTER (WHERE d.rn > 1), 0) INTO v_n, v_amount
      FROM (SELECT o.delivery_fee AS fee, o.courier_pay_paid AS paid, o.courier_pay AS base, o.courier_scale_id AS sid, row_number() OVER (ORDER BY s.position) AS rn
              FROM tour_stops s JOIN orders o ON o.id = s.order_id
             WHERE s.tour_id = t.id AND o.status = 'delivered' AND o.courier_id = t.courier_id AND o.courier_scale_id IS NOT NULL) d
      JOIN courier_pay_scales sc ON sc.id = d.sid;
    IF v_n < 2 OR v_amount <= 0 THEN RETURN; END IF;
    SELECT o.id INTO v_anchor FROM tour_stops s JOIN orders o ON o.id = s.order_id
     WHERE s.tour_id = t.id AND o.status = 'delivered' AND o.courier_id = t.courier_id ORDER BY o.delivered_at DESC, o.id LIMIT 1;
    UPDATE tours SET bonus_paid = v_amount WHERE id = t.id AND bonus_paid IS NULL;
    PERFORM _wallet_add(t.courier_id, 'tour_bonus', v_amount, v_anchor, now(), 'Supplément de tournée');
    PERFORM _wallet_add(_platform(), 'tour_bonus', -v_amount, v_anchor, now(), 'Supplément de tournée livreur');
    RETURN;
  END IF;
  IF t.pay_mode = 'normal' THEN
    IF t.bonus_paid IS NOT NULL OR t.bonus_per_extra <= 0 THEN RETURN; END IF;
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
    RETURN;
  END IF;
  IF t.adjust_paid IS NOT NULL THEN RETURN; END IF;
  SELECT count(*), COALESCE(sum(d.base), 0), COALESCE(sum(_tour_target_pay(t.pay_mode, t.mode_bps, d.rn, d.fee, d.base)), 0)
    INTO v_n, v_base, v_target
    FROM (SELECT o.delivery_fee AS fee, o.courier_pay AS base, row_number() OVER (ORDER BY s.position) AS rn
            FROM tour_stops s JOIN orders o ON o.id = s.order_id
           WHERE s.tour_id = t.id AND o.status = 'delivered' AND o.courier_id = t.courier_id) d;
  IF v_n < 2 THEN RETURN; END IF;                                                                  -- une seule livraison : pas de tournée groupée, paie habituelle
  v_amount := v_target - v_base;
  IF v_amount = 0 THEN RETURN; END IF;
  SELECT o.id INTO v_anchor FROM tour_stops s JOIN orders o ON o.id = s.order_id
   WHERE s.tour_id = t.id AND o.status = 'delivered' AND o.courier_id = t.courier_id ORDER BY o.delivered_at DESC, o.id LIMIT 1;
  UPDATE tours SET adjust_paid = v_amount WHERE id = t.id AND adjust_paid IS NULL;
  PERFORM _wallet_add(t.courier_id, 'tour_adjust', v_amount, v_anchor, now(), 'Ajustement de tournée (' || CASE t.pay_mode WHEN 'share' THEN 'mode A' ELSE 'mode B' END || ')');
  PERFORM _wallet_add(_platform(), 'tour_adjust', -v_amount, v_anchor, now(), 'Ajustement de tournée livreur');
END $$;

CREATE OR REPLACE FUNCTION fn_chief_create_tour(p_actor uuid, p_courier uuid, p_orders uuid[], p_note text DEFAULT NULL, p_mode text DEFAULT 'normal') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_ids uuid[]; v_id uuid := gen_random_uuid(); o orders; i int; v_pos int := 0; r record; v_bonus bigint := CASE WHEN p_mode = 'normal' AND _courier_kind(p_courier) <> 'company' THEN _setting('tour_bonus_per_extra_order') ELSE 0 END; v_pay bigint; v_fee bigint; v_bps integer := 0;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_courier AND role = 'courier' AND status = 'active' AND deleted_at IS NULL) THEN
    PERFORM _err('not_found', 'Livreur actif introuvable');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('normal', 'share', 'split') THEN PERFORM _err('invalid_input', 'Mode de paie de tournée inconnu'); END IF;
  IF p_mode <> 'normal' AND _courier_kind(p_courier) = 'company' THEN
    PERFORM _err('invalid_input', 'Ce livreur est payé selon le barème de Wallindirain : les modes A et B ne s''appliquent pas (choisissez le mode normal)');
  END IF;
  IF p_mode = 'share' THEN v_bps := _setting('tour_share_bps'); ELSIF p_mode = 'split' THEN v_bps := _setting('tour_extra_share_bps'); END IF;
  IF p_mode <> 'normal' AND v_bps NOT BETWEEN 1 AND 9000 THEN
    PERFORM _err('invalid_input', 'Ce mode de paie n''est pas réglé : l''administrateur doit saisir un pourcentage entre 1 et 9000 (réglages)');
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
  INSERT INTO tours(id, courier_id, created_by, note, status, bonus_per_extra, pay_mode, mode_bps) VALUES (v_id, p_courier, p_actor, NULLIF(trim(COALESCE(p_note, '')), ''), 'proposed', v_bonus, p_mode, v_bps);
  FOR i IN 1 .. cardinality(p_orders) LOOP
    SELECT * INTO o FROM orders WHERE id = p_orders[i];
    IF o.status <> 'assigned' THEN PERFORM fn_chief_assign(p_actor, o.id, p_courier); END IF;
    v_pos := v_pos + 1;
    INSERT INTO tour_stops(tour_id, order_id, position) VALUES (v_id, o.id, v_pos);
  END LOOP;
  PERFORM _audit(p_actor, 'tour_created', 'tour', v_id::text, jsonb_build_object('courier', p_courier, 'orders', cardinality(p_orders), 'bonus_per_extra', v_bonus, 'mode', p_mode, 'bps', v_bps));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION fn_courier_offers(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  PERFORM _expire_offers();
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'ref', o.ref, 'commune', o.commune, 'product', COALESCE(p.name, o.own_product_name), 'qty', o.qty,
                      'amount_to_collect', o.sale_total, 'courier_pay', _courier_pay_quote(o, p_actor), 'expires_at', m.expires_at, 'retry', o.status = 'failed') ORDER BY m.expires_at)
                    FROM mission_offers m JOIN orders o ON o.id = m.order_id LEFT JOIN products p ON p.id = o.product_id
                   WHERE m.courier_id = p_actor AND m.status = 'offered'), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION fn_courier_tours(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  PERFORM _tours_refresh();
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'note', t.note, 'status', t.status, 'created_at', t.created_at, 'bonus_per_extra', t.bonus_per_extra, 'pay_mode', t.pay_mode, 'mode_bps', t.mode_bps,
      'bonus_max', t.bonus_per_extra * GREATEST((SELECT count(*) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND (s.active OR o.status = 'delivered')) - 1, 0),
      'stops', (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'ref', o.ref, 'commune', o.commune, 'status', o.status, 'position', s.position, 'active', s.active, 'pay', _order_pay(o), 'plan_pay', COALESCE(pl.plan_pay, _order_pay(o))) ORDER BY s.position)
                  FROM tour_stops s JOIN orders o ON o.id = s.order_id LEFT JOIN _tour_plan(t.id) pl ON pl.order_id = o.id WHERE s.tour_id = t.id),
      'plan_total', COALESCE((SELECT sum(plan_pay) FROM _tour_plan(t.id)), 0)) ORDER BY t.created_at)
    FROM tours t WHERE t.courier_id = p_actor AND t.status IN ('proposed', 'active')), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION fn_chief_tours(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'created_at') DESC) FROM (
    SELECT jsonb_build_object(
      'id', t.id, 'status', t.status, 'note', t.note, 'created_at', t.created_at, 'closed_at', t.closed_at,
      'courier_id', t.courier_id, 'courier_name', u.full_name, 'actual_cost', t.actual_cost, 'accepted_at', t.accepted_at, 'pay_mode', t.pay_mode, 'mode_bps', t.mode_bps, 'adjust_paid', t.adjust_paid, 'bonus_per_extra', t.bonus_per_extra, 'bonus_paid', t.bonus_paid,
      'planned_bonus', t.bonus_per_extra * GREATEST((SELECT count(*) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND (s.active OR o.status = 'delivered')) - 1, 0),
      'stops', (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'ref', o.ref, 'commune', o.commune, 'status', o.status, 'position', s.position, 'active', s.active, 'fee', o.delivery_fee, 'pay', _order_pay(o), 'plan_pay', COALESCE(pl.plan_pay, _order_pay(o))) ORDER BY s.position)
                  FROM tour_stops s JOIN orders o ON o.id = s.order_id LEFT JOIN _tour_plan(t.id) pl ON pl.order_id = o.id WHERE s.tour_id = t.id),
      'orders', (SELECT count(*) FROM tour_stops s WHERE s.tour_id = t.id),
      'delivered', (SELECT count(*) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'),
      'delivery_fees', COALESCE((SELECT sum(o.delivery_fee) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0),
      'planned_fees', COALESCE((SELECT sum(o.delivery_fee) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND (s.active OR o.status = 'delivered')), 0),
      'planned_pay', COALESCE((SELECT sum(plan_pay) FROM _tour_plan(t.id)), 0),
      'courier_pay_system', COALESCE((SELECT sum(_order_pay(o)) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0)) AS x
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
  SELECT 'paie versée au livreur supérieure aux frais de livraison'::text, o.ref FROM orders o WHERE o.courier_pay_paid > o.delivery_fee;
  RETURN QUERY
  SELECT 'écritures de règlement en double'::text, w.order_id::text || '/' || w.kind FROM wallet_entries w
   WHERE w.order_id IS NOT NULL
     AND (w.kind IN ('seller_gain','supplier_payment','platform_revenue','float_release','return_fees',
                     'return_fee_supplier','prepaid_refund','transport_loss','referral_bonus')
          OR (w.kind IN ('team_pay','failed_trip','courier_prime') AND w.amount > 0))
   GROUP BY w.order_id, w.user_id, w.kind HAVING count(*) > 1;
  RETURN QUERY
  SELECT 'bonus de tournée en double'::text, w.order_id::text FROM wallet_entries w
   WHERE w.kind IN ('tour_bonus', 'tour_adjust') AND w.amount > 0 AND w.order_id IS NOT NULL
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
