-- =====================================================================
-- Migration 013 : rappel quand un colis affecté n'est pas récupéré par le livreur.
-- =====================================================================
INSERT INTO settings(key, value, label) VALUES
  ('pickup_alert_hours', 2, 'Colis affecté mais non récupéré : alerte après ce nombre d''heures (0 = désactivé)');

ALTER TABLE orders ADD COLUMN pickup_reminded_at timestamptz;

-- Envoie UN rappel au livreur pour chaque colis affecté et non récupéré depuis trop longtemps.
-- Appelée toutes les 10 minutes par le serveur. Une nouvelle affectation relance le compte à rebours.
CREATE FUNCTION fn_pickup_reminders() RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; v_hours bigint := _setting('pickup_alert_hours'); v_n int := 0;
BEGIN
  IF v_hours <= 0 THEN RETURN 0; END IF;
  FOR r IN
    SELECT o.id, o.ref, u.phone, s.since
      FROM orders o JOIN users u ON u.id = o.courier_id AND u.status = 'active' AND u.deleted_at IS NULL,
           LATERAL (SELECT max(h.at) AS since FROM order_history h WHERE h.order_id = o.id AND h.to_status = 'assigned') s
     WHERE o.status = 'assigned' AND s.since < now() - make_interval(hours => v_hours::int)
       AND (o.pickup_reminded_at IS NULL OR o.pickup_reminded_at < s.since)
     FOR UPDATE OF o SKIP LOCKED
  LOOP
    PERFORM _queue_message(r.phone, 'pickup_reminder',
      'Wallindirain : le colis ' || r.ref || ' vous est affecté depuis plus de ' || v_hours || ' h et n''est pas encore récupéré. Récupérez-le ou prévenez le chef call center.', r.id);
    UPDATE orders SET pickup_reminded_at = now() WHERE id = r.id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- ---------- Droits (mêmes règles que les migrations précédentes) ----------
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
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash')
       AND NOT (r.relname IN ('proofs','avatars') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
