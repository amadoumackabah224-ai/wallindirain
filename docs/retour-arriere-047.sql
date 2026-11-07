-- Retour arrière de la migration 047 (le propriétaire vend aussi son produit proposé, suspension, retrait, restitution de stock).
-- Refuse s'il existe des demandes de restitution, des produits suspendus ou retirés (ces informations seraient perdues).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM stock_returns) THEN RAISE EXCEPTION 'retour arrière refusé : des demandes de restitution existent'; END IF;
  IF EXISTS (SELECT 1 FROM products WHERE paused_at IS NOT NULL OR retired_at IS NOT NULL) THEN RAISE EXCEPTION 'retour arrière refusé : des produits sont suspendus ou retirés'; END IF;
END $$;
DO $mig$
DECLARE v_def text; v_new text; v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '_create_order';
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def, $b$v_sup := p.supplier_price; v_margin := CASE WHEN p.supplier_id = p_seller THEN 0 ELSE p.margin_unit END; v_wh := v_sup + v_margin;$b$,
                          $a$v_sup := p.supplier_price; v_margin := p.margin_unit; v_wh := v_sup + v_margin;$a$);
  IF v_new = v_def THEN RAISE EXCEPTION 'retour arrière 047 : _create_order inchangée (marge)'; END IF;
  v_def := v_new;
  v_new := replace(v_def, $b$v_na := p_qty - v_nb;
    IF v_na > 0 AND (p.retired_at IS NOT NULL OR (p.paused_at IS NOT NULL AND p.supplier_id <> p_seller)) THEN
      PERFORM _err('out_of_stock', 'Ce produit n''est plus disponible pour le moment');
    END IF;$b$, $a$v_na := p_qty - v_nb;$a$);
  IF v_new = v_def THEN RAISE EXCEPTION 'retour arrière 047 : _create_order inchangée (suspension)'; END IF;
  EXECUTE v_new;

  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_seller_buy_stock';
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def, $b$IF p.paused_at IS NOT NULL OR p.retired_at IS NOT NULL THEN PERFORM _err('out_of_stock', 'Ce produit n''est plus disponible pour le moment'); END IF;
  IF p.stock_qty - p.reserved_qty < p_qty THEN$b$, $a$IF p.stock_qty - p.reserved_qty < p_qty THEN$a$);
  IF v_new = v_def THEN RAISE EXCEPTION 'retour arrière 047 : fn_seller_buy_stock inchangée'; END IF;
  EXECUTE v_new;

  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_seller_set_price';
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def, $b$v_min := _min_unit_price_for(p_actor, p_product);$b$, $a$v_min := _min_unit_price(p_product);$a$);
  IF v_new = v_def THEN RAISE EXCEPTION 'retour arrière 047 : fn_seller_set_price inchangée'; END IF;
  EXECUTE v_new;
END $mig$;
CREATE TRIGGER orders_no_self_dealing BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION trg_no_self_dealing();
CREATE TRIGGER seller_prices_no_self_dealing BEFORE INSERT ON seller_prices FOR EACH ROW EXECUTE FUNCTION trg_no_self_dealing();
CREATE TRIGGER seller_links_no_self_dealing BEFORE INSERT ON seller_links FOR EACH ROW EXECUTE FUNCTION trg_no_self_dealing();
DROP TRIGGER orders_owner_sale_alert ON orders;
DROP FUNCTION _owner_sale_alert();
DROP FUNCTION fn_warehouse_hand_over_return(uuid, uuid);
DROP FUNCTION fn_admin_decide_return(uuid, uuid, boolean, text);
DROP FUNCTION fn_supplier_cancel_return(uuid, uuid);
DROP FUNCTION fn_supplier_request_return(uuid, uuid, int);
DROP FUNCTION fn_supplier_retire_product(uuid, uuid);
DROP FUNCTION fn_supplier_set_pause(uuid, uuid, boolean, text);
DROP FUNCTION _min_unit_price_for(uuid, uuid);
DROP TABLE stock_returns;
ALTER TABLE products DROP COLUMN paused_at, DROP COLUMN retired_at, DROP COLUMN availability_note;

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

DELETE FROM schema_migrations WHERE name = '047_produits_vendeur_stock.sql';
