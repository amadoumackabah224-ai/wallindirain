-- 032 : inventaire physique de l'entrepôt.
-- Le magasinier compte ce qu'il y a réellement en rayon pour un produit. L'application compare avec ce qui est attendu.
-- Écart nul : enregistré tel quel. Écart non nul : explication obligatoire ET décision de l'administrateur avant toute modification du stock.
-- Aucune écriture d'argent, aucun tarif, aucun pourcentage : seul le stock du catalogue peut être corrigé, jamais en dessous des unités réservées.

CREATE TABLE stock_counts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id),
  expected_qty int  NOT NULL CHECK (expected_qty >= 0),   -- attendu en rayon au moment du comptage
  counted_qty  int  NOT NULL CHECK (counted_qty >= 0),
  delta        int  NOT NULL,                             -- compté - attendu
  note         text CHECK (note IS NULL OR length(note) BETWEEN 3 AND 300),
  status       text NOT NULL CHECK (status IN ('matched','pending','approved','rejected')),
  counted_by   uuid NOT NULL REFERENCES users(id),
  counted_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_by  uuid REFERENCES users(id),
  reviewed_at  timestamptz,
  review_note  text CHECK (review_note IS NULL OR length(review_note) BETWEEN 3 AND 300),
  CHECK ((delta = 0) = (status = 'matched'))
);
CREATE UNIQUE INDEX stock_counts_one_pending_uq ON stock_counts(product_id) WHERE status = 'pending';
CREATE INDEX stock_counts_product_idx ON stock_counts(product_id, counted_at DESC);

-- Attendu en rayon = stock du catalogue + stock prépayé des vendeurs - colis déjà sortis (chez le livreur ou en retour, pas encore revenus)
CREATE FUNCTION _expected_shelf(p_product uuid) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT GREATEST(
    COALESCE((SELECT stock_qty FROM products WHERE id = p_product), 0)
    + COALESCE((SELECT sum(qty) FROM seller_stock WHERE product_id = p_product), 0)
    - COALESCE((SELECT sum(qty_from_catalog + qty_from_seller) FROM orders WHERE product_id = p_product AND formula <> 'C'
                 AND status IN ('picked_up','on_the_way','failed','return_pending')), 0), 0)::int
$$;

-- lecture pour l'écran du magasinier (les fonctions « _ » ne sont pas appelables par l'application)
CREATE FUNCTION fn_warehouse_expected(p_actor uuid) RETURNS TABLE(product_id uuid, expected int, pending boolean) LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  RETURN QUERY SELECT p.id, _expected_shelf(p.id), EXISTS (SELECT 1 FROM stock_counts c WHERE c.product_id = p.id AND c.status = 'pending')
                 FROM products p WHERE p.storage = 'wallindirain' AND p.status = 'approved' AND p.deleted_at IS NULL;
END $$;

CREATE FUNCTION fn_warehouse_count_stock(p_actor uuid, p_product uuid, p_counted int, p_note text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p products; v_exp int; v_note text := NULLIF(trim(COALESCE(p_note, '')), ''); v_id uuid; r record;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  IF p_counted IS NULL OR p_counted < 0 OR p_counted > 1000000 THEN PERFORM _err('invalid_input', 'Quantité comptée invalide'); END IF;
  IF v_note IS NOT NULL AND (length(v_note) < 3 OR length(v_note) > 300) THEN PERFORM _err('invalid_input', 'Explication de 3 à 300 caractères'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.storage <> 'wallindirain' THEN PERFORM _err('invalid_state', 'Ce produit n''est pas stocké à l''entrepôt'); END IF;
  IF EXISTS (SELECT 1 FROM stock_counts WHERE product_id = p.id AND status = 'pending') THEN
    PERFORM _err('invalid_state', 'Un inventaire de ce produit attend déjà la décision de l''administration');
  END IF;
  v_exp := _expected_shelf(p.id);
  IF p_counted <> v_exp AND v_note IS NULL THEN PERFORM _err('note_required', 'Écart avec le stock attendu : expliquez-le en quelques mots'); END IF;
  INSERT INTO stock_counts(product_id, expected_qty, counted_qty, delta, note, status, counted_by)
  VALUES (p.id, v_exp, p_counted, p_counted - v_exp, v_note, CASE WHEN p_counted = v_exp THEN 'matched' ELSE 'pending' END, p_actor) RETURNING id INTO v_id;
  PERFORM _audit(p_actor, 'stock_counted', 'product', p.id::text, jsonb_build_object('expected', v_exp, 'counted', p_counted));
  IF p_counted <> v_exp THEN
    BEGIN
      FOR r IN SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LOOP
        PERFORM _notify(r.id, 'product', 'Inventaire à valider', p.name || ' : attendu ' || v_exp || ', compté ' || p_counted || '. ' || v_note, 'products');
      END LOOP;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_admin_review_stock_count(p_actor uuid, p_count uuid, p_approve boolean, p_note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c stock_counts; p products; v_note text := NULLIF(trim(COALESCE(p_note, '')), ''); v_new int;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF v_note IS NOT NULL AND (length(v_note) < 3 OR length(v_note) > 300) THEN PERFORM _err('invalid_input', 'Note de 3 à 300 caractères'); END IF;
  SELECT * INTO c FROM stock_counts WHERE id = p_count FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Inventaire introuvable'); END IF;
  IF c.status <> 'pending' THEN PERFORM _err('invalid_state', 'Inventaire déjà traité'); END IF;
  IF p_approve THEN
    SELECT * INTO p FROM products WHERE id = c.product_id FOR UPDATE;
    v_new := p.stock_qty + c.delta;
    IF v_new < p.reserved_qty THEN
      PERFORM _err('invalid_input', 'Correction impossible : le stock tomberait à ' || GREATEST(v_new, 0) || ' alors que ' || p.reserved_qty || ' unité(s) sont réservées. Refusez et faites recompter.');
    END IF;
    UPDATE products SET stock_qty = v_new WHERE id = p.id;
  ELSIF v_note IS NULL THEN
    PERFORM _err('note_required', 'Expliquez le refus en quelques mots');
  END IF;
  UPDATE stock_counts SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, reviewed_by = p_actor, reviewed_at = now(), review_note = v_note WHERE id = c.id;
  PERFORM _audit(p_actor, CASE WHEN p_approve THEN 'stock_count_approved' ELSE 'stock_count_rejected' END, 'product', c.product_id::text, jsonb_build_object('delta', c.delta));
  BEGIN
    SELECT * INTO p FROM products WHERE id = c.product_id;
    PERFORM _notify(c.counted_by, 'product', CASE WHEN p_approve THEN 'Inventaire validé' ELSE 'Inventaire refusé' END,
      p.name || (CASE WHEN p_approve THEN ' : stock corrigé (' || CASE WHEN c.delta > 0 THEN '+' ELSE '' END || c.delta || ').' ELSE ' : recomptez. ' || v_note END), 'history');
    IF p_approve THEN
      PERFORM _notify(p.supplier_id, 'product', 'Stock corrigé après inventaire', p.name || ' : ' || CASE WHEN c.delta > 0 THEN '+' ELSE '' END || c.delta || ' unité(s). ' || COALESCE(c.note, ''), 'products');
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- Remise à zéro de l'activité : vide aussi les inventaires
CREATE OR REPLACE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 stock_counts, order_handovers, return_notes, return_photos, stock_losses, order_history, calls, risky_customers, sheet_imports, order_requests, mission_offers, tour_stops, tours, orders, arrivals, seller_stock, messages, one_time_codes, proofs
    RESTART IDENTITY;
  UPDATE products SET stock_qty = 0, reserved_qty = 0;
  PERFORM _audit(p_actor, 'activity_reset', 'system', NULL, jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries));
  RETURN jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries);
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
