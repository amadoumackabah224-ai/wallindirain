-- 038 : canal d'origine des commandes (Facebook, WhatsApp, TikTok…).
-- Ajout seulement : aucune commande existante n'est modifiée, aucun montant n'est touché.
-- La fonction est éteinte par défaut (réglage feature_order_channel = 0).
ALTER TABLE orders ADD COLUMN channel text
  CHECK (channel IS NULL OR channel IN ('facebook','whatsapp','tiktok','instagram','site','phone','other'));

INSERT INTO settings(key, value, label) VALUES
  ('feature_order_channel', 0, 'Canal d''origine des commandes (0 = éteint, 1 = allumé)');

CREATE FUNCTION fn_seller_set_channel(p_actor uuid, p_order uuid, p_channel text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_channel IS NULL OR p_channel NOT IN ('facebook','whatsapp','tiktok','instagram','site','phone','other') THEN
    PERFORM _err('invalid_input', 'Canal invalide');
  END IF;
  SELECT * INTO o FROM orders WHERE id = p_order AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  UPDATE orders SET channel = p_channel WHERE id = o.id;
  PERFORM _audit(p_actor, 'channel_set', 'order', o.id::text, jsonb_build_object('channel', p_channel));
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
