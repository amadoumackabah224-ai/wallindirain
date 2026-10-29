-- RETOUR ARRIÈRE de la migration 035 (rayons et zones classées). JAMAIS AUTOMATIQUE.
-- REFUSE de s'exécuter si un produit a été rangé dans un autre rayon que « Autres » (ou un rayon créé) : on ne perd pas ce classement.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM products p JOIN product_categories c ON c.id = p.category_id WHERE c.name <> 'Autres')
     OR (SELECT count(*) FROM product_categories) <> 6 THEN
    RAISE EXCEPTION 'Retour arrière refusé : des rayons ont été utilisés ou modifiés';
  END IF;
END $$;
DROP FUNCTION fn_admin_zones_use_commune_fee(uuid, text);
DROP FUNCTION fn_admin_classify_zone(uuid, text, text, text, text);
ALTER TABLE delivery_rates DROP COLUMN pickup_point, DROP COLUMN parent, DROP COLUMN kind;
DROP FUNCTION fn_set_product_category(uuid, uuid, uuid);
DROP FUNCTION fn_admin_set_category(uuid, uuid, text, int, boolean);
DROP FUNCTION fn_supplier_add_product(uuid, text, text, bigint, storage_mode, int, uuid);
CREATE FUNCTION fn_supplier_add_product(p_actor uuid, p_name text, p_description text, p_price bigint,
                                        p_storage storage_mode, p_initial_qty int DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF p_price IS NULL OR p_price <= 0 THEN PERFORM _err('invalid_input', 'Prix fournisseur invalide'); END IF;
  IF p_storage = 'wallindirain' AND COALESCE(p_initial_qty, 0) <> 0 THEN
    PERFORM _err('invalid_input', 'Pour un stockage chez Wallindirain, annoncez un arrivage (le stock vient du comptage)');
  END IF;
  BEGIN
    INSERT INTO products(supplier_id, name, description, supplier_price, storage, stock_qty)
    VALUES (p_actor, trim(p_name), NULLIF(trim(p_description), ''), p_price, p_storage, GREATEST(COALESCE(p_initial_qty, 0), 0))
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Nom de produit invalide');
  END;
  PERFORM _audit(p_actor, 'product_proposed', 'product', v_id::text);
  RETURN v_id;
END $$;
ALTER TABLE products DROP COLUMN category_id;
DROP FUNCTION _default_category();
DROP TABLE product_categories;

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

DELETE FROM schema_migrations WHERE name = '035_rayons_et_zones.sql';
COMMIT;
