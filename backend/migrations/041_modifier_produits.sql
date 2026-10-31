-- 041 : modification des produits et des prix.
--  - le fournisseur modifie le nom et la description de ses produits (immédiat) ;
--  - le fournisseur change son prix : immédiat tant que le produit n'est pas validé ; après validation, c'est une DEMANDE
--    que l'administrateur accepte ou refuse (l'ancien prix reste actif en attendant ; les commandes déjà créées gardent leur prix) ;
--  - l'administrateur peut corriger nom, description et prix de tout produit ;
--  - le vendeur corrige son dépôt tant que le magasinier ne l'a pas compté.
-- Une marge n'est jamais choisie ici sans l'administrateur : à l'acceptation, la marge est recalculée comme à la validation d'un produit.
CREATE TABLE product_price_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id),
  old_price    bigint NOT NULL CHECK (old_price > 0),
  new_price    bigint NOT NULL CHECK (new_price > 0),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid NOT NULL REFERENCES users(id),
  reviewed_by  uuid REFERENCES users(id),
  review_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz,
  CHECK (new_price <> old_price)
);
CREATE UNIQUE INDEX product_price_changes_one_pending ON product_price_changes(product_id) WHERE status = 'pending';
CREATE INDEX product_price_changes_status_idx ON product_price_changes(status, created_at DESC);

-- Même garde-fou que pour la marge : pas de changement de prix tant que du stock prépayé ou des commandes en cours existent
CREATE FUNCTION _price_change_locked(p_product uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM seller_stock WHERE product_id = p_product AND qty > 0)
      OR EXISTS (SELECT 1 FROM orders WHERE product_id = p_product AND status NOT IN ('delivered','returned','refused','cancelled'))
$$;

CREATE FUNCTION _apply_product_price(p_product uuid, p_price bigint, p_margin_bps int) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_margin bigint;
BEGIN
  IF p_margin_bps IS NOT NULL AND (p_margin_bps < 0 OR p_margin_bps > 10000) THEN PERFORM _err('invalid_input', 'Marge invalide'); END IF;
  v_margin := CASE WHEN p_margin_bps IS NULL THEN _margin_for(p_price) ELSE (p_price * p_margin_bps + 5000) / 10000 END;
  UPDATE products SET supplier_price = p_price, margin_unit = v_margin WHERE id = p_product;
  RETURN v_margin;
END $$;

CREATE FUNCTION fn_supplier_edit_product(p_actor uuid, p_product uuid, p_name text, p_description text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products; v_name text := trim(COALESCE(p_name, '')); v_desc text := NULLIF(trim(COALESCE(p_description, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF length(v_name) < 2 OR length(v_name) > 120 THEN PERFORM _err('invalid_input', 'Nom du produit invalide (2 à 120 caractères)'); END IF;
  IF v_desc IS NOT NULL AND length(v_desc) > 1000 THEN PERFORM _err('invalid_input', 'Description trop longue (1000 caractères maximum)'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.status NOT IN ('pending','approved') THEN PERFORM _err('invalid_state', 'Ce produit ne peut plus être modifié'); END IF;
  UPDATE products SET name = v_name, description = v_desc WHERE id = p.id;
  PERFORM _audit(p_actor, 'product_edited', 'product', p.id::text, jsonb_build_object('name_changed', p.name <> v_name));
END $$;

-- Retourne 'applied' (prix changé tout de suite) ou 'pending' (demande envoyée à l'administrateur)
CREATE FUNCTION fn_supplier_set_price(p_actor uuid, p_product uuid, p_price bigint) RETURNS text LANGUAGE plpgsql AS $$
DECLARE p products; r record;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF p_price IS NULL OR p_price < 1 OR p_price > 1000000000 THEN PERFORM _err('invalid_input', 'Prix invalide'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.status = 'pending' THEN
    UPDATE products SET supplier_price = p_price WHERE id = p.id;     -- pas encore validé : la marge sera fixée à la validation
    PERFORM _audit(p_actor, 'product_price_set', 'product', p.id::text, jsonb_build_object('from', p.supplier_price, 'to', p_price));
    RETURN 'applied';
  END IF;
  IF p.status <> 'approved' THEN PERFORM _err('invalid_state', 'Ce produit ne peut plus être modifié'); END IF;
  IF p_price = p.supplier_price THEN PERFORM _err('invalid_input', 'C''est déjà le prix actuel'); END IF;
  UPDATE product_price_changes SET status = 'rejected', reviewed_at = now(), review_note = 'Remplacée par une nouvelle demande' WHERE product_id = p.id AND status = 'pending';
  INSERT INTO product_price_changes(product_id, old_price, new_price, requested_by) VALUES (p.id, p.supplier_price, p_price, p_actor);
  PERFORM _audit(p_actor, 'product_price_requested', 'product', p.id::text, jsonb_build_object('from', p.supplier_price, 'to', p_price));
  BEGIN
    FOR r IN SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LOOP
      PERFORM _notify(r.id, 'product', 'Changement de prix demandé', p.name || ' : ' || p.supplier_price || ' → ' || p_price || ' GNF. À valider.', 'dash');
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN 'pending';
END $$;

CREATE FUNCTION fn_admin_review_price_change(p_actor uuid, p_change uuid, p_approve boolean, p_margin_bps int DEFAULT NULL, p_note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c product_price_changes; p products; v_margin bigint; v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO c FROM product_price_changes WHERE id = p_change FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Demande introuvable'); END IF;
  IF c.status <> 'pending' THEN PERFORM _err('invalid_state', 'Cette demande a déjà été traitée'); END IF;
  SELECT * INTO p FROM products WHERE id = c.product_id FOR UPDATE;
  IF v_note IS NOT NULL AND length(v_note) > 300 THEN PERFORM _err('invalid_input', 'Note trop longue'); END IF;
  IF p_approve THEN
    IF p.supplier_price <> c.old_price THEN PERFORM _err('invalid_state', 'Le prix du produit a changé depuis la demande : refusez-la et demandez une nouvelle demande'); END IF;
    IF _price_change_locked(p.id) THEN PERFORM _err('price_locked', 'Prix verrouillé : du stock prépayé ou des commandes en cours existent pour ce produit'); END IF;
    v_margin := _apply_product_price(p.id, c.new_price, p_margin_bps);
  END IF;
  UPDATE product_price_changes SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, reviewed_by = p_actor, review_note = v_note, reviewed_at = now() WHERE id = c.id;
  PERFORM _audit(p_actor, CASE WHEN p_approve THEN 'product_price_approved' ELSE 'product_price_rejected' END, 'product', p.id::text,
                 jsonb_build_object('from', c.old_price, 'to', c.new_price, 'margin_unit', v_margin));
  BEGIN
    PERFORM _notify(p.supplier_id, 'product', CASE WHEN p_approve THEN 'Nouveau prix accepté' ELSE 'Changement de prix refusé' END,
      p.name || ' : ' || CASE WHEN p_approve THEN 'le prix est maintenant ' || c.new_price || ' GNF.' ELSE 'le prix reste ' || c.old_price || ' GNF.' || COALESCE(' ' || v_note, '') END, 'products');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

CREATE FUNCTION fn_admin_edit_product(p_actor uuid, p_product uuid, p_name text, p_description text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products; v_name text := trim(COALESCE(p_name, '')); v_desc text := NULLIF(trim(COALESCE(p_description, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF length(v_name) < 2 OR length(v_name) > 120 THEN PERFORM _err('invalid_input', 'Nom du produit invalide (2 à 120 caractères)'); END IF;
  IF v_desc IS NOT NULL AND length(v_desc) > 1000 THEN PERFORM _err('invalid_input', 'Description trop longue (1000 caractères maximum)'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  UPDATE products SET name = v_name, description = v_desc WHERE id = p.id;
  PERFORM _audit(p_actor, 'product_edited_by_admin', 'product', p.id::text, '{}'::jsonb);
END $$;

CREATE FUNCTION fn_admin_set_product_price(p_actor uuid, p_product uuid, p_price bigint, p_margin_bps int DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products; v_margin bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_price IS NULL OR p_price < 1 OR p_price > 1000000000 THEN PERFORM _err('invalid_input', 'Prix invalide'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND status = 'approved' AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit approuvé introuvable'); END IF;
  IF _price_change_locked(p.id) THEN PERFORM _err('price_locked', 'Prix verrouillé : du stock prépayé ou des commandes en cours existent pour ce produit'); END IF;
  v_margin := _apply_product_price(p.id, p_price, p_margin_bps);
  UPDATE product_price_changes SET status = 'rejected', reviewed_by = p_actor, reviewed_at = now(), review_note = 'Remplacée par une modification de l''administrateur' WHERE product_id = p.id AND status = 'pending';
  PERFORM _audit(p_actor, 'product_price_set_by_admin', 'product', p.id::text, jsonb_build_object('from', p.supplier_price, 'to', p_price, 'margin_unit', v_margin));
END $$;

CREATE FUNCTION fn_seller_edit_deposit(p_actor uuid, p_deposit uuid, p_name text, p_qty int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d seller_deposits; v_name text := trim(COALESCE(p_name, ''));
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF length(v_name) < 2 OR length(v_name) > 120 THEN PERFORM _err('invalid_input', 'Nom du produit invalide (2 à 120 caractères)'); END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 100000 THEN PERFORM _err('invalid_input', 'Quantité invalide'); END IF;
  SELECT * INTO d FROM seller_deposits WHERE id = p_deposit AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Dépôt introuvable'); END IF;
  IF d.status <> 'announced' THEN PERFORM _err('invalid_state', 'Ce dépôt a déjà été compté : il ne peut plus être modifié'); END IF;
  UPDATE seller_deposits SET name = v_name, announced_qty = p_qty WHERE id = d.id;
  PERFORM _audit(p_actor, 'deposit_edited', 'deposit', d.id::text, jsonb_build_object('qty', p_qty));
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
