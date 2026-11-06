-- 046 : un vendeur peut proposer ses propres produits au catalogue des autres vendeurs, comme un fournisseur.
-- Le produit suit le circuit des fournisseurs : proposition, validation par l'administrateur (qui fixe la marge Wallindirain), catalogue, arrivage compté
-- par le magasinier (ou stock gardé chez le vendeur), livraison, puis part « fournisseur » créditée sur le portefeuille du vendeur proposant.
-- Aucune règle d'argent n'est modifiée : le calcul à la livraison lit déjà products.supplier_id, quel que soit le rôle de ce compte.
-- Éteint par défaut (réglage feature_vendeur_produits = 0). L'administrateur l'allume dans « Réglages ».
--
-- Techniquement : les fonctions fournisseur existantes sont réécrites à partir de leur texte actuel (pg_get_functiondef) pour accepter aussi le rôle vendeur,
-- sous le contrôle du réglage ; chacune garde sa vérification « ce produit est bien à moi ». Si une substitution ne trouve rien, la migration s'arrête.

INSERT INTO settings(key, value, label) VALUES
  ('feature_vendeur_produits', 0, 'Les vendeurs peuvent proposer leurs produits au catalogue (0 = non, 1 = oui)');

-- Comme _require, mais accepte aussi le rôle vendeur quand le réglage est allumé
CREATE FUNCTION _require_proposer(p_actor uuid, p_roles user_role[]) RETURNS users LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, p_roles || ARRAY['seller']::user_role[]);
  IF u.role = 'seller' AND _setting('feature_vendeur_produits') < 1 THEN
    PERFORM _err('forbidden', 'Action non autorisée pour votre rôle');   -- fonction éteinte : comme avant la migration
  END IF;
  RETURN u;
END $$;

-- Pas de vente à soi-même : un vendeur ne peut pas vendre, fixer un prix, acheter du stock ou créer un lien sur un produit qu'il a lui-même proposé
CREATE FUNCTION trg_no_self_dealing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM products WHERE id = NEW.product_id AND supplier_id = NEW.seller_id) THEN
    PERFORM _err('invalid_input', 'Vous ne pouvez pas vendre vous-même, par le catalogue, un produit que vous avez proposé');
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_no_self_dealing() SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER orders_no_self_dealing BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION trg_no_self_dealing();
CREATE TRIGGER seller_prices_no_self_dealing BEFORE INSERT ON seller_prices FOR EACH ROW EXECUTE FUNCTION trg_no_self_dealing();
CREATE TRIGGER seller_stock_no_self_dealing BEFORE INSERT ON seller_stock FOR EACH ROW EXECUTE FUNCTION trg_no_self_dealing();
CREATE TRIGGER seller_links_no_self_dealing BEFORE INSERT ON seller_links FOR EACH ROW EXECUTE FUNCTION trg_no_self_dealing();

-- Réécriture des fonctions fournisseur à partir de leur texte actuel
DO $$
DECLARE r record; v_def text; v_new text; v_names text[] := ARRAY[
  'fn_supplier_add_product','fn_supplier_edit_product','fn_supplier_set_price','fn_supplier_set_pickup','fn_supplier_announce_arrival','fn_supplier_set_stock',
  'fn_supplier_add_product_image','fn_supplier_delete_product_image','fn_set_product_category','fn_product_image_get','fn_return_photo_get'];
  v_done int := 0;
BEGIN
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY (v_names) LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def, '_require(p_actor, ARRAY[''supplier'']::user_role[])', '_require_proposer(p_actor, ARRAY[''supplier'']::user_role[])');
    v_new := replace(v_new, '_require(p_actor, ARRAY[''supplier'',''admin'']::user_role[])', '_require_proposer(p_actor, ARRAY[''supplier'',''admin'']::user_role[])');
    v_new := replace(v_new, 'a.role = ''supplier'' AND p.supplier_id <> a.id', 'a.role IN (''supplier'',''seller'') AND p.supplier_id <> a.id');
    v_new := replace(v_new, 'u.role = ''supplier'' AND p.supplier_id = u.id', 'u.role IN (''supplier'',''seller'') AND p.supplier_id = u.id');
    v_new := replace(v_new, 'u.role = ''supplier'' AND v_supplier = u.id', 'u.role IN (''supplier'',''seller'') AND v_supplier = u.id');
    IF v_new = v_def THEN RAISE EXCEPTION 'migration 046 : fonction % inchangée (texte inattendu)', r.proname; END IF;
    EXECUTE v_new;
    v_done := v_done + 1;
  END LOOP;
  IF v_done <> array_length(v_names, 1) THEN RAISE EXCEPTION 'migration 046 : % fonctions réécrites sur %', v_done, array_length(v_names, 1); END IF;
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
