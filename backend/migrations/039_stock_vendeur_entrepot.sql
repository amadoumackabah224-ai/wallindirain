-- 039 : stock du vendeur gardé à l'entrepôt Wallindirain.
-- Le vendeur annonce un dépôt, le magasinier le compte, puis les commandes « produit propre » peuvent en sortir.
-- Aucun gain n'est modifié : les commandes restent des commandes « produit propre » (formule C).
-- Le frais de stockage est un réglage enregistré à 0 : il n'est PAS facturé par cette version.
INSERT INTO settings(key, value, label) VALUES
  ('seller_storage_fee', 0, 'Frais de stockage du stock vendeur, GNF par unité et par mois (enregistré, pas encore facturé)');

CREATE TABLE seller_deposits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  announced_qty int  NOT NULL CHECK (announced_qty > 0),
  qty           int  NOT NULL DEFAULT 0 CHECK (qty >= 0),
  reserved_qty  int  NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  status        text NOT NULL DEFAULT 'announced' CHECK (status IN ('announced','stored')),
  count_note    text,
  counted_by    uuid REFERENCES users(id),
  counted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved_qty <= qty)
);
CREATE INDEX seller_deposits_seller_idx ON seller_deposits(seller_id);
ALTER TABLE orders ADD COLUMN deposit_id uuid REFERENCES seller_deposits(id);

CREATE FUNCTION fn_seller_announce_deposit(p_actor uuid, p_name text, p_qty int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_name text := trim(COALESCE(p_name, ''));
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF length(v_name) < 2 OR length(v_name) > 120 THEN PERFORM _err('invalid_input', 'Nom du produit invalide (2 à 120 caractères)'); END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 100000 THEN PERFORM _err('invalid_input', 'Quantité invalide'); END IF;
  INSERT INTO seller_deposits(seller_id, name, announced_qty) VALUES (p_actor, v_name, p_qty) RETURNING id INTO v_id;
  PERFORM _audit(p_actor, 'deposit_announced', 'deposit', v_id::text, jsonb_build_object('qty', p_qty));
  BEGIN
    PERFORM _notify(r.id, 'product', 'Dépôt de vendeur annoncé', v_name || ' : ' || p_qty || ' unité(s) à compter.', 'todo')
      FROM users r WHERE r.role = 'warehouse' AND r.status = 'active' AND r.deleted_at IS NULL;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_warehouse_count_deposit(p_actor uuid, p_deposit uuid, p_counted int, p_note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d seller_deposits; v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  IF p_counted IS NULL OR p_counted < 0 OR p_counted > 1000000 THEN PERFORM _err('invalid_input', 'Quantité comptée invalide'); END IF;
  SELECT * INTO d FROM seller_deposits WHERE id = p_deposit FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Dépôt introuvable'); END IF;
  IF d.status <> 'announced' THEN PERFORM _err('invalid_state', 'Dépôt déjà compté'); END IF;
  IF p_counted <> d.announced_qty AND (v_note IS NULL OR length(v_note) < 3 OR length(v_note) > 300) THEN
    PERFORM _err('invalid_input', 'Expliquez l''écart avec la quantité annoncée (3 à 300 caractères)');
  END IF;
  UPDATE seller_deposits SET qty = p_counted, status = 'stored', count_note = v_note, counted_by = p_actor, counted_at = now() WHERE id = d.id;
  PERFORM _audit(p_actor, 'deposit_counted', 'deposit', d.id::text, jsonb_build_object('announced', d.announced_qty, 'counted', p_counted));
  BEGIN
    PERFORM _notify(d.seller_id, 'product', 'Dépôt compté', d.name || ' : ' || p_counted || ' unité(s) reçue(s) sur ' || d.announced_qty || ' annoncée(s).', 'todo');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- Rattache une commande « produit propre » du vendeur à son dépôt : réserve la quantité (atomique) ; le colis sort de l'entrepôt
CREATE FUNCTION fn_seller_attach_deposit(p_actor uuid, p_order uuid, p_deposit uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders; d seller_deposits;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.formula <> 'C' OR o.deposit_id IS NOT NULL THEN PERFORM _err('invalid_state', 'Cette commande ne peut pas être liée à un dépôt'); END IF;
  IF o.status NOT IN ('new','in_call','confirmed') THEN PERFORM _err('invalid_state', 'Commande déjà en cours de livraison'); END IF;
  SELECT * INTO d FROM seller_deposits WHERE id = p_deposit AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Dépôt introuvable'); END IF;
  IF d.status <> 'stored' THEN PERFORM _err('invalid_state', 'Ce dépôt n''a pas encore été compté par l''entrepôt'); END IF;
  IF d.qty - d.reserved_qty < o.qty THEN PERFORM _err('insufficient_stock', 'Stock insuffisant dans ce dépôt : ' || (d.qty - d.reserved_qty) || ' disponible(s)'); END IF;
  UPDATE seller_deposits SET reserved_qty = reserved_qty + o.qty WHERE id = d.id;
  UPDATE orders SET deposit_id = d.id, pickup_detail = 'Entrepôt Wallindirain' WHERE id = o.id;
  PERFORM _audit(p_actor, 'deposit_attached', 'order', o.id::text, jsonb_build_object('deposit', d.id, 'qty', o.qty));
END $$;

-- Réservation libérée / sortie définitive : le dépôt est géré comme le stock du catalogue
CREATE OR REPLACE FUNCTION _release_stock(o orders) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF o.deposit_id IS NOT NULL THEN
    UPDATE seller_deposits SET reserved_qty = reserved_qty - o.qty WHERE id = o.deposit_id;
    RETURN;
  END IF;
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
  IF o.deposit_id IS NOT NULL THEN
    UPDATE seller_deposits SET qty = qty - o.qty, reserved_qty = reserved_qty - o.qty WHERE id = o.deposit_id;
    RETURN;
  END IF;
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
  IF o.deposit_id IS NULL AND (o.product_id IS NULL OR NOT EXISTS (SELECT 1 FROM products p WHERE p.id = o.product_id AND p.storage = 'wallindirain')) THEN
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
    IF NEW.deposit_id IS NOT NULL OR (NEW.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.storage = 'wallindirain')) THEN
      FOR r IN SELECT id FROM users WHERE role = 'warehouse' AND status = 'active' AND deleted_at IS NULL LOOP
        PERFORM _notify(r.id, 'order', 'Colis à préparer', 'Commande ' || NEW.ref || ' : un livreur vient la récupérer.', 'todo');
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
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
