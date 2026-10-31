-- Retour arrière de la migration 039 (stock du vendeur gardé à l'entrepôt).
-- Refuse si des dépôts ou des commandes liées à un dépôt existent (sinon l'information serait perdue).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM seller_deposits) OR EXISTS (SELECT 1 FROM orders WHERE deposit_id IS NOT NULL) THEN
    RAISE EXCEPTION 'retour arrière refusé : des dépôts de vendeur existent';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION _release_stock(o orders) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION _consume_stock(o orders) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION fn_warehouse_handover(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders; v_n int;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status <> 'assigned' OR o.courier_id IS NULL THEN PERFORM _err('invalid_state', 'Ce colis n''est pas en attente de remise'); END IF;
  IF o.product_id IS NULL OR NOT EXISTS (SELECT 1 FROM products p WHERE p.id = o.product_id AND p.storage = 'wallindirain') THEN
    PERFORM _err('invalid_state', 'Ce colis n''est pas stocké à l''entrepôt');
  END IF;
  INSERT INTO order_handovers(order_id, courier_id, handed_by) VALUES (o.id, o.courier_id, p_actor)
  ON CONFLICT (order_id) DO UPDATE SET courier_id = EXCLUDED.courier_id, handed_by = EXCLUDED.handed_by, handed_at = now()
    WHERE order_handovers.courier_id <> EXCLUDED.courier_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN PERFORM _err('invalid_state', 'Colis déjà remis à ce livreur'); END IF;
  PERFORM _audit(p_actor, 'parcel_handed_over', 'order', o.id::text, jsonb_build_object('courier', o.courier_id));
  BEGIN
    PERFORM _notify(o.courier_id, 'order', 'Colis remis', 'Commande ' || o.ref || ' : l''entrepôt vous a remis le colis.', 'orders');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

CREATE OR REPLACE FUNCTION _notify_prepare() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  BEGIN
    IF NEW.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.storage = 'wallindirain') THEN
      FOR r IN SELECT id FROM users WHERE role = 'warehouse' AND status = 'active' AND deleted_at IS NULL LOOP
        PERFORM _notify(r.id, 'order', 'Colis à préparer', 'Commande ' || NEW.ref || ' : un livreur vient la récupérer.', 'todo');
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;

DROP FUNCTION fn_seller_announce_deposit(uuid, text, int);
DROP FUNCTION fn_warehouse_count_deposit(uuid, uuid, int, text);
DROP FUNCTION fn_seller_attach_deposit(uuid, uuid, uuid);
ALTER TABLE orders DROP COLUMN deposit_id;
DROP TABLE seller_deposits;
DELETE FROM settings WHERE key = 'seller_storage_fee';

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

DELETE FROM schema_migrations WHERE name = '039_stock_vendeur_entrepot.sql';
