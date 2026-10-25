-- 022 : lieu de récupération du colis. Pour que le livreur sache où prendre le colis :
--  - produit en stock chez le fournisseur : le fournisseur indique l'adresse (jamais montrée au vendeur ni au client) ;
--  - stock confié à Wallindirain : entrepôt (aucune adresse à saisir) ;
--  - commande du vendeur avec son propre produit : le vendeur indique où récupérer le colis.
-- Information seulement : aucun calcul d'argent, aucune règle de stock modifiée.

ALTER TABLE products ADD COLUMN pickup_detail text CHECK (pickup_detail IS NULL OR length(pickup_detail) BETWEEN 3 AND 200);
ALTER TABLE orders   ADD COLUMN pickup_detail text CHECK (pickup_detail IS NULL OR length(pickup_detail) BETWEEN 3 AND 200);

-- Le vendeur précise où récupérer le colis d'une commande avec son propre produit (tant que le colis n'est pas parti)
CREATE FUNCTION fn_seller_set_pickup(p_actor uuid, p_order uuid, p_detail text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders; v_detail text := NULLIF(trim(COALESCE(p_detail, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF v_detail IS NULL OR length(v_detail) < 3 OR length(v_detail) > 200 THEN PERFORM _err('invalid_input', 'Indiquez où récupérer le colis (3 à 200 caractères)'); END IF;
  SELECT * INTO o FROM orders WHERE id = p_order AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.formula <> 'C' THEN PERFORM _err('invalid_state', 'Le lieu de récupération se précise seulement pour votre propre produit'); END IF;
  IF o.status NOT IN ('new', 'in_call', 'confirmed', 'assigned') THEN PERFORM _err('invalid_state', 'Le colis est déjà parti : le lieu ne peut plus être modifié'); END IF;
  UPDATE orders SET pickup_detail = v_detail WHERE id = o.id;
  PERFORM _audit(p_actor, 'pickup_set', 'order', o.id::text, '{}'::jsonb);
END $$;

-- Le fournisseur indique (ou efface) l'adresse où récupérer ses produits gardés chez lui
CREATE FUNCTION fn_supplier_set_pickup(p_actor uuid, p_product uuid, p_detail text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_detail text := NULLIF(trim(COALESCE(p_detail, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF v_detail IS NOT NULL AND (length(v_detail) < 3 OR length(v_detail) > 200) THEN PERFORM _err('invalid_input', 'L''adresse doit faire 3 à 200 caractères'); END IF;
  UPDATE products SET pickup_detail = v_detail WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL AND storage = 'supplier';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable, ou non gardé chez vous'); END IF;
  PERFORM _audit(p_actor, 'product_pickup_set', 'product', p_product::text, '{}'::jsonb);
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
