-- 023 : photos des produits. Le fournisseur ajoute jusqu'à 4 photos à chaque produit ; la première (la plus ancienne position) sert de couverture.
-- Les photos sont stockées comme les photos de profil (même principe : octets lisibles seulement par des fonctions contrôlées), jamais par lecture directe de la table.
-- Visibles : par l'administration, par le fournisseur propriétaire, par les vendeurs et l'équipe seulement quand le produit est validé et non supprimé,
-- et par le client sur la page d'un lien produit valide (couverture seulement, sans aucune information sur le fournisseur).
-- Information seulement : aucune règle d'argent, de stock ou de validation n'est modifiée (la photo n'est pas obligatoire).

CREATE TABLE product_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id),
  position    int  NOT NULL CHECK (position BETWEEN 1 AND 4),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data        bytea NOT NULL CHECK (octet_length(data) BETWEEN 1000 AND 450000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, position)
);

CREATE FUNCTION fn_supplier_add_product_image(p_actor uuid, p_product uuid, p_mime text, p_data bytea) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_pos int; v_id uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  PERFORM 1 FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  SELECT min(g) INTO v_pos FROM generate_series(1, 4) g WHERE NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = p_product AND position = g);
  IF v_pos IS NULL THEN PERFORM _err('invalid_state', 'Un produit peut avoir 4 photos au maximum : supprimez-en une d''abord'); END IF;
  BEGIN
    INSERT INTO product_images(product_id, position, mime, data) VALUES (p_product, v_pos, p_mime, p_data) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Photo invalide ou trop lourde');
  END;
  PERFORM _audit(p_actor, 'product_image_added', 'product', p_product::text, jsonb_build_object('position', v_pos));
  RETURN v_id;
END $$;

CREATE FUNCTION fn_supplier_delete_product_image(p_actor uuid, p_image uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_product uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  DELETE FROM product_images i USING products p
   WHERE i.id = p_image AND p.id = i.product_id AND p.supplier_id = p_actor RETURNING i.product_id INTO v_product;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Photo introuvable'); END IF;
  PERFORM _audit(p_actor, 'product_image_deleted', 'product', v_product::text, '{}'::jsonb);
END $$;

-- Lecture d'une photo : administration (toutes), fournisseur propriétaire (toutes les siennes), autres rôles du métier (produit validé et non supprimé)
CREATE FUNCTION fn_product_image_get(p_actor uuid, p_image uuid) RETURNS TABLE(mime text, data bytea) LANGUAGE plpgsql AS $$
DECLARE u users; p products;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Compte inactif ou introuvable'); END IF;
  SELECT pr.* INTO p FROM products pr JOIN product_images i ON i.product_id = pr.id WHERE i.id = p_image;
  IF NOT FOUND THEN RETURN; END IF;
  IF u.role = 'admin' OR (u.role = 'supplier' AND p.supplier_id = u.id) THEN NULL;
  ELSIF u.role IN ('seller','agent','call_chief','courier','warehouse') AND p.status = 'approved' AND p.deleted_at IS NULL THEN NULL;
  ELSE PERFORM _err('forbidden', 'Action non autorisée pour votre rôle'); END IF;
  RETURN QUERY SELECT i.mime, i.data FROM product_images i WHERE i.id = p_image;
END $$;

-- Page publique d'un lien produit : la couverture du produit, si le lien est valable (rien sur le fournisseur)
CREATE FUNCTION fn_public_product_photo(p_code text) RETURNS TABLE(mime text, data bytea) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT i.mime, i.data
    FROM seller_links l
    JOIN users u ON u.id = l.seller_id AND u.status = 'active' AND u.deleted_at IS NULL
    JOIN products p ON p.id = l.product_id AND p.status = 'approved' AND p.deleted_at IS NULL
    JOIN product_images i ON i.product_id = p.id
   WHERE l.code = p_code ORDER BY i.position LIMIT 1;
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
       AND NOT (r.relname IN ('proofs','avatars','product_images') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
