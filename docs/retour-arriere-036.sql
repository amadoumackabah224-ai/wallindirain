-- RETOUR ARRIÈRE de la migration 036 (accords individuels). JAMAIS AUTOMATIQUE.
-- REFUSE de s'exécuter si un accord individuel a été enregistré : ce sont des conditions conclues avec des personnes, à conserver.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM courier_pay_scales WHERE courier_id IS NOT NULL) OR EXISTS (SELECT 1 FROM agent_terms) THEN
    RAISE EXCEPTION 'Retour arrière refusé : des accords individuels existent (à conserver)';
  END IF;
END $$;
DROP FUNCTION fn_admin_end_agent_agreement(uuid, uuid, text);
DROP FUNCTION fn_admin_set_agent_agreement(uuid, uuid, bigint, timestamptz, text);
DROP FUNCTION fn_admin_end_courier_agreement(uuid, uuid, text);
DROP FUNCTION fn_admin_set_courier_agreement(uuid, uuid, bigint, bigint, bigint, int, bigint, timestamptz, text);
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
  -- 034 : rémunération de l'agent qui a confirmé la commande, versée seulement à la livraison (une seule fois ; ignorée si déjà versée avant 034)
  IF o.confirmed_by IS NOT NULL AND o.agent_pay > 0
     AND NOT EXISTS (SELECT 1 FROM wallet_entries WHERE order_id = o.id AND user_id = o.confirmed_by AND kind = 'team_pay') THEN
    PERFORM _wallet_add(o.confirmed_by, 'team_pay', o.agent_pay, o.id, now(), 'Commande ' || o.ref || ' confirmée et livrée');
    PERFORM _wallet_add(_platform(), 'team_pay', -o.agent_pay, o.id, now(), 'Agent ' || o.ref);
  END IF;
  INSERT INTO courier_cash_entries(courier_id, order_id, amount) VALUES (o.courier_id, o.id, o.sale_total);
END $$;

CREATE OR REPLACE FUNCTION _courier_pay_quote(o orders, p_courier uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN _courier_kind(p_courier) = 'company' AND _company_scale() IS NOT NULL
              THEN LEAST((SELECT per_delivery FROM courier_pay_scales WHERE id = _company_scale()), o.delivery_fee) ELSE o.courier_pay END
$$;
DROP FUNCTION _agent_pay_for(orders);
DROP FUNCTION _courier_scale(uuid);
CREATE OR REPLACE FUNCTION _company_scale() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN per_delivery > 0 THEN id END FROM courier_pay_scales WHERE effective_from <= now() ORDER BY effective_from DESC, created_at DESC LIMIT 1
$$;
DROP TABLE agent_terms;
ALTER TABLE courier_pay_scales DROP COLUMN courier_id;

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

DELETE FROM schema_migrations WHERE name = '036_accords_individuels.sql';
COMMIT;
