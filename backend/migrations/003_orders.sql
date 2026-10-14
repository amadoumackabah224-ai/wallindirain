-- =====================================================================
-- Migration 003 : commandes, appels, livraison, caisse, retours, retraits
-- =====================================================================

CREATE FUNCTION _log_status(p_order uuid, p_from order_status, p_to order_status, p_actor uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO order_history(order_id, from_status, to_status, actor_id, note)
  VALUES (p_order, p_from, p_to, p_actor, p_note)
$$;

-- Libère le stock réservé (commande refusée, annulée ou retour refus client)
CREATE FUNCTION _release_stock(o orders) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF o.formula = 'C' THEN RETURN; END IF;
  IF o.qty_from_seller > 0 THEN
    UPDATE seller_stock SET reserved_qty = reserved_qty - o.qty_from_seller
     WHERE seller_id = o.seller_id AND product_id = o.product_id;
  END IF;
  IF o.qty_from_catalog > 0 THEN
    UPDATE products SET reserved_qty = reserved_qty - o.qty_from_catalog WHERE id = o.product_id;
  END IF;
END $$;

-- Sort définitivement du stock (livraison, ou perte pour retour défectueux / abîmé)
CREATE FUNCTION _consume_stock(o orders) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF o.formula = 'C' THEN RETURN; END IF;
  IF o.qty_from_seller > 0 THEN
    UPDATE seller_stock SET qty = qty - o.qty_from_seller, reserved_qty = reserved_qty - o.qty_from_seller
     WHERE seller_id = o.seller_id AND product_id = o.product_id;
  END IF;
  IF o.qty_from_catalog > 0 THEN
    UPDATE products SET stock_qty = stock_qty - o.qty_from_catalog, reserved_qty = reserved_qty - o.qty_from_catalog
     WHERE id = o.product_id;
  END IF;
END $$;

CREATE FUNCTION _risk_mark(p_phone text, p_reason text, p_order uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO risky_customers(customer_phone, last_reason, last_order_id)
  VALUES (p_phone, p_reason, p_order)
  ON CONFLICT (customer_phone) DO UPDATE
    SET incidents = risky_customers.incidents + 1, last_reason = EXCLUDED.last_reason,
        last_order_id = EXCLUDED.last_order_id, updated_at = now()
$$;

-- ---------------------------------------------------------------------
-- Création de commande (lien partagé ou saisie par le vendeur)
-- ---------------------------------------------------------------------
CREATE FUNCTION _create_order(p_seller uuid, p_product uuid, p_own_name text, p_unit_price bigint, p_qty int,
                              p_cname text, p_cphone text, p_commune text, p_address text, p_note text,
                              p_source text, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  p products; v_delivery bigint; v_call bigint; v_id uuid := gen_random_uuid();
  v_code text; v_unit bigint; v_total bigint; v_sup bigint := 0; v_margin bigint := 0; v_wh bigint := 0;
  v_nb int := 0; v_na int := 0; v_formula text; ss seller_stock; v_ref text; v_risk boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_seller AND role = 'seller' AND status = 'active' AND deleted_at IS NULL) THEN
    PERFORM _err('seller_inactive', 'Ce vendeur n''est pas actif');
  END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 100 THEN PERFORM _err('invalid_input', 'Quantité invalide (1 à 100)'); END IF;
  IF p_cphone IS NULL OR p_cphone !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro du client invalide (9 chiffres)'); END IF;
  IF p_cname IS NULL OR length(trim(p_cname)) < 2 THEN PERFORM _err('invalid_input', 'Nom du client invalide'); END IF;
  IF p_address IS NULL OR length(trim(p_address)) < 3 THEN PERFORM _err('invalid_input', 'Adresse invalide'); END IF;
  SELECT fee INTO v_delivery FROM delivery_rates WHERE commune = p_commune;
  IF NOT FOUND THEN PERFORM _err('invalid_input', 'Commune non desservie'); END IF;
  v_call := _setting('call_fee');

  IF p_source = 'public_link' AND
     (SELECT count(*) FROM orders WHERE customer_phone = p_cphone AND created_at > now() - interval '1 day') >= 5 THEN
    PERFORM _err('too_many_orders', 'Trop de commandes pour ce numéro aujourd''hui');
  END IF;

  IF p_product IS NOT NULL THEN
    -- Commande du catalogue (formules A, B ou mixte)
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
    IF v_total < v_wh * p_qty + v_call + v_delivery THEN
      PERFORM _err('price_below_minimum', 'Prix trop bas : cette vente serait à perte');
    END IF;
    -- stock : d'abord celui du vendeur, puis celui du catalogue
    SELECT * INTO ss FROM seller_stock WHERE seller_id = p_seller AND product_id = p_product FOR UPDATE;
    IF FOUND THEN v_nb := LEAST(p_qty, ss.qty - ss.reserved_qty); END IF;
    v_na := p_qty - v_nb;
    IF v_na > p.stock_qty - p.reserved_qty THEN PERFORM _err('out_of_stock', 'Stock insuffisant pour cette quantité'); END IF;
    IF v_nb > 0 THEN UPDATE seller_stock SET reserved_qty = reserved_qty + v_nb WHERE seller_id = p_seller AND product_id = p_product; END IF;
    IF v_na > 0 THEN UPDATE products SET reserved_qty = reserved_qty + v_na WHERE id = p_product; END IF;
    v_formula := CASE WHEN v_na = 0 THEN 'B' WHEN v_nb = 0 THEN 'A' ELSE 'AB' END;
  ELSE
    -- Formule C : produit propre du vendeur
    IF p_own_name IS NULL OR length(trim(p_own_name)) < 2 THEN PERFORM _err('invalid_input', 'Nom du produit obligatoire'); END IF;
    IF EXISTS (SELECT 1 FROM orders WHERE customer_phone = p_cphone AND seller_id = p_seller AND product_id IS NULL
               AND lower(own_product_name) = lower(trim(p_own_name))
               AND status NOT IN ('delivered','returned','refused','cancelled')) THEN
      PERFORM _err('duplicate_order', 'Une commande identique est déjà en cours pour ce client');
    END IF;
    IF p_unit_price IS NULL OR p_unit_price <= 0 THEN PERFORM _err('invalid_input', 'Prix de vente invalide'); END IF;
    v_unit := p_unit_price; v_total := v_unit * p_qty;
    IF v_total < v_call + v_delivery THEN
      PERFORM _err('price_below_minimum', 'Le prix doit couvrir au moins la livraison et le call center (' || (v_call + v_delivery) || ' GNF)');
    END IF;
    v_formula := 'C';
  END IF;

  v_code := _rand_digits(4);
  v_risk := EXISTS (SELECT 1 FROM risky_customers WHERE customer_phone = p_cphone);

  INSERT INTO orders(id, seller_id, product_id, own_product_name, formula, source, qty, qty_from_seller, qty_from_catalog,
                     customer_name, customer_phone, commune, address, note, sale_total,
                     supplier_unit_price, margin_unit, seller_unit_price, delivery_fee, call_fee, agent_pay, courier_pay,
                     unlock_hours, delivery_code_hash, risk_flag)
  VALUES (v_id, p_seller, p_product, CASE WHEN p_product IS NULL THEN trim(p_own_name) END, v_formula, p_source, p_qty,
          v_nb, v_na, trim(p_cname), p_cphone, p_commune, trim(p_address), NULLIF(trim(p_note), ''), v_total,
          v_sup, v_margin, v_wh, v_delivery, v_call, _setting('agent_pay'), _setting('courier_pay'),
          _setting('unlock_hours')::int, _code_hash(v_code, v_id), v_risk)
  RETURNING ref INTO v_ref;
  INSERT INTO order_secrets(order_id, code) VALUES (v_id, v_code);
  PERFORM _log_status(v_id, NULL, 'new', p_actor, CASE WHEN p_source = 'public_link' THEN 'Lien partagé' ELSE 'Saisie par le vendeur' END);
  RETURN jsonb_build_object('id', v_id, 'ref', v_ref, 'formula', v_formula, 'sale_total', v_total, 'risk', v_risk);
END $$;

-- Page publique du lien partagé (aucune authentification)
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
                                       p_cname text, p_cphone text, p_commune text, p_address text, p_note text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  RETURN _create_order(p_actor, p_product, p_own_name, p_unit_price, p_qty, p_cname, p_cphone, p_commune,
                       p_address, p_note, 'seller', p_actor);
END $$;

-- Le vendeur peut annuler tant que la commande n'a pas été appelée
CREATE FUNCTION fn_seller_cancel_order(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status <> 'new' OR o.call_attempts > 0 OR EXISTS (SELECT 1 FROM calls WHERE order_id = o.id) THEN
    PERFORM _err('too_late', 'Annulation impossible : la commande a déjà été prise en charge par le call center');
  END IF;
  UPDATE orders SET status = 'cancelled', closed_at = now() WHERE id = o.id;
  PERFORM _release_stock(o);
  DELETE FROM order_secrets WHERE order_id = o.id;
  PERFORM _log_status(o.id, o.status, 'cancelled', p_actor, 'Annulée par le vendeur');
END $$;

CREATE FUNCTION fn_staff_cancel_order(p_actor uuid, p_order uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin','call_chief']::user_role[]);
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN PERFORM _err('invalid_input', 'Motif d''annulation obligatoire'); END IF;
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status NOT IN ('new','in_call','confirmed','assigned','failed') THEN
    PERFORM _err('invalid_state', 'Cette commande ne peut plus être annulée');
  END IF;
  UPDATE orders SET status = 'cancelled', closed_at = now(), locked_by = NULL WHERE id = o.id;
  PERFORM _release_stock(o);
  DELETE FROM order_secrets WHERE order_id = o.id;
  PERFORM _log_status(o.id, o.status, 'cancelled', p_actor, trim(p_reason));
  PERFORM _audit(p_actor, 'order_cancelled', 'order', o.id::text, jsonb_build_object('reason', p_reason));
END $$;

-- ---------------------------------------------------------------------
-- Appels : une commande n'est prise que par un agent à la fois
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_agent_take_order(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders; u users;
BEGIN
  u := _require(p_actor, ARRAY['agent','call_chief']::user_role[]);
  -- UPDATE conditionnel : le verrou de ligne départage deux agents simultanés
  -- Une commande escaladée (trop d'appels sans réponse) n'est reprise que par un chef
  UPDATE orders SET status = 'in_call', locked_by = p_actor, locked_at = now()
   WHERE id = p_order AND (NOT escalated OR u.role = 'call_chief')
     AND (status = 'new'
          OR (status = 'in_call' AND locked_by = p_actor)
          OR (status = 'in_call' AND locked_at < now() - interval '15 minutes'))
  RETURNING * INTO o;
  IF NOT FOUND THEN
    PERFORM _err('already_taken', 'Cette commande est déjà prise par un autre agent ou n''est plus disponible');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM order_history WHERE order_id = o.id AND to_status = 'in_call' AND actor_id = p_actor
                 AND at > now() - interval '15 minutes') THEN
    PERFORM _log_status(o.id, 'new', 'in_call', p_actor, 'Prise en charge');
  END IF;
END $$;

CREATE FUNCTION fn_agent_log_call(p_actor uuid, p_order uuid, p_result call_result, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; o orders; v_code text; v_limit int;
BEGIN
  u := _require(p_actor, ARRAY['agent','call_chief']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status <> 'in_call' OR o.locked_by IS DISTINCT FROM p_actor THEN
    PERFORM _err('not_your_order', 'Vous devez d''abord prendre cette commande');
  END IF;
  INSERT INTO calls(order_id, agent_id, agent_name, call_center, result, note)
  VALUES (o.id, u.id, u.full_name, COALESCE(u.team, '-'), p_result, NULLIF(trim(p_note), ''));

  IF p_result = 'confirmed' THEN
    UPDATE orders SET status = 'confirmed', confirmed_by = p_actor, confirmed_at = now(), locked_by = NULL WHERE id = o.id;
    PERFORM _log_status(o.id, 'in_call', 'confirmed', p_actor, 'Confirmée par ' || u.full_name);
    PERFORM _wallet_add(p_actor, 'team_pay', o.agent_pay, o.id, now(), 'Commande ' || o.ref || ' confirmée');
    PERFORM _wallet_add(_platform(), 'team_pay', -o.agent_pay, o.id, now(), 'Agent ' || u.full_name);
    SELECT code INTO v_code FROM order_secrets WHERE order_id = o.id;
    PERFORM _queue_message(o.customer_phone, 'delivery_code',
      'Wallindirain : votre commande ' || o.ref || ' est confirmée. Code de livraison : ' || v_code ||
      '. Donnez ce code au livreur uniquement à la réception de votre colis.', o.id);
  ELSIF p_result = 'unreachable' THEN
    v_limit := _setting('call_attempt_limit')::int;
    UPDATE orders SET status = 'new', locked_by = NULL, call_attempts = call_attempts + 1,
                      escalated = (call_attempts + 1 >= v_limit)
     WHERE id = o.id;
    PERFORM _log_status(o.id, 'in_call', 'new', p_actor, 'Client injoignable');
  ELSE
    UPDATE orders SET status = 'refused', closed_at = now(), locked_by = NULL WHERE id = o.id;
    PERFORM _release_stock(o);
    DELETE FROM order_secrets WHERE order_id = o.id;
    PERFORM _risk_mark(o.customer_phone, 'Commande refusée à l''appel', o.id);
    PERFORM _log_status(o.id, 'in_call', 'refused', p_actor, 'Refusée par le client');
  END IF;
  RETURN jsonb_build_object('status', (SELECT status FROM orders WHERE id = o.id));
END $$;

-- Libère les commandes laissées en appel plus de 15 minutes (tâche périodique)
CREATE FUNCTION fn_release_stale_locks() RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT id, locked_by FROM orders WHERE status = 'in_call' AND locked_at < now() - interval '15 minutes' FOR UPDATE SKIP LOCKED LOOP
    UPDATE orders SET status = 'new', locked_by = NULL WHERE id = r.id;
    PERFORM _log_status(r.id, 'in_call', 'new', NULL, 'Verrou expiré');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------
-- Affectation et livraison
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_chief_assign(p_actor uuid, p_order uuid, p_courier uuid) RETURNS void LANGUAGE plpgsql AS $$
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
                    failure_reason = NULL, code_attempts = 0
   WHERE id = o.id;
  PERFORM _log_status(o.id, o.status, 'assigned', p_actor, 'Affectée');
END $$;

CREATE FUNCTION fn_courier_pickup(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  UPDATE orders SET status = 'picked_up' WHERE id = p_order AND courier_id = p_actor AND status = 'assigned' RETURNING * INTO o;
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Commande introuvable ou non affectée à vous'); END IF;
  PERFORM _log_status(o.id, 'assigned', 'picked_up', p_actor, 'Colis récupéré');
END $$;

CREATE FUNCTION fn_courier_depart(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  UPDATE orders SET status = 'on_the_way' WHERE id = p_order AND courier_id = p_actor AND status = 'picked_up' RETURNING * INTO o;
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Récupérez d''abord le colis'); END IF;
  PERFORM _log_status(o.id, 'picked_up', 'on_the_way', p_actor, 'En route');
END $$;

-- Répartition de l'argent d'une commande livrée
CREATE FUNCTION _settle_delivery(o orders) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_avail timestamptz := now() + make_interval(hours => o.unlock_hours);
  v_sup bigint := o.supplier_unit_price * o.qty;
  v_margin bigint := o.margin_unit * o.qty;
  v_prepaid bigint := o.qty_from_seller * o.seller_unit_price;
  v_due_a bigint := o.qty_from_catalog * o.seller_unit_price;
  v_gain bigint; v_gross bigint; v_supplier uuid;
BEGIN
  v_gain  := o.sale_total - o.delivery_fee - o.call_fee - v_due_a;
  v_gross := o.delivery_fee + o.call_fee + v_margin;
  -- contrôle : fournisseur + vendeur + Wallindirain = argent encaissé (+ stock prépayé)
  IF v_gain < 0 OR v_sup + v_gain + v_gross <> o.sale_total + v_prepaid THEN
    PERFORM _err('ledger_mismatch', 'Incohérence comptable détectée : livraison annulée');
  END IF;
  PERFORM _wallet_add(o.seller_id, 'seller_gain', v_gain, o.id, v_avail, 'Commande ' || o.ref);
  IF o.product_id IS NOT NULL THEN
    SELECT supplier_id INTO v_supplier FROM products WHERE id = o.product_id;
    PERFORM _wallet_add(v_supplier, 'supplier_payment', v_sup, o.id, v_avail, 'Commande ' || o.ref);
  END IF;
  PERFORM _wallet_add(_platform(), 'platform_revenue', v_gross, o.id, now(), 'Livraison + call center + marge ' || o.ref);
  PERFORM _wallet_add(_float(), 'float_release', -v_prepaid, o.id, now(), 'Stock prépayé libéré ' || o.ref);
  PERFORM _wallet_add(o.courier_id, 'team_pay', o.courier_pay, o.id, now(), 'Livraison ' || o.ref);
  PERFORM _wallet_add(_platform(), 'team_pay', -o.courier_pay, o.id, now(), 'Livreur ' || o.ref);
  INSERT INTO courier_cash_entries(courier_id, order_id, amount) VALUES (o.courier_id, o.id, o.sale_total);
END $$;

-- Livraison : impossible sans le code du client (5 essais). Renvoie du jsonb pour que
-- les mauvais essais soient enregistrés (une exception annulerait le compteur).
CREATE FUNCTION fn_courier_deliver(p_actor uuid, p_order uuid, p_code text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE o orders; v_max int; v_left int;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order AND courier_id = p_actor FOR UPDATE;
  IF NOT FOUND OR o.status <> 'on_the_way' THEN
    PERFORM _err('invalid_state', 'Commande introuvable ou pas en route');
  END IF;
  v_max := _setting('code_max_attempts')::int;
  IF o.code_attempts >= v_max THEN
    RETURN jsonb_build_object('ok', false, 'locked', true, 'remaining', 0);
  END IF;
  IF p_code IS NULL OR p_code !~ '^[0-9]{4}$' OR _code_hash(p_code, o.id) <> o.delivery_code_hash THEN
    UPDATE orders SET code_attempts = code_attempts + 1 WHERE id = o.id;
    v_left := v_max - (o.code_attempts + 1);
    RETURN jsonb_build_object('ok', false, 'locked', v_left <= 0, 'remaining', GREATEST(v_left, 0));
  END IF;
  UPDATE orders SET status = 'delivered', delivered_at = now(), closed_at = now() WHERE id = o.id RETURNING * INTO o;
  PERFORM _consume_stock(o);
  PERFORM _settle_delivery(o);
  DELETE FROM order_secrets WHERE order_id = o.id;
  PERFORM _log_status(o.id, 'on_the_way', 'delivered', p_actor, 'Livrée avec code client');
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fn_courier_fail(p_actor uuid, p_order uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
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
END $$;

CREATE FUNCTION fn_chief_return_to_warehouse(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief','admin']::user_role[]);
  UPDATE orders SET status = 'return_pending' WHERE id = p_order AND status = 'failed' RETURNING * INTO o;
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Seule une commande en échec peut retourner en entrepôt'); END IF;
  PERFORM _log_status(o.id, 'failed', 'return_pending', p_actor, 'Retour en entrepôt');
END $$;

-- Réception d'un retour : la cause saisie par le magasinier décide qui paie
CREATE FUNCTION fn_warehouse_receive_return(p_actor uuid, p_order uuid, p_cause return_cause) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders; v_supplier uuid; v_prepaid bigint; v_loss bigint; v_fees bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status <> 'return_pending' THEN PERFORM _err('invalid_state', 'Aucun retour attendu pour cette commande'); END IF;
  v_prepaid := o.qty_from_seller * o.seller_unit_price;
  v_fees := o.delivery_fee + o.call_fee;
  IF o.product_id IS NOT NULL THEN SELECT supplier_id INTO v_supplier FROM products WHERE id = o.product_id; END IF;

  IF p_cause = 'customer_refusal' OR (o.formula = 'C' AND p_cause = 'defective') THEN
    -- le vendeur paie frais de retour (livraison) et call center ; le produit retourne en stock
    PERFORM _wallet_add(o.seller_id, 'return_fees', -v_fees, o.id, now(), 'Retour ' || o.ref);
    PERFORM _wallet_add(_platform(), 'return_fees', v_fees, o.id, now(), 'Retour ' || o.ref);
    PERFORM _release_stock(o);
    PERFORM _risk_mark(o.customer_phone, 'Retour : refus du client', o.id);
  ELSIF p_cause = 'defective' THEN
    -- défectueux à l'origine : le fournisseur paie les frais de retour ; pas de remise en stock
    PERFORM _wallet_add(v_supplier, 'return_fee_supplier', -o.delivery_fee, o.id, now(), 'Produit défectueux ' || o.ref);
    PERFORM _wallet_add(_platform(), 'return_fee_supplier', o.delivery_fee, o.id, now(), 'Produit défectueux ' || o.ref);
    IF v_prepaid > 0 THEN   -- le vendeur récupère le stock prépayé perdu
      PERFORM _wallet_add(o.seller_id, 'prepaid_refund', v_prepaid, o.id, now(), 'Stock défectueux ' || o.ref);
      PERFORM _wallet_add(_float(), 'prepaid_refund', -v_prepaid, o.id, now(), 'Stock défectueux ' || o.ref);
    END IF;
    PERFORM _consume_stock(o);
  ELSE
    -- abîmé pendant le transport : à la charge de Wallindirain ; pas de remise en stock
    IF o.product_id IS NOT NULL THEN
      v_loss := o.supplier_unit_price * o.qty;
      PERFORM _wallet_add(v_supplier, 'transport_loss', v_loss, o.id, now(), 'Perte transport ' || o.ref);
      PERFORM _wallet_add(_platform(), 'transport_loss', -v_loss, o.id, now(), 'Perte transport ' || o.ref);
      IF v_prepaid > 0 THEN
        PERFORM _wallet_add(o.seller_id, 'prepaid_refund', v_prepaid, o.id, now(), 'Perte transport ' || o.ref);
        PERFORM _wallet_add(_float(), 'prepaid_refund', -v_prepaid, o.id, now(), 'Perte transport ' || o.ref);
      END IF;
      PERFORM _consume_stock(o);
    END IF;
  END IF;

  UPDATE orders SET status = 'returned', return_cause = p_cause, closed_at = now() WHERE id = o.id;
  DELETE FROM order_secrets WHERE order_id = o.id;
  PERFORM _log_status(o.id, 'return_pending', 'returned', p_actor, 'Cause : ' || p_cause::text);
  PERFORM _audit(p_actor, 'return_received', 'order', o.id::text, jsonb_build_object('cause', p_cause));
END $$;

-- ---------------------------------------------------------------------
-- Caisse du livreur : l'administrateur compte l'argent remis
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_admin_count_cash(p_actor uuid, p_courier uuid, p_counted bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_expected bigint; v_short bigint; v_surplus bigint; v_id uuid := gen_random_uuid();
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_counted IS NULL OR p_counted < 0 THEN PERFORM _err('invalid_input', 'Montant compté invalide'); END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_courier AND role = 'courier') THEN
    PERFORM _err('not_found', 'Livreur introuvable');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cash:' || p_courier::text));
  SELECT COALESCE(sum(amount), 0) INTO v_expected FROM courier_cash_entries WHERE courier_id = p_courier AND count_id IS NULL;
  IF v_expected = 0 AND p_counted = 0 THEN PERFORM _err('invalid_state', 'Aucune caisse à compter pour ce livreur'); END IF;
  v_short := GREATEST(v_expected - p_counted, 0);
  v_surplus := GREATEST(p_counted - v_expected, 0);
  INSERT INTO cash_counts(id, courier_id, admin_id, expected, counted, shortage, surplus)
  VALUES (v_id, p_courier, p_actor, v_expected, p_counted, v_short, v_surplus);
  UPDATE courier_cash_entries SET count_id = v_id WHERE courier_id = p_courier AND count_id IS NULL;
  IF v_short > 0 THEN   -- tout manque est débité au livreur
    PERFORM _wallet_add(p_courier, 'cash_shortage', -v_short, NULL, now(), 'Manque de caisse');
    PERFORM _wallet_add(_platform(), 'cash_shortage', v_short, NULL, now(), 'Manque de caisse livreur');
  END IF;
  PERFORM _audit(p_actor, 'cash_counted', 'courier', p_courier::text,
                 jsonb_build_object('expected', v_expected, 'counted', p_counted, 'shortage', v_short, 'surplus', v_surplus));
  RETURN jsonb_build_object('expected', v_expected, 'counted', p_counted, 'shortage', v_short, 'surplus', v_surplus);
END $$;

-- ---------------------------------------------------------------------
-- Retraits : identité vérifiée + code à 6 chiffres + paiement manuel (version 1)
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_withdrawal_request(p_actor uuid, p_amount bigint, p_method text, p_account text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE u users; v_id uuid := gen_random_uuid(); v_code text; v_min bigint;
BEGIN
  u := _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier']::user_role[]);
  IF NOT u.identity_verified THEN
    PERFORM _err('identity_required', 'Identité non vérifiée : retrait impossible');
  END IF;
  v_min := _setting('min_withdrawal');
  IF p_amount IS NULL OR p_amount < v_min THEN PERFORM _err('below_minimum', 'Retrait minimum : ' || v_min || ' GNF'); END IF;
  IF p_method NOT IN ('orange_money','mtn_momo') THEN PERFORM _err('invalid_input', 'Mode de paiement invalide'); END IF;
  IF p_account IS NULL OR p_account !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro de paiement invalide (9 chiffres)'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wallet:' || p_actor::text));
  IF _wallet_available(p_actor) < p_amount THEN PERFORM _err('insufficient_funds', 'Solde disponible insuffisant'); END IF;
  INSERT INTO withdrawals(id, user_id, amount, method, account_number) VALUES (v_id, p_actor, p_amount, p_method, p_account);
  v_code := _rand_digits(6);
  INSERT INTO one_time_codes(user_id, purpose, code_hash, expires_at, ref_id)
  VALUES (p_actor, 'withdrawal', _code_hash(v_code, v_id), now() + interval '15 minutes', v_id);
  PERFORM _queue_message(u.phone, 'withdrawal_code',
    'Wallindirain : code de confirmation de votre retrait de ' || p_amount || ' GNF : ' || v_code || '. Valable 15 minutes.');
  RETURN v_id;
END $$;

CREATE FUNCTION fn_withdrawal_confirm(p_actor uuid, p_withdrawal uuid, p_code text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE w withdrawals; c one_time_codes;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier']::user_role[]);
  PERFORM pg_advisory_xact_lock(hashtext('wallet:' || p_actor::text));
  SELECT * INTO w FROM withdrawals WHERE id = p_withdrawal AND user_id = p_actor FOR UPDATE;
  IF NOT FOUND OR w.status <> 'pending_code' THEN PERFORM _err('invalid_state', 'Demande de retrait introuvable ou déjà traitée'); END IF;
  SELECT * INTO c FROM one_time_codes WHERE ref_id = w.id AND purpose = 'withdrawal' AND used_at IS NULL FOR UPDATE;
  IF NOT FOUND OR c.expires_at < now() OR c.attempts >= 5 THEN
    UPDATE withdrawals SET status = 'expired' WHERE id = w.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF p_code IS NULL OR c.code_hash <> _code_hash(p_code, w.id) THEN
    UPDATE one_time_codes SET attempts = attempts + 1 WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_code', 'remaining', GREATEST(4 - c.attempts, 0));
  END IF;
  IF _wallet_available(p_actor) < w.amount THEN PERFORM _err('insufficient_funds', 'Solde disponible insuffisant'); END IF;
  UPDATE one_time_codes SET used_at = now() WHERE id = c.id;
  UPDATE withdrawals SET status = 'requested' WHERE id = w.id;
  PERFORM _wallet_add(p_actor, 'withdrawal', -w.amount, NULL, now(), 'Retrait ' || w.method);
  PERFORM _audit(p_actor, 'withdrawal_requested', 'withdrawal', w.id::text, jsonb_build_object('amount', w.amount));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fn_admin_pay_withdrawal(p_actor uuid, p_withdrawal uuid, p_payment_ref text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE w withdrawals; u users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_payment_ref IS NULL OR length(trim(p_payment_ref)) < 3 THEN PERFORM _err('invalid_input', 'Référence de paiement obligatoire'); END IF;
  SELECT * INTO w FROM withdrawals WHERE id = p_withdrawal FOR UPDATE;
  IF NOT FOUND OR w.status <> 'requested' THEN PERFORM _err('invalid_state', 'Retrait introuvable ou non confirmé'); END IF;
  SELECT * INTO u FROM users WHERE id = w.user_id;
  IF NOT u.identity_verified THEN PERFORM _err('identity_required', 'Identité non vérifiée : paiement impossible'); END IF;
  UPDATE withdrawals SET status = 'paid', payment_ref = trim(p_payment_ref), decided_by = p_actor, decided_at = now() WHERE id = w.id;
  PERFORM _audit(p_actor, 'withdrawal_paid', 'withdrawal', w.id::text,
                 jsonb_build_object('amount', w.amount, 'ref', p_payment_ref, 'method', w.method));
END $$;

CREATE FUNCTION fn_admin_reject_withdrawal(p_actor uuid, p_withdrawal uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE w withdrawals;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN PERFORM _err('invalid_input', 'Motif obligatoire'); END IF;
  SELECT * INTO w FROM withdrawals WHERE id = p_withdrawal FOR UPDATE;
  IF NOT FOUND OR w.status <> 'requested' THEN PERFORM _err('invalid_state', 'Retrait introuvable ou non confirmé'); END IF;
  UPDATE withdrawals SET status = 'rejected', decided_by = p_actor, decided_at = now() WHERE id = w.id;
  PERFORM _wallet_add(w.user_id, 'withdrawal_refund', w.amount, NULL, now(), 'Retrait refusé : ' || trim(p_reason));
  PERFORM _audit(p_actor, 'withdrawal_rejected', 'withdrawal', w.id::text, jsonb_build_object('reason', p_reason));
END $$;
