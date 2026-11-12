-- =====================================================================
-- Migration 064 : codes par SMS (Nimba SMS). Réglage « sms_codes » éteint par défaut.
-- Allumé, les codes (livraison, retrait, mot de passe oublié, mot de passe provisoire) partent par SMS.
-- Éteint, rien ne change : ils partent comme avant. Les identifiants Nimba restent sur le serveur (jamais en base).
-- =====================================================================
INSERT INTO settings(key, value, label) VALUES
  ('sms_codes', 0, 'Codes envoyés par SMS (Nimba) au lieu de WhatsApp (1 = oui, 0 = non)')
ON CONFLICT (key) DO NOTHING;

-- Un code part par SMS quand le réglage est allumé
CREATE OR REPLACE FUNCTION _queue_message(p_phone text, p_template text, p_body text, p_order uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO messages(to_phone, channel, template, body, order_id)
  VALUES (p_phone,
          CASE WHEN p_template IN ('delivery_code', 'withdrawal_code', 'password_reset', 'temp_password') AND _setting('sms_codes') = 1 THEN 'sms' ELSE 'whatsapp' END,
          p_template, p_body, p_order)
$$;

-- Réglage : 0 ou 1
DO $$
DECLARE d text; a text := '''kyc_images_required'',''vehicle_check_required'') AND p_value > 1';
BEGIN
  SELECT pg_get_functiondef('fn_admin_set_setting(uuid,text,bigint)'::regprocedure) INTO d;
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'fn_admin_set_setting : repère introuvable'; END IF;
  EXECUTE replace(d, a, '''kyc_images_required'',''vehicle_check_required'',''sms_codes'') AND p_value > 1');
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
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'))
       AND NOT (r.relname = 'courier_vehicles' AND column_name IN ('plate_img','card_img'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

GRANT SELECT ON pf_all_tx TO wld_app;
