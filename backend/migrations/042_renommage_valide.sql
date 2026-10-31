-- 042 : le renommage d'un produit DÉJÀ VALIDÉ par un fournisseur passe par l'administrateur.
-- Produit non validé : renommage immédiat. La description reste modifiable tout de suite.
-- Aucun montant n'est touché.
CREATE TABLE product_name_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id),
  old_name     text NOT NULL,
  new_name     text NOT NULL CHECK (length(new_name) BETWEEN 2 AND 120),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid NOT NULL REFERENCES users(id),
  reviewed_by  uuid REFERENCES users(id),
  review_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz
);
CREATE UNIQUE INDEX product_name_changes_one_pending ON product_name_changes(product_id) WHERE status = 'pending';

DROP FUNCTION fn_supplier_edit_product(uuid, uuid, text, text);
-- Retourne 'applied' (tout est enregistré) ou 'pending' (le nouveau nom attend l'administrateur ; la description est déjà enregistrée)
CREATE FUNCTION fn_supplier_edit_product(p_actor uuid, p_product uuid, p_name text, p_description text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE p products; v_name text := trim(COALESCE(p_name, '')); v_desc text := NULLIF(trim(COALESCE(p_description, '')), ''); r record; v_result text := 'applied';
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF length(v_name) < 2 OR length(v_name) > 120 THEN PERFORM _err('invalid_input', 'Nom du produit invalide (2 à 120 caractères)'); END IF;
  IF v_desc IS NOT NULL AND length(v_desc) > 1000 THEN PERFORM _err('invalid_input', 'Description trop longue (1000 caractères maximum)'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.status NOT IN ('pending','approved') THEN PERFORM _err('invalid_state', 'Ce produit ne peut plus être modifié'); END IF;
  IF p.status = 'approved' AND v_name <> p.name THEN
    UPDATE products SET description = v_desc WHERE id = p.id;
    UPDATE product_name_changes SET status = 'rejected', reviewed_at = now(), review_note = 'Remplacée par une nouvelle demande' WHERE product_id = p.id AND status = 'pending';
    INSERT INTO product_name_changes(product_id, old_name, new_name, requested_by) VALUES (p.id, p.name, v_name, p_actor);
    v_result := 'pending';
    PERFORM _audit(p_actor, 'product_rename_requested', 'product', p.id::text, '{}'::jsonb);
    BEGIN
      FOR r IN SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LOOP
        PERFORM _notify(r.id, 'product', 'Changement de nom demandé', p.name || ' → ' || v_name || '. À valider.', 'dash');
      END LOOP;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  ELSE
    UPDATE products SET name = v_name, description = v_desc WHERE id = p.id;
    PERFORM _audit(p_actor, 'product_edited', 'product', p.id::text, jsonb_build_object('name_changed', p.name <> v_name));
  END IF;
  RETURN v_result;
END $$;

CREATE FUNCTION fn_admin_review_name_change(p_actor uuid, p_change uuid, p_approve boolean, p_note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c product_name_changes; p products; v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF v_note IS NOT NULL AND length(v_note) > 300 THEN PERFORM _err('invalid_input', 'Note trop longue'); END IF;
  SELECT * INTO c FROM product_name_changes WHERE id = p_change FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Demande introuvable'); END IF;
  IF c.status <> 'pending' THEN PERFORM _err('invalid_state', 'Cette demande a déjà été traitée'); END IF;
  SELECT * INTO p FROM products WHERE id = c.product_id FOR UPDATE;
  IF p_approve THEN UPDATE products SET name = c.new_name WHERE id = p.id; END IF;
  UPDATE product_name_changes SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, reviewed_by = p_actor, review_note = v_note, reviewed_at = now() WHERE id = c.id;
  PERFORM _audit(p_actor, CASE WHEN p_approve THEN 'product_rename_approved' ELSE 'product_rename_rejected' END, 'product', p.id::text, '{}'::jsonb);
  BEGIN
    PERFORM _notify(p.supplier_id, 'product', CASE WHEN p_approve THEN 'Nouveau nom accepté' ELSE 'Changement de nom refusé' END,
      CASE WHEN p_approve THEN c.old_name || ' s''appelle maintenant ' || c.new_name || '.' ELSE c.old_name || ' garde son nom.' || COALESCE(' ' || v_note, '') END, 'products');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
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
