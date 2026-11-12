-- 066 : alertes graves pour les administrateurs (erreur interne, anomalie dans les comptes, messages bloqués).
-- Elles ne font que LIRE l'état et écrire une notification (cloche) et un message dans la file : aucun montant n'est touché.
-- Au plus une alerte par type et par tranche de 30 minutes, pour ne jamais inonder. Réglage ops_alerts : 1 = actif (défaut), 0 = coupé.
INSERT INTO settings(key, value, label) VALUES
  ('ops_alerts', 1, 'Alertes techniques aux administrateurs (erreur interne, anomalie des comptes, messages bloqués) : 1 = oui, 0 = non')
ON CONFLICT (key) DO NOTHING;

-- Prévient tous les administrateurs actifs (cloche + message). Renvoie vrai si une alerte a été créée.
CREATE FUNCTION fn_ops_alert(p_kind text, p_text text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r record; v_bucket text; v_new boolean := false; v_text text := left(p_text, 400);
BEGIN
  IF _setting('ops_alerts') <> 1 THEN RETURN false; END IF;
  v_bucket := to_char(now(), 'YYYY-MM-DD-HH24') || (CASE WHEN extract(minute FROM now()) >= 30 THEN 'b' ELSE 'a' END);
  FOR r IN SELECT id, phone FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LOOP
    IF _notify_once(r.id, 'ops:' || left(p_kind, 40) || ':' || v_bucket, 'system', 'Alerte technique', v_text, NULL) THEN
      v_new := true;
      IF r.phone IS NOT NULL THEN PERFORM _queue_message(r.phone, 'ops_alert', 'Wallindirain, alerte technique : ' || v_text); END IF;
    END IF;
  END LOOP;
  RETURN v_new;
END $$;

-- Contrôles périodiques (appelés par le serveur toutes les 10 minutes)
CREATE FUNCTION fn_run_ops_checks() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_led int; v_fail int; v_stuck int; v_n int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(70066) THEN RETURN jsonb_build_object('skipped', true); END IF;
  SELECT count(*) INTO v_led FROM fn_ledger_check();
  IF v_led > 0 AND fn_ops_alert('ledger', 'Contrôle des comptes : ' || v_led || ' anomalie(s) détectée(s). Ouvrez Finances et vérifiez avant tout paiement.') THEN v_n := v_n + 1; END IF;
  SELECT count(*) INTO v_fail FROM messages WHERE status = 'failed' AND created_at > now() - interval '30 minutes';
  IF v_fail >= 3 AND fn_ops_alert('msg_failed', v_fail || ' messages n''ont pas pu partir ces 30 dernières minutes. Vérifiez WhatsApp, SMS ou e-mail dans Journal > Messages.') THEN v_n := v_n + 1; END IF;
  SELECT count(*) INTO v_stuck FROM messages WHERE status = 'queued' AND created_at < now() - interval '15 minutes';
  IF v_stuck >= 1 AND fn_ops_alert('msg_stuck', v_stuck || ' message(s) attendent depuis plus de 15 minutes sans partir.') THEN v_n := v_n + 1; END IF;
  RETURN jsonb_build_object('ledger', v_led, 'failed', v_fail, 'stuck', v_stuck, 'alerts', v_n);
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
