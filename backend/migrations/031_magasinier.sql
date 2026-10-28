-- 031 : espace du magasinier complet.
--  * colis à remettre aux livreurs (enregistrement de la remise, information seulement : le livreur confirme toujours lui-même la récupération)
--  * déclaration de casse / perte en stock (retire du stock vendable, jamais en dessous des unités déjà réservées ; AUCUN montant n'est écrit)
--  * écart de comptage d'un arrivage : explication obligatoire, fournisseur et administrateurs prévenus
--  * note et photos à la réception d'un retour
--  * alertes dans la cloche : arrivage annoncé, colis à préparer
-- Aucune fonction d'argent n'est modifiée (fn_warehouse_receive_return, _settle_delivery, portefeuilles : inchangés).

ALTER TABLE arrivals ADD COLUMN count_note text CHECK (count_note IS NULL OR length(count_note) BETWEEN 3 AND 300);

CREATE TABLE order_handovers (
  order_id   uuid PRIMARY KEY REFERENCES orders(id),
  courier_id uuid NOT NULL REFERENCES users(id),
  handed_by  uuid NOT NULL REFERENCES users(id),
  handed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_losses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id),
  qty         int  NOT NULL CHECK (qty > 0),
  reason      text NOT NULL CHECK (reason IN ('damaged','lost','expired','other')),
  note        text NOT NULL CHECK (length(note) BETWEEN 3 AND 300),
  declared_by uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_losses_product_idx ON stock_losses(product_id, created_at DESC);
CREATE TRIGGER stock_losses_immutable BEFORE UPDATE OR DELETE ON stock_losses FOR EACH ROW EXECUTE FUNCTION trg_append_only();

CREATE TABLE return_notes (
  order_id   uuid PRIMARY KEY REFERENCES orders(id),
  note       text NOT NULL CHECK (length(note) BETWEEN 3 AND 300),
  noted_by   uuid NOT NULL REFERENCES users(id),
  noted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data        bytea NOT NULL CHECK (octet_length(data) BETWEEN 1000 AND 450000),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX return_photos_order_idx ON return_photos(order_id);

-- ---------- Comptage d'un arrivage : mêmes effets sur le stock qu'avant ; l'écart doit être expliqué ----------
DROP FUNCTION fn_warehouse_count_arrival(uuid, uuid, int);
CREATE FUNCTION fn_warehouse_count_arrival(p_actor uuid, p_arrival uuid, p_counted int, p_note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a arrivals; v_note text := NULLIF(trim(COALESCE(p_note, '')), ''); v_name text; v_supplier uuid; r record;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  IF p_counted IS NULL OR p_counted < 0 THEN PERFORM _err('invalid_input', 'Quantité comptée invalide'); END IF;
  IF v_note IS NOT NULL AND (length(v_note) < 3 OR length(v_note) > 300) THEN PERFORM _err('invalid_input', 'Note de 3 à 300 caractères'); END IF;
  SELECT * INTO a FROM arrivals WHERE id = p_arrival FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Arrivage introuvable'); END IF;
  IF a.counted_qty IS NOT NULL THEN PERFORM _err('invalid_state', 'Arrivage déjà compté'); END IF;
  IF p_counted <> a.announced_qty AND v_note IS NULL THEN
    PERFORM _err('note_required', 'Écart avec la quantité annoncée : expliquez-le en quelques mots');
  END IF;
  UPDATE arrivals SET counted_qty = p_counted, counted_by = p_actor, counted_at = now(), count_note = v_note WHERE id = p_arrival;
  UPDATE products SET stock_qty = stock_qty + p_counted WHERE id = a.product_id;
  SELECT name, supplier_id INTO v_name, v_supplier FROM products WHERE id = a.product_id;
  PERFORM _audit(p_actor, 'arrival_counted', 'arrival', p_arrival::text,
                 jsonb_build_object('announced', a.announced_qty, 'counted', p_counted));
  BEGIN
    IF p_counted = a.announced_qty THEN
      PERFORM _notify(v_supplier, 'product', 'Arrivage compté', v_name || ' : ' || p_counted || ' unité(s) reçues, désormais vendables.', 'products');
    ELSE
      PERFORM _notify(v_supplier, 'product', 'Écart sur votre arrivage', v_name || ' : ' || a.announced_qty || ' annoncée(s), ' || p_counted || ' comptée(s). ' || v_note, 'products');
      FOR r IN SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LOOP
        PERFORM _notify(r.id, 'product', 'Écart de comptage', v_name || ' : ' || a.announced_qty || ' annoncée(s), ' || p_counted || ' comptée(s). ' || v_note, 'dash');
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- ---------- Remise à zéro de l'activité : vide aussi les tables du magasinier (elles référencent les commandes et les produits) ----------
CREATE OR REPLACE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 order_handovers, return_notes, return_photos, stock_losses, order_history, calls, risky_customers, sheet_imports, order_requests, mission_offers, tour_stops, tours, orders, arrivals, seller_stock, messages, one_time_codes, proofs
    RESTART IDENTITY;
  UPDATE products SET stock_qty = 0, reserved_qty = 0;
  PERFORM _audit(p_actor, 'activity_reset', 'system', NULL, jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries));
  RETURN jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries);
END $$;

-- ---------- Alertes pour le magasinier ----------
CREATE FUNCTION _notify_arrival() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; v_name text;
BEGIN
  BEGIN
    SELECT name INTO v_name FROM products WHERE id = NEW.product_id;
    FOR r IN SELECT id FROM users WHERE role = 'warehouse' AND status = 'active' AND deleted_at IS NULL LOOP
      PERFORM _notify(r.id, 'product', 'Arrivage annoncé', v_name || ' : ' || NEW.announced_qty || ' unité(s) à compter.', 'todo');
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER arrivals_notify AFTER INSERT ON arrivals FOR EACH ROW EXECUTE FUNCTION _notify_arrival();

CREATE FUNCTION _notify_prepare() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER orders_notify_prepare AFTER UPDATE OF status ON orders FOR EACH ROW
  WHEN (NEW.status = 'assigned' AND OLD.status IS DISTINCT FROM 'assigned') EXECUTE FUNCTION _notify_prepare();

-- ---------- Remise d'un colis au livreur ----------
CREATE FUNCTION fn_warehouse_handover(p_actor uuid, p_order uuid) RETURNS void LANGUAGE plpgsql AS $$
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

-- ---------- Casse / perte en stock : retire du stock vendable (jamais sous le réservé), aucune écriture d'argent ----------
CREATE FUNCTION fn_warehouse_declare_loss(p_actor uuid, p_product uuid, p_qty int, p_reason text, p_note text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p products; v_note text := trim(COALESCE(p_note, '')); v_id uuid; r record; v_label text;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  IF p_reason NOT IN ('damaged','lost','expired','other') THEN PERFORM _err('invalid_input', 'Motif invalide'); END IF;
  IF length(v_note) < 3 OR length(v_note) > 300 THEN PERFORM _err('invalid_input', 'Expliquez en quelques mots (3 à 300 caractères)'); END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 100000 THEN PERFORM _err('invalid_input', 'Quantité invalide'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.storage <> 'wallindirain' THEN PERFORM _err('invalid_state', 'Ce produit n''est pas stocké à l''entrepôt'); END IF;
  IF p.stock_qty - p.reserved_qty < p_qty THEN
    PERFORM _err('invalid_input', 'Seulement ' || (p.stock_qty - p.reserved_qty) || ' unité(s) libre(s) : les autres sont réservées pour des commandes');
  END IF;
  UPDATE products SET stock_qty = stock_qty - p_qty WHERE id = p.id;
  INSERT INTO stock_losses(product_id, qty, reason, note, declared_by) VALUES (p.id, p_qty, p_reason, v_note, p_actor) RETURNING id INTO v_id;
  PERFORM _audit(p_actor, 'stock_loss', 'product', p.id::text, jsonb_build_object('qty', p_qty, 'reason', p_reason));
  BEGIN
    v_label := CASE p_reason WHEN 'damaged' THEN 'abîmé' WHEN 'lost' THEN 'perdu' WHEN 'expired' THEN 'périmé' ELSE 'retiré du stock' END;
    PERFORM _notify(p.supplier_id, 'product', 'Stock retiré à l''entrepôt', p.name || ' : ' || p_qty || ' unité(s) ' || v_label || '. ' || v_note, 'products');
    FOR r IN SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LOOP
      PERFORM _notify(r.id, 'product', 'Casse ou perte en stock', p.name || ' : ' || p_qty || ' unité(s) ' || v_label || '. ' || v_note, 'dash');
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN v_id;
END $$;

-- ---------- Note et photos à la réception d'un retour (ne change ni le statut ni l'argent) ----------
CREATE FUNCTION fn_warehouse_return_note(p_actor uuid, p_order uuid, p_note text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders; v_note text := trim(COALESCE(p_note, ''));
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  IF length(v_note) < 3 OR length(v_note) > 300 THEN PERFORM _err('invalid_input', 'Note de 3 à 300 caractères'); END IF;
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status <> 'return_pending' THEN PERFORM _err('invalid_state', 'Aucun retour attendu pour cette commande'); END IF;
  INSERT INTO return_notes(order_id, note, noted_by) VALUES (o.id, v_note, p_actor)
  ON CONFLICT (order_id) DO UPDATE SET note = EXCLUDED.note, noted_by = EXCLUDED.noted_by, noted_at = now();
END $$;

CREATE FUNCTION fn_warehouse_add_return_photo(p_actor uuid, p_order uuid, p_mime text, p_data bytea) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE o orders; v_id uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status <> 'return_pending' THEN PERFORM _err('invalid_state', 'Aucun retour attendu pour cette commande'); END IF;
  IF (SELECT count(*) FROM return_photos WHERE order_id = o.id) >= 3 THEN PERFORM _err('invalid_state', '3 photos au maximum par retour'); END IF;
  BEGIN
    INSERT INTO return_photos(order_id, mime, data, created_by) VALUES (o.id, p_mime, p_data, p_actor) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Photo invalide ou trop lourde');
  END;
  RETURN v_id;
END $$;

-- lecture : administration, magasinier, et fournisseur du produit retourné
CREATE FUNCTION fn_return_photo_get(p_actor uuid, p_photo uuid) RETURNS TABLE(mime text, data bytea) LANGUAGE plpgsql AS $$
DECLARE u users; v_supplier uuid;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Compte inactif ou introuvable'); END IF;
  SELECT p.supplier_id INTO v_supplier FROM return_photos rp JOIN orders o ON o.id = rp.order_id LEFT JOIN products p ON p.id = o.product_id WHERE rp.id = p_photo;
  IF NOT FOUND THEN RETURN; END IF;
  IF u.role IN ('admin','warehouse') OR (u.role = 'supplier' AND v_supplier = u.id) THEN NULL;
  ELSE PERFORM _err('forbidden', 'Action non autorisée pour votre rôle'); END IF;
  RETURN QUERY SELECT rp.mime, rp.data FROM return_photos rp WHERE rp.id = p_photo;
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
       AND NOT (r.relname IN ('proofs','avatars','product_images','return_photos') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
