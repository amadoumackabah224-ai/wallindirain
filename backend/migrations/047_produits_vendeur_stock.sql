-- 047 : « Mes produits proposés » devient un vrai circuit de partage : le propriétaire d'un produit proposé peut AUSSI le vendre lui-même.
-- Un seul stock partagé (products.stock_qty / reserved_qty) : il n'y a ni copie du produit ni deuxième circuit, donc pas de double vente possible.
-- Règles d'argent : une vente du propriétaire sur son propre produit passe par le même circuit de commande et de règlement que toutes les autres ;
-- seule la marge Wallindirain de CETTE commande est figée à 0 (les frais de livraison, d'appel et de plateforme restent dus normalement).
-- Les autres ventes ne changent pas. Le contrôle fn_ledger_check() doit rester vide.
-- Nouveautés pour le propriétaire : suspendre / reprendre (les autres vendeurs ne peuvent plus commander), retirer (définitif pour le catalogue),
-- demander la restitution de stock gardé à Wallindirain (validation administrateur, puis remise par le magasinier).
-- Les commandes déjà prises ne sont JAMAIS annulées par une suspension ou un retrait, et les quantités réservées restent protégées.
-- Rien n'est supprimé. Les fonctions existantes touchées sont réécrites à partir de leur texte actuel ; si une substitution ne trouve rien, la migration s'arrête.

ALTER TABLE products
  ADD COLUMN paused_at         timestamptz,
  ADD COLUMN retired_at        timestamptz,
  ADD COLUMN availability_note text CHECK (availability_note IS NULL OR length(availability_note) BETWEEN 3 AND 200);

-- Demandes de restitution de stock gardé chez Wallindirain
CREATE TABLE stock_returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products(id),
  owner_id      uuid NOT NULL REFERENCES users(id),
  qty           int  NOT NULL CHECK (qty BETWEEN 1 AND 1000000),
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','handed_over','rejected','cancelled')),
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 3 AND 300),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  handed_by     uuid REFERENCES users(id),
  handed_at     timestamptz
);
CREATE INDEX stock_returns_owner_idx ON stock_returns(owner_id, requested_at DESC);
CREATE UNIQUE INDEX stock_returns_one_open_idx ON stock_returns(product_id) WHERE status IN ('requested','approved');

-- Prix minimum de vente pour un acteur : pour le propriétaire, la marge Wallindirain n'entre pas dans le minimum
CREATE FUNCTION _min_unit_price_for(p_actor uuid, p_product uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT _min_unit_price(p_product) - COALESCE((SELECT COALESCE(p.margin_unit, _margin_for(p.supplier_price)) FROM products p WHERE p.id = p_product AND p.supplier_id = p_actor), 0)
$$;

-- Suspendre ou reprendre la mise à disposition aux autres vendeurs (le propriétaire continue de vendre)
CREATE FUNCTION fn_supplier_set_pause(p_actor uuid, p_product uuid, p_paused boolean, p_note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products; v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _require_proposer(p_actor, ARRAY['supplier']::user_role[]);
  IF v_note IS NOT NULL AND (length(v_note) < 3 OR length(v_note) > 200) THEN PERFORM _err('invalid_input', 'Note de 3 à 200 caractères'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.status <> 'approved' THEN PERFORM _err('invalid_state', 'Ce produit n''est pas encore validé'); END IF;
  IF p.retired_at IS NOT NULL THEN PERFORM _err('invalid_state', 'Ce produit est retiré'); END IF;
  UPDATE products SET paused_at = CASE WHEN p_paused THEN COALESCE(paused_at, now()) END,
                      availability_note = CASE WHEN p_paused THEN v_note END
   WHERE id = p_product;
  PERFORM _audit(p_actor, CASE WHEN p_paused THEN 'product_paused' ELSE 'product_resumed' END, 'product', p_product::text, '{}');
END $$;

-- Retirer le produit du catalogue : plus aucune nouvelle commande ; les commandes déjà prises et les quantités réservées sont conservées
CREATE FUNCTION fn_supplier_retire_product(p_actor uuid, p_product uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products;
BEGIN
  PERFORM _require_proposer(p_actor, ARRAY['supplier']::user_role[]);
  SELECT * INTO p FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.retired_at IS NOT NULL THEN PERFORM _err('invalid_state', 'Ce produit est déjà retiré'); END IF;
  UPDATE products SET retired_at = now(), paused_at = COALESCE(paused_at, now()) WHERE id = p_product;
  PERFORM _audit(p_actor, 'product_retired', 'product', p_product::text, jsonb_build_object('reserved', p.reserved_qty));
END $$;

-- Demander la restitution d'une partie du stock gardé chez Wallindirain
CREATE FUNCTION fn_supplier_request_return(p_actor uuid, p_product uuid, p_qty int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p products; v_id uuid; r record;
BEGIN
  PERFORM _require_proposer(p_actor, ARRAY['supplier']::user_role[]);
  SELECT * INTO p FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.storage <> 'wallindirain' THEN PERFORM _err('invalid_state', 'Ce produit est stocké chez vous'); END IF;
  IF EXISTS (SELECT 1 FROM stock_returns WHERE product_id = p_product AND status IN ('requested','approved')) THEN
    PERFORM _err('invalid_state', 'Une demande de restitution est déjà en cours pour ce produit');
  END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > p.stock_qty - p.reserved_qty THEN
    PERFORM _err('invalid_input', 'Quantité indisponible : au plus ' || GREATEST(p.stock_qty - p.reserved_qty, 0) || ' (le reste est réservé par des commandes)');
  END IF;
  INSERT INTO stock_returns(product_id, owner_id, qty) VALUES (p_product, p_actor, p_qty) RETURNING id INTO v_id;
  PERFORM _audit(p_actor, 'stock_return_requested', 'product', p_product::text, jsonb_build_object('qty', p_qty));
  BEGIN
    FOR r IN SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LOOP
      PERFORM _notify(r.id, 'product', 'Restitution de stock demandée', p.name || ' : ' || p_qty || ' unité(s).', 'products');
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN v_id;
END $$;

-- Annuler sa demande (tant que la remise n'a pas eu lieu) : les unités bloquées redeviennent vendables
CREATE FUNCTION fn_supplier_cancel_return(p_actor uuid, p_return uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s stock_returns;
BEGIN
  PERFORM _require_proposer(p_actor, ARRAY['supplier']::user_role[]);
  SELECT * INTO s FROM stock_returns WHERE id = p_return AND owner_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Demande introuvable'); END IF;
  IF s.status NOT IN ('requested','approved') THEN PERFORM _err('invalid_state', 'Cette demande est déjà terminée'); END IF;
  IF s.status = 'approved' THEN UPDATE products SET reserved_qty = reserved_qty - s.qty WHERE id = s.product_id; END IF;
  UPDATE stock_returns SET status = 'cancelled' WHERE id = p_return;
  PERFORM _audit(p_actor, 'stock_return_cancelled', 'product', s.product_id::text, jsonb_build_object('qty', s.qty));
END $$;

-- L'administrateur accepte (les unités sont alors bloquées, donc plus vendables) ou refuse
CREATE FUNCTION fn_admin_decide_return(p_actor uuid, p_return uuid, p_approve boolean, p_note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s stock_returns; p products; v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF v_note IS NOT NULL AND (length(v_note) < 3 OR length(v_note) > 300) THEN PERFORM _err('invalid_input', 'Note de 3 à 300 caractères'); END IF;
  IF NOT p_approve AND v_note IS NULL THEN PERFORM _err('note_required', 'Expliquez le refus en quelques mots'); END IF;
  SELECT * INTO s FROM stock_returns WHERE id = p_return FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Demande introuvable'); END IF;
  IF s.status <> 'requested' THEN PERFORM _err('invalid_state', 'Cette demande a déjà été traitée'); END IF;
  SELECT * INTO p FROM products WHERE id = s.product_id FOR UPDATE;
  IF p_approve THEN
    IF s.qty > p.stock_qty - p.reserved_qty THEN
      PERFORM _err('out_of_stock', 'Stock disponible insuffisant : des commandes ont réservé des unités depuis la demande');
    END IF;
    UPDATE products SET reserved_qty = reserved_qty + s.qty WHERE id = s.product_id;
  END IF;
  UPDATE stock_returns SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decision_note = v_note, decided_by = p_actor, decided_at = now() WHERE id = p_return;
  PERFORM _audit(p_actor, CASE WHEN p_approve THEN 'stock_return_approved' ELSE 'stock_return_rejected' END, 'product', s.product_id::text, jsonb_build_object('qty', s.qty));
  BEGIN
    PERFORM _notify(s.owner_id, 'product', CASE WHEN p_approve THEN 'Restitution acceptée' ELSE 'Restitution refusée' END,
      p.name || ' : ' || s.qty || ' unité(s). ' || CASE WHEN p_approve THEN 'Passez les récupérer à l''entrepôt.' ELSE COALESCE(v_note, '') END, 'products');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- Le magasinier remet les unités au propriétaire : elles sortent du stock (et de la réserve qui les bloquait)
CREATE FUNCTION fn_warehouse_hand_over_return(p_actor uuid, p_return uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s stock_returns; p products;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  SELECT * INTO s FROM stock_returns WHERE id = p_return FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Demande introuvable'); END IF;
  IF s.status <> 'approved' THEN PERFORM _err('invalid_state', 'Cette restitution n''est pas à remettre'); END IF;
  SELECT * INTO p FROM products WHERE id = s.product_id FOR UPDATE;
  UPDATE products SET stock_qty = stock_qty - s.qty, reserved_qty = reserved_qty - s.qty WHERE id = s.product_id;
  UPDATE stock_returns SET status = 'handed_over', handed_by = p_actor, handed_at = now() WHERE id = p_return;
  PERFORM _audit(p_actor, 'stock_return_handed_over', 'product', s.product_id::text, jsonb_build_object('qty', s.qty));
  BEGIN
    PERFORM _notify(s.owner_id, 'product', 'Stock remis', p.name || ' : ' || s.qty || ' unité(s) remise(s).', 'products');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- Le propriétaire suit les ventes des autres vendeurs : une notification à la confirmation et à la livraison, SANS l'identité du vendeur ni le client
CREATE FUNCTION _owner_sale_alert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_owner uuid; v_name text;
BEGIN
  BEGIN
    IF NEW.product_id IS NOT NULL AND NEW.status IN ('confirmed','delivered') THEN
      SELECT p.supplier_id, p.name INTO v_owner, v_name FROM products p
       JOIN users u ON u.id = p.supplier_id AND u.role = 'seller'
       WHERE p.id = NEW.product_id AND p.supplier_id <> NEW.seller_id;
      IF v_owner IS NOT NULL THEN
        PERFORM _notify(v_owner, 'order', CASE WHEN NEW.status = 'delivered' THEN 'Vente livrée' ELSE 'Nouvelle vente' END,
          v_name || ' : ' || NEW.qty || ' unité(s)' || CASE WHEN NEW.status = 'delivered' THEN ' livrée(s).' ELSE ' vendue(s) par un autre vendeur.' END, 'products');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_owner_sale_alert AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION _owner_sale_alert();

-- Le propriétaire peut vendre son propre produit : on retire les 3 interdictions de 046 (l'achat de stock prépayé par soi-même reste interdit, il n'a pas de sens)
DROP TRIGGER orders_no_self_dealing ON orders;
DROP TRIGGER seller_prices_no_self_dealing ON seller_prices;
DROP TRIGGER seller_links_no_self_dealing ON seller_links;

-- Réécriture des fonctions existantes à partir de leur texte actuel
DO $mig$
DECLARE v_def text; v_new text; v_oid oid;
BEGIN
  -- 1. création de commande : marge 0 pour le propriétaire, et suspension / retrait pour les autres
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '_create_order';
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def, $a$v_sup := p.supplier_price; v_margin := p.margin_unit; v_wh := v_sup + v_margin;$a$,
                          $b$v_sup := p.supplier_price; v_margin := CASE WHEN p.supplier_id = p_seller THEN 0 ELSE p.margin_unit END; v_wh := v_sup + v_margin;$b$);
  IF v_new = v_def THEN RAISE EXCEPTION 'migration 047 : _create_order inchangée (marge)'; END IF;
  v_def := v_new;
  v_new := replace(v_def, $a$v_na := p_qty - v_nb;$a$,
                          $b$v_na := p_qty - v_nb;
    IF v_na > 0 AND (p.retired_at IS NOT NULL OR (p.paused_at IS NOT NULL AND p.supplier_id <> p_seller)) THEN
      PERFORM _err('out_of_stock', 'Ce produit n''est plus disponible pour le moment');
    END IF;$b$);
  IF v_new = v_def THEN RAISE EXCEPTION 'migration 047 : _create_order inchangée (suspension)'; END IF;
  EXECUTE v_new;

  -- 2. achat de stock prépayé : impossible sur un produit suspendu ou retiré
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_seller_buy_stock';
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def, $a$IF p.stock_qty - p.reserved_qty < p_qty THEN$a$,
                          $b$IF p.paused_at IS NOT NULL OR p.retired_at IS NOT NULL THEN PERFORM _err('out_of_stock', 'Ce produit n''est plus disponible pour le moment'); END IF;
  IF p.stock_qty - p.reserved_qty < p_qty THEN$b$);
  IF v_new = v_def THEN RAISE EXCEPTION 'migration 047 : fn_seller_buy_stock inchangée'; END IF;
  EXECUTE v_new;

  -- 3. prix de vente : le minimum du propriétaire ne contient pas la marge Wallindirain
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_seller_set_price';
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def, $a$v_min := _min_unit_price(p_product);$a$, $b$v_min := _min_unit_price_for(p_actor, p_product);$b$);
  IF v_new = v_def THEN RAISE EXCEPTION 'migration 047 : fn_seller_set_price inchangée'; END IF;
  EXECUTE v_new;
END $mig$;

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
