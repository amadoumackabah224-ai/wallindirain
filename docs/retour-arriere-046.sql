-- Retour arrière de la migration 046 (les vendeurs proposent leurs produits au catalogue).
-- Refuse s'il existe des produits proposés par des vendeurs (ils deviendraient inaccessibles) ou si le réglage feature_vendeur_produits n'est pas à 0.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM products p JOIN users u ON u.id = p.supplier_id WHERE u.role = 'seller') THEN
    RAISE EXCEPTION 'retour arrière refusé : des produits proposés par des vendeurs existent';
  END IF;
  IF COALESCE((SELECT value FROM settings WHERE key = 'feature_vendeur_produits'), 0) <> 0 THEN
    RAISE EXCEPTION 'retour arrière refusé : éteignez d''abord la fonction (réglage feature_vendeur_produits = 0)';
  END IF;
END $$;
DROP TRIGGER orders_no_self_dealing ON orders;
DROP TRIGGER seller_prices_no_self_dealing ON seller_prices;
DROP TRIGGER seller_stock_no_self_dealing ON seller_stock;
DROP TRIGGER seller_links_no_self_dealing ON seller_links;
DROP FUNCTION trg_no_self_dealing();
-- on remet les fonctions fournisseur dans leur état d'avant
DO $$
DECLARE r record; v_def text; v_new text; v_names text[] := ARRAY[
  'fn_supplier_add_product','fn_supplier_edit_product','fn_supplier_set_price','fn_supplier_set_pickup','fn_supplier_announce_arrival','fn_supplier_set_stock',
  'fn_supplier_add_product_image','fn_supplier_delete_product_image','fn_set_product_category','fn_product_image_get','fn_return_photo_get'];
  v_done int := 0;
BEGIN
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY (v_names) LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def, '_require_proposer(p_actor, ARRAY[''supplier'']::user_role[])', '_require(p_actor, ARRAY[''supplier'']::user_role[])');
    v_new := replace(v_new, '_require_proposer(p_actor, ARRAY[''supplier'',''admin'']::user_role[])', '_require(p_actor, ARRAY[''supplier'',''admin'']::user_role[])');
    v_new := replace(v_new, 'a.role IN (''supplier'',''seller'') AND p.supplier_id <> a.id', 'a.role = ''supplier'' AND p.supplier_id <> a.id');
    v_new := replace(v_new, 'u.role IN (''supplier'',''seller'') AND p.supplier_id = u.id', 'u.role = ''supplier'' AND p.supplier_id = u.id');
    v_new := replace(v_new, 'u.role IN (''supplier'',''seller'') AND v_supplier = u.id', 'u.role = ''supplier'' AND v_supplier = u.id');
    IF v_new = v_def THEN RAISE EXCEPTION 'retour arrière 046 : fonction % inchangée', r.proname; END IF;
    EXECUTE v_new;
    v_done := v_done + 1;
  END LOOP;
  IF v_done <> array_length(v_names, 1) THEN RAISE EXCEPTION 'retour arrière 046 : % fonctions remises sur %', v_done, array_length(v_names, 1); END IF;
END $$;
DROP FUNCTION _require_proposer(uuid, user_role[]);
DELETE FROM settings WHERE key = 'feature_vendeur_produits';

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

DELETE FROM schema_migrations WHERE name = '046_produits_vendeur.sql';
