-- RETOUR ARRIÈRE de la migration 034. JAMAIS AUTOMATIQUE.
-- REFUSE de s'exécuter si un agent a déjà été payé à la livraison (aucune donnée d'argent n'est perdue).
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM wallet_entries WHERE kind = 'team_pay' AND description LIKE '% confirmée et livrée') THEN
    RAISE EXCEPTION 'Retour arrière refusé : des rémunérations d''agent ont déjà été versées à la livraison';
  END IF;
END $$;
UPDATE settings SET label = 'Rémunération agent par commande confirmée (GNF)' WHERE key = 'agent_pay';
UPDATE settings SET label = 'Frais de call center par commande (GNF)' WHERE key = 'call_fee';

CREATE OR REPLACE FUNCTION fn_agent_log_call(p_actor uuid, p_order uuid, p_result call_result, p_note text DEFAULT NULL)
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
    IF _setting('require_delivery_code') = 1 THEN
      SELECT code INTO v_code FROM order_secrets WHERE order_id = o.id;
      PERFORM _queue_message(o.customer_phone, 'delivery_code',
        'Wallindirain : votre commande ' || o.ref || ' est confirmée. Code de livraison : ' || v_code ||
        '. Donnez ce code au livreur uniquement à la réception de votre colis.', o.id);
    ELSE
      PERFORM _queue_message(o.customer_phone, 'order_confirmed',
        'Wallindirain : votre commande ' || o.ref || ' est confirmée. Un livreur vous contactera. Payez à la réception de votre colis.', o.id);
    END IF;
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

DROP FUNCTION fn_warehouse_receive_return(uuid, uuid, return_cause);
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

  IF p_cause = 'customer_refusal' THEN
    -- refus du client : AUCUN frais pour le vendeur (Wallindirain n'a rien gagné, elle supporte le trajet) ; le produit retourne en stock
    PERFORM _release_stock(o);
    PERFORM _risk_mark(o.customer_phone, 'Retour : refus du client', o.id);
  ELSIF o.formula = 'C' AND p_cause = 'defective' THEN
    -- produit du vendeur lui-même défectueux : le vendeur paie frais de retour (livraison) et call center ; le produit retourne en stock
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

DELETE FROM schema_migrations WHERE name = '034_agent_paye_a_la_livraison.sql';
COMMIT;
