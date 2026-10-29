-- 035 : rayons du catalogue (un produit = un rayon) et zones de livraison classées : communes → quartiers, villes de l'intérieur (livrées à la gare voiture).
-- Aucun tarif n'est modifié ni inventé : les zones gardent leur tarif actuel ; les quartiers et villes restent désactivés tant que l'administrateur ne leur a pas donné un tarif.

-- ---------- Rayons ----------
CREATE TABLE product_categories (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 2 AND 40),
  position int NOT NULL DEFAULT 0,
  active   boolean NOT NULL DEFAULT true
);
INSERT INTO product_categories(name, position) VALUES
  ('Bébé et enfant', 1), ('Électroménager', 2), ('Meubles et maison', 3), ('Mode et beauté', 4), ('Téléphones et électronique', 5), ('Autres', 99);
ALTER TABLE products ADD COLUMN category_id uuid REFERENCES product_categories(id);
UPDATE products SET category_id = (SELECT id FROM product_categories WHERE name = 'Autres');

CREATE OR REPLACE FUNCTION _default_category() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM product_categories WHERE name = 'Autres' $$;

DROP FUNCTION fn_supplier_add_product(uuid, text, text, bigint, storage_mode, int);
CREATE FUNCTION fn_supplier_add_product(p_actor uuid, p_name text, p_description text, p_price bigint,
                                        p_storage storage_mode, p_initial_qty int DEFAULT 0, p_category uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_cat uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF p_price IS NULL OR p_price <= 0 THEN PERFORM _err('invalid_input', 'Prix fournisseur invalide'); END IF;
  IF p_storage = 'wallindirain' AND COALESCE(p_initial_qty, 0) <> 0 THEN
    PERFORM _err('invalid_input', 'Pour un stockage chez Wallindirain, annoncez un arrivage (le stock vient du comptage)');
  END IF;
  IF p_category IS NULL THEN v_cat := _default_category();
  ELSE
    SELECT id INTO v_cat FROM product_categories WHERE id = p_category AND active;
    IF NOT FOUND THEN PERFORM _err('invalid_input', 'Rayon inconnu'); END IF;
  END IF;
  BEGIN
    INSERT INTO products(supplier_id, name, description, supplier_price, storage, stock_qty, category_id)
    VALUES (p_actor, trim(p_name), NULLIF(trim(p_description), ''), p_price, p_storage, GREATEST(COALESCE(p_initial_qty, 0), 0), v_cat)
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Nom de produit invalide');
  END;
  PERFORM _audit(p_actor, 'product_proposed', 'product', v_id::text);
  RETURN v_id;
END $$;

-- changer le rayon d'un produit : son fournisseur ou l'administrateur
CREATE FUNCTION fn_set_product_category(p_actor uuid, p_product uuid, p_category uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a users; p products;
BEGIN
  a := _require(p_actor, ARRAY['supplier','admin']::user_role[]);
  SELECT * INTO p FROM products WHERE id = p_product AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR (a.role = 'supplier' AND p.supplier_id <> a.id) THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF NOT EXISTS (SELECT 1 FROM product_categories WHERE id = p_category AND active) THEN PERFORM _err('invalid_input', 'Rayon inconnu'); END IF;
  UPDATE products SET category_id = p_category WHERE id = p.id;
  PERFORM _audit(p_actor, 'product_category_changed', 'product', p.id::text, jsonb_build_object('category', p_category));
END $$;

-- créer / renommer / classer / désactiver un rayon (jamais supprimé : les produits y restent rattachés)
CREATE FUNCTION fn_admin_set_category(p_actor uuid, p_id uuid, p_name text, p_position int, p_active boolean) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_name IS NULL OR length(trim(p_name)) < 2 OR length(trim(p_name)) > 40 THEN PERFORM _err('invalid_input', 'Nom de rayon invalide'); END IF;
  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO product_categories(name, position, active) VALUES (trim(p_name), COALESCE(p_position, 50), COALESCE(p_active, true)) RETURNING id INTO v_id;
    ELSE
      UPDATE product_categories SET name = trim(p_name), position = COALESCE(p_position, position), active = COALESCE(p_active, active) WHERE id = p_id RETURNING id INTO v_id;
      IF NOT FOUND THEN PERFORM _err('not_found', 'Rayon introuvable'); END IF;
    END IF;
  EXCEPTION WHEN unique_violation THEN PERFORM _err('invalid_input', 'Un rayon porte déjà ce nom');
  END;
  PERFORM _audit(p_actor, 'category_changed', 'category', v_id::text, jsonb_build_object('name', trim(p_name), 'active', COALESCE(p_active, true)));
  RETURN v_id;
END $$;

-- ---------- Zones : commune → quartiers ; villes de l'intérieur (gare voiture) ----------
ALTER TABLE delivery_rates ADD COLUMN kind text NOT NULL DEFAULT 'quartier' CHECK (kind IN ('commune','quartier','ville','autre'));
ALTER TABLE delivery_rates ADD COLUMN parent text REFERENCES delivery_rates(commune);
ALTER TABLE delivery_rates ADD COLUMN pickup_point text CHECK (pickup_point IS NULL OR length(pickup_point) <= 120);
UPDATE delivery_rates SET kind = 'commune' WHERE commune IN ('Kaloum','Dixinn','Matam','Ratoma','Matoto');
UPDATE delivery_rates SET kind = 'autre' WHERE commune = 'Autre quartier / ville';
UPDATE delivery_rates SET kind = 'ville' WHERE commune IN ('Coyah','Dubréka','Boké','Boffa','Fria','Gaoual','Koundara','Kamsar','Forécariah','Kindia','Télimélé','Dalaba','Mamou','Pita','Koubia','Labé','Lélouma','Mali','Tougué','Dabola','Dinguiraye','Faranah','Kissidougou','Kankan','Kérouané','Kouroussa','Mandiana','Siguiri','Beyla','Guéckédou','Lola','Macenta','Nzérékoré','Yomou');
UPDATE delivery_rates SET parent = 'Dixinn' WHERE commune IN ('Hafia','Hafia 2','Belle-Vue','Camayenne','Cameroun','Donka','Minière','Pont 8 Novembre') AND kind = 'quartier';
UPDATE delivery_rates SET parent = 'Matam' WHERE commune IN ('Madina','Carrière','Bonfi','Coléyah','Kenien') AND kind = 'quartier';
UPDATE delivery_rates SET parent = 'Ratoma' WHERE commune IN ('Taouyah','Hamdalaye','Kipé','Prince','Kaporo','Bambeto','Koloma','Dar-es-Salam','Nongo','Cosa','Lambagni','Sonfonya','Kobaya','Enco 5','Simbossia','Yattaya','Tannerie') AND kind = 'quartier';
UPDATE delivery_rates SET parent = 'Matoto' WHERE commune IN ('Gbessia','Aéroport','Sangoyah','Yimbaya','Dapompa','Enta','Bondy','Tombolya','Kissosso','Constantin','Yembeya') AND kind = 'quartier';

-- classer une zone (nature, commune de rattachement, gare voiture) ; le tarif reste géré par fn_admin_set_delivery_rate
CREATE FUNCTION fn_admin_classify_zone(p_actor uuid, p_zone text, p_kind text, p_parent text, p_pickup text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF NOT EXISTS (SELECT 1 FROM delivery_rates WHERE commune = p_zone) THEN PERFORM _err('not_found', 'Zone introuvable'); END IF;
  IF p_kind NOT IN ('commune','quartier','ville','autre') THEN PERFORM _err('invalid_input', 'Nature de zone invalide'); END IF;
  IF p_kind = 'quartier' AND p_parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM delivery_rates WHERE commune = p_parent AND kind = 'commune') THEN
    PERFORM _err('invalid_input', 'La commune de rattachement doit être une commune');
  END IF;
  IF p_kind <> 'quartier' THEN p_parent := NULL; END IF;
  IF p_kind <> 'ville' THEN p_pickup := NULL; END IF;
  IF p_kind <> 'commune' AND EXISTS (SELECT 1 FROM delivery_rates WHERE parent = p_zone) THEN PERFORM _err('invalid_state', 'Des quartiers dépendent de cette commune'); END IF;
  UPDATE delivery_rates SET kind = p_kind, parent = p_parent, pickup_point = NULLIF(trim(p_pickup), '') WHERE commune = p_zone;
  PERFORM _audit(p_actor, 'zone_classified', 'zone', p_zone, jsonb_build_object('kind', p_kind, 'parent', p_parent));
END $$;

-- applique le tarif de la commune aux quartiers qui n'ont pas encore de tarif (choix explicite de l'administrateur) ; renvoie le nombre de quartiers activés
CREATE FUNCTION fn_admin_zones_use_commune_fee(p_actor uuid, p_commune text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE c delivery_rates; z record; n int := 0;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO c FROM delivery_rates WHERE commune = p_commune AND kind = 'commune';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commune introuvable'); END IF;
  IF c.fee = 0 THEN PERFORM _err('invalid_input', 'Fixez d''abord le tarif de la commune'); END IF;
  FOR z IN SELECT commune FROM delivery_rates WHERE parent = p_commune AND fee = 0 LOOP
    PERFORM fn_admin_set_delivery_rate(p_actor, z.commune, c.fee, true);
    n := n + 1;
  END LOOP;
  RETURN n;
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
