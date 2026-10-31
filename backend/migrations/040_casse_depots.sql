-- 040 : casse ou perte sur un dépôt de vendeur déclarée par le magasinier.
-- Retire des unités libres du dépôt (jamais les réservées), prévient le vendeur et l'administration.
-- Aucune écriture d'argent : qui supporte la perte reste une décision de l'administration.
CREATE TABLE seller_deposit_losses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id  uuid NOT NULL REFERENCES seller_deposits(id),
  qty         int  NOT NULL CHECK (qty > 0),
  reason      text NOT NULL CHECK (reason IN ('damaged','lost','expired','other')),
  note        text NOT NULL CHECK (length(note) BETWEEN 3 AND 300),
  declared_by uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seller_deposit_losses_idx ON seller_deposit_losses(deposit_id, created_at DESC);
CREATE TRIGGER seller_deposit_losses_immutable BEFORE UPDATE OR DELETE ON seller_deposit_losses FOR EACH ROW EXECUTE FUNCTION trg_append_only();

CREATE FUNCTION fn_warehouse_declare_deposit_loss(p_actor uuid, p_deposit uuid, p_qty int, p_reason text, p_note text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE d seller_deposits; v_note text := trim(COALESCE(p_note, '')); v_id uuid; r record; v_label text;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  IF p_reason NOT IN ('damaged','lost','expired','other') THEN PERFORM _err('invalid_input', 'Motif invalide'); END IF;
  IF length(v_note) < 3 OR length(v_note) > 300 THEN PERFORM _err('invalid_input', 'Expliquez en quelques mots (3 à 300 caractères)'); END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 100000 THEN PERFORM _err('invalid_input', 'Quantité invalide'); END IF;
  SELECT * INTO d FROM seller_deposits WHERE id = p_deposit FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Dépôt introuvable'); END IF;
  IF d.status <> 'stored' THEN PERFORM _err('invalid_state', 'Ce dépôt n''a pas encore été compté'); END IF;
  IF d.qty - d.reserved_qty < p_qty THEN
    PERFORM _err('invalid_input', 'Seulement ' || (d.qty - d.reserved_qty) || ' unité(s) libre(s) : les autres sont réservées pour des commandes');
  END IF;
  UPDATE seller_deposits SET qty = qty - p_qty WHERE id = d.id;
  INSERT INTO seller_deposit_losses(deposit_id, qty, reason, note, declared_by) VALUES (d.id, p_qty, p_reason, v_note, p_actor) RETURNING id INTO v_id;
  PERFORM _audit(p_actor, 'deposit_loss', 'deposit', d.id::text, jsonb_build_object('qty', p_qty, 'reason', p_reason));
  BEGIN
    v_label := CASE p_reason WHEN 'damaged' THEN 'abîmé' WHEN 'lost' THEN 'perdu' WHEN 'expired' THEN 'périmé' ELSE 'retiré du stock' END;
    PERFORM _notify(d.seller_id, 'product', 'Stock retiré à l''entrepôt', d.name || ' : ' || p_qty || ' unité(s) ' || v_label || '. ' || v_note, 'todo');
    FOR r IN SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LOOP
      PERFORM _notify(r.id, 'product', 'Casse ou perte sur un dépôt de vendeur', d.name || ' : ' || p_qty || ' unité(s) ' || v_label || '. ' || v_note, 'dash');
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN v_id;
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
