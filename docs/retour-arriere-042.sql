-- Retour arrière de la migration 042 (renommage validé par l'administrateur).
-- Refuse s'il existe des demandes de changement de nom (sinon l'historique serait perdu).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM product_name_changes) THEN
    RAISE EXCEPTION 'retour arrière refusé : des demandes de changement de nom existent';
  END IF;
END $$;
DROP FUNCTION fn_supplier_edit_product(uuid, uuid, text, text);
DROP FUNCTION fn_admin_review_name_change(uuid, uuid, boolean, text);
DROP TABLE product_name_changes;
CREATE FUNCTION fn_supplier_edit_product(p_actor uuid, p_product uuid, p_name text, p_description text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products; v_name text := trim(COALESCE(p_name, '')); v_desc text := NULLIF(trim(COALESCE(p_description, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF length(v_name) < 2 OR length(v_name) > 120 THEN PERFORM _err('invalid_input', 'Nom du produit invalide (2 à 120 caractères)'); END IF;
  IF v_desc IS NOT NULL AND length(v_desc) > 1000 THEN PERFORM _err('invalid_input', 'Description trop longue (1000 caractères maximum)'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.status NOT IN ('pending','approved') THEN PERFORM _err('invalid_state', 'Ce produit ne peut plus être modifié'); END IF;
  UPDATE products SET name = v_name, description = v_desc WHERE id = p.id;
  PERFORM _audit(p_actor, 'product_edited', 'product', p.id::text, jsonb_build_object('name_changed', p.name <> v_name));
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

DELETE FROM schema_migrations WHERE name = '042_renommage_valide.sql';
