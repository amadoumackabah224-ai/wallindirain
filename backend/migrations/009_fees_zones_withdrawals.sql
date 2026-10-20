-- =====================================================================
-- Migration 009 : frais de plateforme (3 modes), part du livreur en %, zones « quartier ou ville »,
-- commande déjà confirmée par le vendeur, import Google Sheet, retraits validés par l'administrateur.
-- =====================================================================

-- ---------- Réglages ----------
INSERT INTO settings(key, value, label) VALUES
  ('fee_order_bps',          0,  'Frais plateforme : % du prix de vente prélevé au vendeur à chaque livraison (points de base, 500 = 5 %, 0 = désactivé)'),
  ('fee_unit',               0,  'Frais plateforme : montant par produit livré, prélevé au vendeur (GNF, 0 = désactivé)'),
  ('subscription_monthly',   0,  'Abonnement mensuel du vendeur (GNF, 0 = pas d''abonnement)'),
  ('subscription_required',  0,  'Abonnement obligatoire pour vendre (1 = oui, 0 = non)'),
  ('subscription_trial_days',30, 'Jours d''essai gratuits pour un nouveau vendeur si l''abonnement est obligatoire'),
  ('courier_share_bps',      0,  'Part du livreur sur les frais de livraison (points de base, 8000 = 80 %, vous gardez le reste ; 0 = montant fixe « Rémunération livreur »)');

CREATE OR REPLACE FUNCTION fn_admin_set_setting(p_actor uuid, p_key text, p_value bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_value IS NULL OR p_value < 0 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key IN ('margin_bps','fee_order_bps','courier_share_bps') AND p_value > 10000 THEN PERFORM _err('invalid_input', 'Pourcentage invalide (10000 = 100 %)'); END IF;
  IF p_key IN ('code_max_attempts','call_attempt_limit') AND p_value < 1 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key IN ('require_delivery_code','require_payment_proof','subscription_required') AND p_value > 1 THEN PERFORM _err('invalid_input', 'Valeur invalide : 0 ou 1'); END IF;
  SELECT value INTO v_old FROM settings WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Réglage inconnu'); END IF;
  UPDATE settings SET value = p_value WHERE key = p_key;
  PERFORM _audit(p_actor, 'setting_changed', 'setting', p_key, jsonb_build_object('from', v_old, 'to', p_value));
END $$;

-- ---------- Frais de plateforme figés sur la commande ----------
ALTER TABLE orders ADD COLUMN platform_fee bigint NOT NULL DEFAULT 0 CHECK (platform_fee >= 0);

CREATE OR REPLACE FUNCTION trg_orders_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sale_total          IS DISTINCT FROM OLD.sale_total
  OR NEW.supplier_unit_price IS DISTINCT FROM OLD.supplier_unit_price
  OR NEW.margin_unit         IS DISTINCT FROM OLD.margin_unit
  OR NEW.seller_unit_price   IS DISTINCT FROM OLD.seller_unit_price
  OR NEW.delivery_fee        IS DISTINCT FROM OLD.delivery_fee
  OR NEW.call_fee            IS DISTINCT FROM OLD.call_fee
  OR NEW.platform_fee        IS DISTINCT FROM OLD.platform_fee
  OR NEW.agent_pay           IS DISTINCT FROM OLD.agent_pay
  OR NEW.courier_pay         IS DISTINCT FROM OLD.courier_pay
  OR NEW.unlock_hours        IS DISTINCT FROM OLD.unlock_hours
  OR NEW.delivery_code_hash  IS DISTINCT FROM OLD.delivery_code_hash
  OR NEW.qty                 IS DISTINCT FROM OLD.qty
  OR NEW.seller_id           IS DISTINCT FROM OLD.seller_id
  OR NEW.product_id          IS DISTINCT FROM OLD.product_id
  OR NEW.formula             IS DISTINCT FROM OLD.formula
  OR NEW.commune             IS DISTINCT FROM OLD.commune
  OR (NEW.customer_phone     IS DISTINCT FROM OLD.customer_phone AND COALESCE(current_setting('wld.purge', true), '') <> '1') THEN
    RAISE EXCEPTION 'montants et identité de la commande figés après création'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------- Zones de livraison (quartier ou ville) ----------
ALTER TABLE delivery_rates ADD COLUMN active boolean NOT NULL DEFAULT true;
INSERT INTO delivery_rates(commune, fee) VALUES ('Autre quartier / ville', (SELECT max(fee) FROM delivery_rates));

CREATE OR REPLACE FUNCTION _max_delivery_fee() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT max(fee) FROM delivery_rates WHERE active
$$;

DROP FUNCTION fn_admin_set_delivery_rate(uuid, text, bigint);
CREATE FUNCTION fn_admin_set_delivery_rate(p_actor uuid, p_commune text, p_fee bigint, p_active boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_fee IS NULL OR p_fee < 0 OR p_fee > 1000000 THEN PERFORM _err('invalid_input', 'Tarif invalide'); END IF;
  IF p_commune IS NULL OR length(trim(p_commune)) < 2 OR length(p_commune) > 60 THEN PERFORM _err('invalid_input', 'Nom de zone invalide'); END IF;
  SELECT fee INTO v_old FROM delivery_rates WHERE commune = trim(p_commune);
  INSERT INTO delivery_rates(commune, fee, active) VALUES (trim(p_commune), p_fee, COALESCE(p_active, true))
  ON CONFLICT (commune) DO UPDATE SET fee = EXCLUDED.fee, active = EXCLUDED.active;
  IF NOT EXISTS (SELECT 1 FROM delivery_rates WHERE active) THEN PERFORM _err('invalid_input', 'Gardez au moins une zone active'); END IF;
  PERFORM _audit(p_actor, 'delivery_rate_changed', 'zone', trim(p_commune),
                 jsonb_build_object('from', v_old, 'to', p_fee, 'active', COALESCE(p_active, true)));
END $$;

-- ---------- Abonnement du vendeur ----------
CREATE TABLE seller_subscriptions (
  seller_id  uuid PRIMARY KEY REFERENCES users(id),
  paid_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION _seller_can_sell(p_seller uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _setting('subscription_required') = 0
      OR _setting('subscription_monthly') = 0
      OR EXISTS (SELECT 1 FROM seller_subscriptions s WHERE s.seller_id = p_seller AND s.paid_until > now())
      OR EXISTS (SELECT 1 FROM users u WHERE u.id = p_seller AND u.created_at + make_interval(days => _setting('subscription_trial_days')::int) > now())
$$;

-- L'administrateur encaisse l'abonnement : prélevé sur le portefeuille du vendeur, ou noté « payé hors plateforme » (virement, espèces)
CREATE FUNCTION fn_admin_charge_subscription(p_actor uuid, p_seller uuid, p_months int, p_method text, p_note text DEFAULT NULL) RETURNS timestamptz
LANGUAGE plpgsql AS $$
DECLARE v_amount bigint; v_until timestamptz;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_months IS NULL OR p_months < 1 OR p_months > 12 THEN PERFORM _err('invalid_input', 'Durée invalide (1 à 12 mois)'); END IF;
  IF p_method NOT IN ('wallet','external') THEN PERFORM _err('invalid_input', 'Mode invalide'); END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_seller AND role = 'seller' AND deleted_at IS NULL) THEN PERFORM _err('not_found', 'Vendeur introuvable'); END IF;
  v_amount := _setting('subscription_monthly') * p_months;
  IF v_amount <= 0 THEN PERFORM _err('invalid_state', 'Aucun abonnement défini dans les réglages'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wallet:' || p_seller::text));
  IF p_method = 'wallet' THEN
    IF _wallet_available(p_seller) < v_amount THEN PERFORM _err('insufficient_funds', 'Solde disponible du vendeur insuffisant : choisissez « payé hors plateforme »'); END IF;
    PERFORM _wallet_add(p_seller, 'subscription', -v_amount, NULL, now(), 'Abonnement ' || p_months || ' mois');
    PERFORM _wallet_add(_platform(), 'subscription', v_amount, NULL, now(), 'Abonnement vendeur');
  ELSIF p_note IS NULL OR length(trim(p_note)) < 3 THEN
    PERFORM _err('invalid_input', 'Indiquez comment il a payé (ex. Orange Money, référence)');
  END IF;
  INSERT INTO seller_subscriptions(seller_id, paid_until) VALUES (p_seller, now() + make_interval(days => 30 * p_months))
  ON CONFLICT (seller_id) DO UPDATE SET paid_until = greatest(seller_subscriptions.paid_until, now()) + make_interval(days => 30 * p_months), updated_at = now()
  RETURNING paid_until INTO v_until;
  PERFORM _audit(p_actor, 'subscription_charged', 'user', p_seller::text, jsonb_build_object('months', p_months, 'amount', v_amount, 'method', p_method, 'note', p_note));
  RETURN v_until;
END $$;

-- ---------- Création de commande : zone, frais plateforme, part du livreur, « déjà confirmée par le vendeur » ----------
DROP FUNCTION fn_public_order(text, int, text, text, text, text);
DROP FUNCTION fn_seller_create_order(uuid, uuid, text, bigint, int, text, text, text, text, text);
DROP FUNCTION _create_order(uuid, uuid, text, bigint, int, text, text, text, text, text, text, uuid);

CREATE FUNCTION _create_order(p_seller uuid, p_product uuid, p_own_name text, p_unit_price bigint, p_qty int,
                              p_cname text, p_cphone text, p_commune text, p_address text, p_note text,
                              p_source text, p_actor uuid, p_preconfirmed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  p products; v_delivery bigint; v_call bigint; v_id uuid := gen_random_uuid();
  v_code text; v_unit bigint; v_total bigint; v_sup bigint := 0; v_margin bigint := 0; v_wh bigint := 0;
  v_nb int := 0; v_na int := 0; v_formula text; ss seller_stock; v_ref text; v_risk boolean;
  v_pfee bigint; v_courier bigint; v_agent bigint; v_status order_status;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_seller AND role = 'seller' AND status = 'active' AND deleted_at IS NULL) THEN
    PERFORM _err('seller_inactive', 'Ce vendeur n''est pas actif');
  END IF;
  IF NOT _seller_can_sell(p_seller) THEN
    PERFORM _err('subscription_required', 'Abonnement du vendeur expiré : contactez Wallindirain pour le renouveler');
  END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 100 THEN PERFORM _err('invalid_input', 'Quantité invalide (1 à 100)'); END IF;
  IF p_cphone IS NULL OR p_cphone !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro du client invalide (9 chiffres)'); END IF;
  IF p_cname IS NULL OR length(trim(p_cname)) < 2 THEN PERFORM _err('invalid_input', 'Nom du client invalide'); END IF;
  IF p_address IS NULL OR length(trim(p_address)) < 3 THEN PERFORM _err('invalid_input', 'Adresse invalide'); END IF;
  IF p_preconfirmed AND p_source <> 'seller' THEN PERFORM _err('invalid_input', 'Confirmation par le vendeur impossible pour une commande par lien'); END IF;
  SELECT fee INTO v_delivery FROM delivery_rates WHERE commune = p_commune AND active;
  IF NOT FOUND THEN PERFORM _err('invalid_input', 'Quartier ou ville non desservi : choisissez une zone de la liste'); END IF;
  -- le vendeur qui a déjà appelé son client ne facture pas le call center
  v_call := CASE WHEN p_preconfirmed THEN 0 ELSE _setting('call_fee') END;
  v_agent := CASE WHEN p_preconfirmed THEN 0 ELSE _setting('agent_pay') END;
  v_courier := CASE WHEN _setting('courier_share_bps') > 0 THEN ((v_delivery * _setting('courier_share_bps') + 5000) / 10000)::bigint ELSE _setting('courier_pay') END;
  v_pfee := ((p_qty * _setting('fee_unit')) + 0)::bigint;     -- complété par le pourcentage une fois le total connu

  IF p_source = 'public_link' AND
     (SELECT count(*) FROM orders WHERE customer_phone = p_cphone AND created_at > now() - interval '1 day') >= 5 THEN
    PERFORM _err('too_many_orders', 'Trop de commandes pour ce numéro aujourd''hui');
  END IF;

  IF p_product IS NOT NULL THEN
    SELECT * INTO p FROM products WHERE id = p_product AND status = 'approved' AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Produit indisponible'); END IF;
    IF EXISTS (SELECT 1 FROM orders WHERE customer_phone = p_cphone AND product_id = p_product
               AND status NOT IN ('delivered','returned','refused','cancelled')) THEN
      PERFORM _err('duplicate_order', 'Une commande identique est déjà en cours pour ce client');
    END IF;
    v_unit := COALESCE(p_unit_price,
                       (SELECT sale_price FROM seller_prices WHERE seller_id = p_seller AND product_id = p_product));
    IF v_unit IS NULL THEN PERFORM _err('price_required', 'Aucun prix de vente défini pour ce produit'); END IF;
    v_sup := p.supplier_price; v_margin := p.margin_unit; v_wh := v_sup + v_margin;
    v_total := v_unit * p_qty;
    v_pfee := v_pfee + ((v_total * _setting('fee_order_bps') + 5000) / 10000)::bigint;
    IF v_total < v_wh * p_qty + v_call + v_delivery + v_pfee THEN
      PERFORM _err('price_below_minimum', 'Prix trop bas : cette vente serait à perte');
    END IF;
    SELECT * INTO ss FROM seller_stock WHERE seller_id = p_seller AND product_id = p_product FOR UPDATE;
    IF FOUND THEN v_nb := LEAST(p_qty, ss.qty - ss.reserved_qty); END IF;
    v_na := p_qty - v_nb;
    IF v_na > p.stock_qty - p.reserved_qty THEN PERFORM _err('out_of_stock', 'Stock insuffisant pour cette quantité'); END IF;
    IF v_nb > 0 THEN UPDATE seller_stock SET reserved_qty = reserved_qty + v_nb WHERE seller_id = p_seller AND product_id = p_product; END IF;
    IF v_na > 0 THEN UPDATE products SET reserved_qty = reserved_qty + v_na WHERE id = p_product; END IF;
    v_formula := CASE WHEN v_na = 0 THEN 'B' WHEN v_nb = 0 THEN 'A' ELSE 'AB' END;
  ELSE
    IF p_own_name IS NULL OR length(trim(p_own_name)) < 2 THEN PERFORM _err('invalid_input', 'Nom du produit obligatoire'); END IF;
    IF EXISTS (SELECT 1 FROM orders WHERE customer_phone = p_cphone AND seller_id = p_seller AND product_id IS NULL
               AND lower(own_product_name) = lower(trim(p_own_name))
               AND status NOT IN ('delivered','returned','refused','cancelled')) THEN
      PERFORM _err('duplicate_order', 'Une commande identique est déjà en cours pour ce client');
    END IF;
    IF p_unit_price IS NULL OR p_unit_price <= 0 THEN PERFORM _err('invalid_input', 'Prix de vente invalide'); END IF;
    v_unit := p_unit_price; v_total := v_unit * p_qty;
    v_pfee := v_pfee + ((v_total * _setting('fee_order_bps') + 5000) / 10000)::bigint;
    IF v_total < v_call + v_delivery + v_pfee THEN
      PERFORM _err('price_below_minimum', 'Le prix doit couvrir au moins la livraison, le call center et les frais de plateforme (' || (v_call + v_delivery + v_pfee) || ' GNF)');
    END IF;
    v_formula := 'C';
  END IF;

  v_code := _rand_digits(4);
  v_risk := EXISTS (SELECT 1 FROM risky_customers WHERE customer_phone = p_cphone);
  v_status := CASE WHEN p_preconfirmed THEN 'confirmed' ELSE 'new' END;

  INSERT INTO orders(id, seller_id, product_id, own_product_name, formula, source, qty, qty_from_seller, qty_from_catalog,
                     customer_name, customer_phone, commune, address, note, sale_total,
                     supplier_unit_price, margin_unit, seller_unit_price, delivery_fee, call_fee, platform_fee, agent_pay, courier_pay,
                     unlock_hours, delivery_code_hash, risk_flag, status, confirmed_by, confirmed_at)
  VALUES (v_id, p_seller, p_product, CASE WHEN p_product IS NULL THEN trim(p_own_name) END, v_formula, p_source, p_qty,
          v_nb, v_na, trim(p_cname), p_cphone, p_commune, trim(p_address), NULLIF(trim(p_note), ''), v_total,
          v_sup, v_margin, v_wh, v_delivery, v_call, v_pfee, v_agent, v_courier,
          _setting('unlock_hours')::int, _code_hash(v_code, v_id), v_risk, v_status,
          CASE WHEN p_preconfirmed THEN p_seller END, CASE WHEN p_preconfirmed THEN now() END)
  RETURNING ref INTO v_ref;
  INSERT INTO order_secrets(order_id, code) VALUES (v_id, v_code);
  PERFORM _log_status(v_id, NULL, 'new', p_actor, CASE WHEN p_source = 'public_link' THEN 'Lien partagé' ELSE 'Saisie par le vendeur' END);
  IF p_preconfirmed THEN
    PERFORM _log_status(v_id, 'new', 'confirmed', p_actor, 'Client déjà appelé et confirmé par le vendeur : sans call center');
    IF _setting('require_delivery_code') = 1 THEN
      PERFORM _queue_message(p_cphone, 'delivery_code',
        'Wallindirain : votre commande ' || v_ref || ' est confirmée. Code de livraison : ' || v_code ||
        '. Donnez ce code au livreur uniquement à la réception de votre colis.', v_id);
    ELSE
      PERFORM _queue_message(p_cphone, 'order_confirmed',
        'Wallindirain : votre commande ' || v_ref || ' est confirmée. Un livreur vous contactera. Payez à la réception de votre colis.', v_id);
    END IF;
  END IF;
  RETURN jsonb_build_object('id', v_id, 'ref', v_ref, 'formula', v_formula, 'sale_total', v_total, 'risk', v_risk, 'status', v_status);
END $$;

CREATE FUNCTION fn_public_order(p_link text, p_qty int, p_cname text, p_cphone text, p_commune text, p_address text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE l seller_links; r jsonb;
BEGIN
  SELECT * INTO l FROM seller_links WHERE code = p_link;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Lien invalide'); END IF;
  r := _create_order(l.seller_id, l.product_id, NULL, NULL, p_qty, p_cname, p_cphone, p_commune, p_address, NULL, 'public_link', NULL);
  RETURN jsonb_build_object('ref', r->>'ref', 'sale_total', (r->>'sale_total')::bigint);
END $$;

CREATE FUNCTION fn_seller_create_order(p_actor uuid, p_product uuid, p_own_name text, p_unit_price bigint, p_qty int,
                                       p_cname text, p_cphone text, p_commune text, p_address text, p_note text,
                                       p_preconfirmed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  RETURN _create_order(p_actor, p_product, p_own_name, p_unit_price, p_qty, p_cname, p_cphone, p_commune,
                       p_address, p_note, 'seller', p_actor, COALESCE(p_preconfirmed, false));
END $$;

-- Annulation par le vendeur : possible aussi pour une commande qu'il a lui-même confirmée, tant qu'aucun livreur ne l'a ramassée
CREATE OR REPLACE FUNCTION fn_seller_cancel_order(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF NOT ((o.status = 'new' AND o.call_attempts = 0 AND NOT EXISTS (SELECT 1 FROM calls WHERE order_id = o.id))
          OR (o.status = 'confirmed' AND o.confirmed_by = p_actor AND o.courier_id IS NULL)) THEN
    PERFORM _err('too_late', 'Annulation impossible : la commande a déjà été prise en charge');
  END IF;
  UPDATE orders SET status = 'cancelled', closed_at = now() WHERE id = o.id;
  PERFORM _release_stock(o);
  DELETE FROM order_secrets WHERE order_id = o.id;
  PERFORM _log_status(o.id, o.status, 'cancelled', p_actor, 'Annulée par le vendeur');
END $$;

-- ---------- Répartition à la livraison : les frais de plateforme passent du vendeur à Wallindirain ----------
CREATE OR REPLACE FUNCTION _settle_delivery(o orders) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_avail timestamptz := now() + make_interval(hours => o.unlock_hours);
  v_sup bigint := o.supplier_unit_price * o.qty;
  v_margin bigint := o.margin_unit * o.qty;
  v_prepaid bigint := o.qty_from_seller * o.seller_unit_price;
  v_due_a bigint := o.qty_from_catalog * o.seller_unit_price;
  v_gain bigint; v_gross bigint; v_supplier uuid;
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
  PERFORM _wallet_add(o.courier_id, 'team_pay', o.courier_pay, o.id, now(), 'Livraison ' || o.ref);
  PERFORM _wallet_add(_platform(), 'team_pay', -o.courier_pay, o.id, now(), 'Livreur ' || o.ref);
  INSERT INTO courier_cash_entries(courier_id, order_id, amount) VALUES (o.courier_id, o.id, o.sale_total);
END $$;

-- ---------- Retraits : validés par l'administrateur, l'argent est débité au moment du paiement ----------
ALTER TABLE withdrawals ADD COLUMN debited boolean NOT NULL DEFAULT false;
UPDATE withdrawals SET debited = true WHERE status = 'requested';      -- anciennes demandes : déjà débitées à la confirmation
UPDATE withdrawals SET status = 'expired' WHERE status = 'pending_code';
DROP FUNCTION fn_withdrawal_confirm(uuid, uuid, text);

-- Solde disponible moins les demandes en attente (réservées sans être encore débitées)
CREATE FUNCTION _wallet_free(p_user uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT _wallet_available(p_user) - COALESCE((SELECT sum(amount) FROM withdrawals WHERE user_id = p_user AND status = 'requested' AND NOT debited), 0)::bigint
$$;

DROP FUNCTION fn_withdrawal_request(uuid, bigint, text, text);
CREATE FUNCTION fn_withdrawal_request(p_actor uuid, p_amount bigint, p_method text DEFAULT NULL, p_account text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE u users; v_id uuid := gen_random_uuid(); v_min bigint;
BEGIN
  u := _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier']::user_role[]);
  IF NOT u.identity_verified THEN
    PERFORM _err('identity_required', 'Identité non vérifiée : retrait impossible');
  END IF;
  IF u.payout_phone IS NOT NULL THEN
    p_method := u.payout_method; p_account := u.payout_phone;
  ELSIF p_method IS NULL OR p_account IS NULL THEN
    PERFORM _err('payout_missing', 'Aucun numéro de versement enregistré : renseignez-le dans votre profil');
  END IF;
  v_min := _setting('min_withdrawal');
  IF p_amount IS NULL OR p_amount < v_min THEN PERFORM _err('below_minimum', 'Retrait minimum : ' || v_min || ' GNF'); END IF;
  IF p_method NOT IN ('orange_money','mtn_momo') THEN PERFORM _err('invalid_input', 'Mode de paiement invalide'); END IF;
  IF p_account !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro de paiement invalide (9 chiffres)'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wallet:' || p_actor::text));
  IF _wallet_free(p_actor) < p_amount THEN PERFORM _err('insufficient_funds', 'Solde disponible insuffisant (les retraits en attente sont déjà réservés)'); END IF;
  INSERT INTO withdrawals(id, user_id, amount, method, account_number, status) VALUES (v_id, p_actor, p_amount, p_method, p_account, 'requested');
  PERFORM _audit(p_actor, 'withdrawal_requested', 'withdrawal', v_id::text, jsonb_build_object('amount', p_amount));
  RETURN v_id;
END $$;

-- L'administrateur envoie l'argent, joint la capture, puis le montant est débité du portefeuille
DROP FUNCTION fn_admin_pay_withdrawal(uuid, uuid, text, uuid);
CREATE FUNCTION fn_admin_pay_withdrawal(p_actor uuid, p_withdrawal uuid, p_payment_ref text, p_proof uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE w withdrawals; u users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_payment_ref IS NULL OR length(trim(p_payment_ref)) < 3 THEN PERFORM _err('invalid_input', 'Référence de paiement obligatoire'); END IF;
  SELECT * INTO w FROM withdrawals WHERE id = p_withdrawal FOR UPDATE;
  IF NOT FOUND OR w.status <> 'requested' THEN PERFORM _err('invalid_state', 'Retrait introuvable ou déjà traité'); END IF;
  SELECT * INTO u FROM users WHERE id = w.user_id;
  IF NOT u.identity_verified THEN PERFORM _err('identity_required', 'Identité non vérifiée : paiement impossible'); END IF;
  IF p_proof IS NULL THEN
    IF _setting('require_payment_proof') = 1 THEN PERFORM _err('proof_required', 'Joignez la capture d''écran du transfert'); END IF;
  ELSE
    PERFORM _check_proof(p_actor, p_proof, 'withdrawal_payment');
  END IF;
  IF NOT w.debited THEN
    PERFORM pg_advisory_xact_lock(hashtext('wallet:' || w.user_id::text));
    IF _wallet_available(w.user_id) < w.amount THEN PERFORM _err('insufficient_funds', 'Le solde du bénéficiaire ne couvre plus ce retrait : refusez-le'); END IF;
    PERFORM _wallet_add(w.user_id, 'withdrawal', -w.amount, NULL, now(), 'Retrait ' || w.method);
  END IF;
  UPDATE withdrawals SET status = 'paid', debited = true, payment_ref = trim(p_payment_ref), proof_id = p_proof, decided_by = p_actor, decided_at = now() WHERE id = w.id;
  PERFORM _audit(p_actor, 'withdrawal_paid', 'withdrawal', w.id::text,
                 jsonb_build_object('amount', w.amount, 'ref', p_payment_ref, 'method', w.method, 'proof', p_proof IS NOT NULL));
  PERFORM _queue_message(u.phone, 'withdrawal_paid',
    'Wallindirain : votre retrait de ' || w.amount || ' GNF a été envoyé sur le ' || w.account_number || '.');
END $$;

CREATE OR REPLACE FUNCTION fn_admin_reject_withdrawal(p_actor uuid, p_withdrawal uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE w withdrawals;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN PERFORM _err('invalid_input', 'Motif obligatoire'); END IF;
  SELECT * INTO w FROM withdrawals WHERE id = p_withdrawal FOR UPDATE;
  IF NOT FOUND OR w.status <> 'requested' THEN PERFORM _err('invalid_state', 'Retrait introuvable ou déjà traité'); END IF;
  UPDATE withdrawals SET status = 'rejected', decided_by = p_actor, decided_at = now() WHERE id = w.id;
  IF w.debited THEN        -- ancienne demande déjà débitée : remboursement
    PERFORM _wallet_add(w.user_id, 'withdrawal_refund', w.amount, NULL, now(), 'Retrait refusé : ' || trim(p_reason));
  END IF;
  PERFORM _audit(p_actor, 'withdrawal_rejected', 'withdrawal', w.id::text, jsonb_build_object('reason', p_reason));
END $$;

-- ---------- Import Google Sheet / CSV par le vendeur ----------
CREATE TABLE seller_sheets (
  seller_id  uuid PRIMARY KEY REFERENCES users(id),
  sheet_id   text NOT NULL CHECK (sheet_id ~ '^[A-Za-z0-9_-]{20,120}$'),
  gid        text NOT NULL DEFAULT '0' CHECK (gid ~ '^[0-9]{1,12}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sheet_imports (
  seller_id  uuid NOT NULL REFERENCES users(id),
  row_hash   text NOT NULL,
  order_id   uuid REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_id, row_hash)
);

CREATE FUNCTION fn_seller_set_sheet(p_actor uuid, p_sheet text, p_gid text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_sheet IS NULL THEN DELETE FROM seller_sheets WHERE seller_id = p_actor; RETURN; END IF;
  BEGIN
    INSERT INTO seller_sheets(seller_id, sheet_id, gid) VALUES (p_actor, p_sheet, COALESCE(p_gid, '0'))
    ON CONFLICT (seller_id) DO UPDATE SET sheet_id = EXCLUDED.sheet_id, gid = EXCLUDED.gid, updated_at = now();
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Lien Google Sheet invalide');
  END;
END $$;

-- Une ligne du tableur = une commande ; une ligne déjà importée est ignorée (même contenu)
CREATE FUNCTION fn_seller_import_order(p_actor uuid, p_hash text, p_product uuid, p_own_name text, p_unit_price bigint, p_qty int,
                                       p_cname text, p_cphone text, p_commune text, p_address text, p_note text, p_preconfirmed boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN PERFORM _err('invalid_input', 'Ligne invalide'); END IF;
  IF EXISTS (SELECT 1 FROM sheet_imports WHERE seller_id = p_actor AND row_hash = p_hash) THEN
    RETURN jsonb_build_object('duplicate', true);
  END IF;
  r := fn_seller_create_order(p_actor, p_product, p_own_name, p_unit_price, p_qty, p_cname, p_cphone, p_commune, p_address, p_note, p_preconfirmed);
  INSERT INTO sheet_imports(seller_id, row_hash, order_id) VALUES (p_actor, p_hash, (r->>'id')::uuid);
  RETURN r;
END $$;

-- La remise à zéro efface aussi les lignes importées
CREATE OR REPLACE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 order_history, calls, risky_customers, sheet_imports, orders, arrivals, seller_stock, messages, one_time_codes, proofs
    RESTART IDENTITY;
  UPDATE products SET stock_qty = 0, reserved_qty = 0;
  PERFORM _audit(p_actor, 'activity_reset', 'system', NULL, jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries));
  RETURN jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries);
END $$;

-- ---------- Droits (mêmes règles que les migrations précédentes) ----------
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
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash')
       AND NOT (r.relname IN ('proofs','avatars') AND column_name = 'data');
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
