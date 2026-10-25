-- 021 : le refus du client ne coûte plus rien au vendeur. Wallindirain ne gagne que sur une commande livrée ; un refus (client qui ne prend pas le colis)
-- n'est donc plus facturé (ni livraison, ni call center) au vendeur. Le produit retourne en stock, le numéro reste signalé.
-- Inchangé : produit défectueux (frais au fournisseur), abîmé au transport (perte Wallindirain), défectueux sur produit du vendeur lui-même (formule C).

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
       AND NOT (r.relname IN ('proofs','avatars') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
