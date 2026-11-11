-- 061 : Boutique (Mes finances, profils entreprise) — produits et stock, vente rapide, clôture de caisse.
-- Une vente = une transaction « Revenus de vente · Produit » + ses lignes (prix et coût figés au moment de la vente, pour la marge)
-- + le stock qui baisse. Annuler une vente annule la transaction et remet le stock. Un réapprovisionnement peut créer la dépense « Marchandises à vendre ».
CREATE TABLE pf_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  price       bigint NOT NULL CHECK (price > 0 AND price <= 100000000000),
  cost        bigint NOT NULL DEFAULT 0 CHECK (cost >= 0 AND cost <= 100000000000),
  stock       int CHECK (stock IS NULL OR stock >= 0),
  low_stock   int NOT NULL DEFAULT 0 CHECK (low_stock >= 0),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pf_items_owner ON pf_items(owner_id, created_at);
CREATE TABLE pf_sales (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES pf_accounts(id),
  tx_id      uuid NOT NULL REFERENCES pf_transactions(id),
  occurred_on date NOT NULL,
  total      bigint NOT NULL CHECK (total > 0),
  cost_total bigint NOT NULL CHECK (cost_total >= 0),
  voided_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pf_sales_owner_day ON pf_sales(owner_id, occurred_on);
CREATE TABLE pf_sale_lines (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id   uuid NOT NULL REFERENCES pf_sales(id),
  item_id   uuid REFERENCES pf_items(id),
  name      text NOT NULL,
  qty       int NOT NULL CHECK (qty > 0),
  unit_price bigint NOT NULL,
  unit_cost  bigint NOT NULL
);
CREATE INDEX pf_sale_lines_sale ON pf_sale_lines(sale_id);
CREATE TABLE pf_cash_close (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES pf_accounts(id),
  day        date NOT NULL,
  expected   bigint NOT NULL,
  counted    bigint NOT NULL CHECK (counted >= 0),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, day)
);

CREATE FUNCTION _pf_gnf_account(p_actor uuid, p_account uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pf_accounts WHERE id = p_account AND owner_id = p_actor AND archived_at IS NULL AND COALESCE(currency, 'GNF') = 'GNF') THEN
    PERFORM _err('invalid_input', 'Choisissez un compte en GNF');
  END IF;
END $$;

CREATE FUNCTION fn_pf_item_save(p_actor uuid, p_id uuid, p_name text, p_price bigint, p_cost bigint, p_stock int, p_low int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pfshop:' || p_actor::text));
  IF length(trim(COALESCE(p_name, ''))) < 2 THEN PERFORM _err('invalid_input', 'Nom trop court'); END IF;
  IF p_price IS NULL OR p_price <= 0 THEN PERFORM _err('invalid_input', 'Prix de vente invalide'); END IF;
  IF COALESCE(p_cost, 0) < 0 OR (p_stock IS NOT NULL AND p_stock < 0) OR COALESCE(p_low, 0) < 0 THEN PERFORM _err('invalid_input', 'Valeur négative'); END IF;
  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM pf_items WHERE owner_id = p_actor AND archived_at IS NULL) >= 500 THEN PERFORM _err('limit', '500 produits au plus'); END IF;
    INSERT INTO pf_items(owner_id, name, price, cost, stock, low_stock) VALUES (p_actor, trim(p_name), p_price, COALESCE(p_cost, 0), p_stock, COALESCE(p_low, 0)) RETURNING id INTO v_id;
  ELSE
    UPDATE pf_items SET name = trim(p_name), price = p_price, cost = COALESCE(p_cost, 0), stock = p_stock, low_stock = COALESCE(p_low, 0) WHERE id = p_id AND owner_id = p_actor RETURNING id INTO v_id;
    IF v_id IS NULL THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_pf_item_archive(p_actor uuid, p_id uuid, p_archived boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  UPDATE pf_items SET archived_at = CASE WHEN p_archived THEN now() ELSE NULL END WHERE id = p_id AND owner_id = p_actor;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
END $$;

-- Réapprovisionnement : ajoute au stock ; le prix d'achat devient le coût du produit ; avec un compte, la dépense « Marchandises à vendre » est enregistrée.
CREATE FUNCTION fn_pf_item_restock(p_actor uuid, p_id uuid, p_qty int, p_unit_cost bigint, p_account uuid, p_day date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i pf_items;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pfshop:' || p_actor::text));
  IF p_qty IS NULL OR p_qty <= 0 OR p_qty > 1000000 THEN PERFORM _err('invalid_input', 'Quantité invalide'); END IF;
  SELECT * INTO i FROM pf_items WHERE id = p_id AND owner_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p_unit_cost IS NOT NULL AND p_unit_cost < 0 THEN PERFORM _err('invalid_input', 'Prix d''achat invalide'); END IF;
  UPDATE pf_items SET stock = COALESCE(stock, 0) + p_qty, cost = COALESCE(p_unit_cost, cost) WHERE id = p_id;
  IF p_account IS NOT NULL AND COALESCE(p_unit_cost, 0) > 0 THEN
    PERFORM _pf_gnf_account(p_actor, p_account);
    PERFORM fn_pf_tx_add(p_actor, p_account, 'expense', p_qty::bigint * p_unit_cost, 'goods', 'Réapprovisionnement : ' || i.name || ' × ' || p_qty, COALESCE(p_day, current_date));
  END IF;
END $$;

-- Vente rapide : p_lines = [{item_id, qty}]
CREATE FUNCTION fn_pf_sale_add(p_actor uuid, p_account uuid, p_day date, p_lines jsonb, p_note text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE l jsonb; i pf_items; v_qty int; v_total bigint := 0; v_cost bigint := 0; v_tx uuid; v_sale uuid; v_desc text := ''; v_seen uuid[] := '{}';
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pfshop:' || p_actor::text));
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN PERFORM _err('invalid_input', 'Aucun produit dans la vente'); END IF;
  IF jsonb_array_length(p_lines) > 100 THEN PERFORM _err('invalid_input', '100 lignes au plus'); END IF;
  PERFORM _pf_gnf_account(p_actor, p_account);
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_qty := (l->>'qty')::int;
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty > 100000 THEN PERFORM _err('invalid_input', 'Quantité invalide'); END IF;
    SELECT * INTO i FROM pf_items WHERE id = (l->>'item_id')::uuid AND owner_id = p_actor AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
    IF i.id = ANY(v_seen) THEN PERFORM _err('invalid_input', 'Un produit ne peut apparaître qu''une fois'); END IF;
    v_seen := v_seen || i.id;
    IF i.stock IS NOT NULL AND i.stock < v_qty THEN PERFORM _err('invalid_state', 'Stock insuffisant : ' || i.name || ' (il en reste ' || i.stock || ')'); END IF;
    v_total := v_total + i.price * v_qty; v_cost := v_cost + i.cost * v_qty;
    v_desc := v_desc || CASE WHEN v_desc = '' THEN '' ELSE ', ' END || v_qty || '× ' || i.name;
  END LOOP;
  v_tx := fn_pf_tx_add(p_actor, p_account, 'income', v_total, 'sales_product', left(COALESCE(NULLIF(trim(p_note), ''), 'Vente : ' || v_desc), 200), p_day);
  INSERT INTO pf_sales(owner_id, account_id, tx_id, occurred_on, total, cost_total) VALUES (p_actor, p_account, v_tx, p_day, v_total, v_cost) RETURNING id INTO v_sale;
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO i FROM pf_items WHERE id = (l->>'item_id')::uuid;
    INSERT INTO pf_sale_lines(sale_id, item_id, name, qty, unit_price, unit_cost) VALUES (v_sale, i.id, i.name, (l->>'qty')::int, i.price, i.cost);
    UPDATE pf_items SET stock = stock - (l->>'qty')::int WHERE id = i.id AND stock IS NOT NULL;
  END LOOP;
  RETURN jsonb_build_object('id', v_sale, 'total', v_total);
END $$;

CREATE FUNCTION fn_pf_sale_void(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s pf_sales; l pf_sale_lines;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  PERFORM pg_advisory_xact_lock(hashtext('pfshop:' || p_actor::text));
  SELECT * INTO s FROM pf_sales WHERE id = p_id AND owner_id = p_actor AND voided_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Vente introuvable'); END IF;
  PERFORM fn_pf_tx_void(p_actor, s.tx_id);
  FOR l IN SELECT * FROM pf_sale_lines WHERE sale_id = s.id LOOP
    UPDATE pf_items SET stock = stock + l.qty WHERE id = l.item_id AND stock IS NOT NULL;
  END LOOP;
  UPDATE pf_sales SET voided_at = now() WHERE id = s.id;
END $$;

-- Clôture de caisse : ce qu'il devrait y avoir (solde du compte à la fin du jour) contre ce qui est compté. Un seul constat par compte et par jour (le refaire le remplace).
CREATE FUNCTION fn_pf_cash_close(p_actor uuid, p_account uuid, p_day date, p_counted bigint, p_note text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_exp bigint;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM _pf_gnf_account(p_actor, p_account);
  IF p_day > current_date THEN PERFORM _err('invalid_input', 'Date dans le futur'); END IF;
  IF p_counted IS NULL OR p_counted < 0 THEN PERFORM _err('invalid_input', 'Montant compté invalide'); END IF;
  SELECT a.opening_balance + COALESCE((SELECT sum(CASE WHEN t.kind IN ('income','transfer_in') THEN t.amount ELSE -t.amount END) FROM pf_transactions t
          WHERE t.account_id = a.id AND t.voided_at IS NULL AND t.occurred_on <= p_day), 0)
    INTO v_exp FROM pf_accounts a WHERE a.id = p_account;
  INSERT INTO pf_cash_close(owner_id, account_id, day, expected, counted, note) VALUES (p_actor, p_account, p_day, v_exp, p_counted, NULLIF(left(trim(COALESCE(p_note, '')), 200), ''))
  ON CONFLICT (account_id, day) DO UPDATE SET expected = EXCLUDED.expected, counted = EXCLUDED.counted, note = EXCLUDED.note, created_at = now();
  RETURN jsonb_build_object('expected', v_exp, 'counted', p_counted, 'diff', p_counted - v_exp);
END $$;

-- Effacement des données Mes finances (058) et anonymisation : y ajouter la boutique.
DO $$
DECLARE d text; a text := 'DELETE FROM pf_payroll_pay WHERE owner_id = p_actor;';
BEGIN
  SELECT pg_get_functiondef('fn_pf_erase(uuid,text)'::regprocedure) INTO d;
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'fn_pf_erase : repère introuvable'; END IF;
  EXECUTE replace(d, a, 'DELETE FROM pf_sale_lines WHERE sale_id IN (SELECT id FROM pf_sales WHERE owner_id = p_actor);' || E'\n  '
    || 'DELETE FROM pf_sales WHERE owner_id = p_actor;' || E'\n  ' || 'DELETE FROM pf_cash_close WHERE owner_id = p_actor;' || E'\n  '
    || 'DELETE FROM pf_items WHERE owner_id = p_actor;' || E'\n  ' || a);
END $$;
CREATE FUNCTION trg_pf_shop_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pf_sale_lines WHERE sale_id IN (SELECT id FROM pf_sales WHERE owner_id = NEW.id);
  DELETE FROM pf_sales WHERE owner_id = NEW.id;
  DELETE FROM pf_cash_close WHERE owner_id = NEW.id;
  DELETE FROM pf_items WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER users_pf_shop_anonymized BEFORE UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_shop_anonymized();

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

GRANT SELECT ON pf_all_tx TO wld_app;
