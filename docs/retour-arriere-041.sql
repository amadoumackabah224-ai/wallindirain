-- Retour arrière de la migration 041 (modification des produits et des prix).
-- Refuse s'il existe des demandes de changement de prix (sinon l'historique serait perdu).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM product_price_changes) THEN
    RAISE EXCEPTION 'retour arrière refusé : des demandes de changement de prix existent';
  END IF;
END $$;
DROP FUNCTION fn_supplier_edit_product(uuid, uuid, text, text);
DROP FUNCTION fn_supplier_set_price(uuid, uuid, bigint);
DROP FUNCTION fn_admin_review_price_change(uuid, uuid, boolean, int, text);
DROP FUNCTION fn_admin_edit_product(uuid, uuid, text, text);
DROP FUNCTION fn_admin_set_product_price(uuid, uuid, bigint, int);
DROP FUNCTION fn_seller_edit_deposit(uuid, uuid, text, int);
DROP FUNCTION _apply_product_price(uuid, bigint, int);
DROP FUNCTION _price_change_locked(uuid);
DROP TABLE product_price_changes;

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

DELETE FROM schema_migrations WHERE name = '041_modifier_produits.sql';
