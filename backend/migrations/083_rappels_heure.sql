-- 083 : rappels clients à heure précise (« rappelez-moi à 11 h, à 17 h, dans une semaine »), avec notification à l'heure dite.
-- Étend le rappel daté de la 044 : heure facultative (8 h si absente), liste « Mes rappels » du vendeur, élément « clients à rappeler » dans « Aujourd'hui »,
-- et une notification envoyée UNE fois quand l'heure arrive (tâche régulière). Réservé aux vendeurs ; nécessite que les relances soient activées.
-- N'envoie rien au client : c'est un repère pour le vendeur. Un rappel manqué de plus de 2 jours est classé sans notification (pas de rafale).
-- Retour arrière : docs/retour-arriere-083.sql (rétablit 044/075 ; refusé s'il existe des rappels avec heure).
ALTER TABLE relance_reminders ADD COLUMN due_time time, ADD COLUMN notified_at timestamptz;

-- Un rappel modifié par l'ancienne fonction (date seule) repart sans heure ni notification passée
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('fn_seller_relance_remind(uuid,text,date)'::regprocedure);
  IF position('DO UPDATE SET due_on = EXCLUDED.due_on, created_at = now();' IN d) = 0 THEN RAISE EXCEPTION 'fn_seller_relance_remind : motif introuvable'; END IF;
  EXECUTE replace(d, 'DO UPDATE SET due_on = EXCLUDED.due_on, created_at = now();', 'DO UPDATE SET due_on = EXCLUDED.due_on, due_time = NULL, notified_at = NULL, created_at = now();');
END $$;

-- Rappel avec heure (p_time « HH:MM », NULL = 8 h) ; p_date NULL efface le rappel
CREATE FUNCTION fn_seller_relance_remind_at(p_actor uuid, p_phone text, p_date date, p_time text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_time time;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _relance_feature_on();
  IF p_phone IS NULL OR p_phone !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro du client invalide'); END IF;
  IF NOT EXISTS (SELECT 1 FROM orders WHERE seller_id = p_actor AND customer_phone = p_phone AND status <> 'cancelled') THEN PERFORM _err('not_found', 'Client introuvable'); END IF;
  IF p_date IS NULL THEN
    DELETE FROM relance_reminders WHERE seller_id = p_actor AND customer_phone = p_phone;
    RETURN;
  END IF;
  IF p_time IS NOT NULL AND p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN PERFORM _err('invalid_input', 'Heure invalide (HH:MM)'); END IF;
  v_time := COALESCE(p_time::time, time '08:00');
  IF p_date < current_date OR p_date > current_date + 365 OR (p_time IS NOT NULL AND ((p_date + v_time)::timestamp AT TIME ZONE 'UTC') < now() - interval '5 minutes') THEN
    PERFORM _err('invalid_input', 'Date et heure de rappel invalides (pas dans le passé, un an au plus)');
  END IF;
  IF EXISTS (SELECT 1 FROM relance_optouts WHERE seller_id = p_actor AND customer_phone = p_phone) THEN PERFORM _err('opted_out', 'Ce client a demandé à ne plus être contacté'); END IF;
  IF EXISTS (SELECT 1 FROM risky_customers WHERE customer_phone = p_phone) THEN PERFORM _err('risky_customer', 'Client à risque : il n''est jamais contacté par les relances'); END IF;
  -- date seule déjà « arrivée » (aujourd'hui après 8 h) : le vendeur vient de la choisir, pas de notification immédiate
  INSERT INTO relance_reminders(seller_id, customer_phone, due_on, due_time, notified_at)
  VALUES (p_actor, p_phone, p_date, p_time::time, CASE WHEN p_time IS NULL AND ((p_date + v_time)::timestamp AT TIME ZONE 'UTC') <= now() THEN now() END)
  ON CONFLICT (seller_id, customer_phone) DO UPDATE SET due_on = EXCLUDED.due_on, due_time = EXCLUDED.due_time, notified_at = EXCLUDED.notified_at, created_at = now();
  PERFORM _audit(p_actor, 'relance_reminder_set', 'customer', p_phone, jsonb_build_object('date', p_date, 'time', p_time));
END $$;

-- « Mes rappels » : les rappels du vendeur, du plus proche au plus lointain (en retard d'abord)
CREATE FUNCTION fn_seller_reminders(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('phone', r.customer_phone, 'name', COALESCE((SELECT o.customer_name FROM orders o WHERE o.seller_id = r.seller_id AND o.customer_phone = r.customer_phone ORDER BY o.created_at DESC LIMIT 1), r.customer_phone),
      'due_on', r.due_on, 'due_time', to_char(r.due_time, 'HH24:MI'),
      'overdue', ((r.due_on + COALESCE(r.due_time, time '08:00'))::timestamp AT TIME ZONE 'UTC') < now())
      ORDER BY r.due_on, COALESCE(r.due_time, time '08:00'))
    FROM relance_reminders r WHERE r.seller_id = p_actor), '[]'::jsonb);
END $$;

-- Tâche régulière : notifie le vendeur UNE fois quand l'heure d'un rappel arrive
CREATE FUNCTION fn_run_relance_reminders() RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; v_n int := 0; v_name text; v_due timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(70083) THEN RETURN 0; END IF;
  IF _setting('feature_relances') < 1 THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM relance_reminders WHERE notified_at IS NULL AND ((due_on + COALESCE(due_time, time '08:00'))::timestamp AT TIME ZONE 'UTC') <= now() FOR UPDATE LOOP
    v_due := ((r.due_on + COALESCE(r.due_time, time '08:00'))::timestamp AT TIME ZONE 'UTC');
    UPDATE relance_reminders SET notified_at = now() WHERE seller_id = r.seller_id AND customer_phone = r.customer_phone;
    IF v_due < now() - interval '2 days' THEN CONTINUE; END IF;                                  -- trop ancien : classé sans notification
    IF EXISTS (SELECT 1 FROM relance_optouts WHERE seller_id = r.seller_id AND customer_phone = r.customer_phone)
       OR EXISTS (SELECT 1 FROM risky_customers WHERE customer_phone = r.customer_phone) THEN CONTINUE; END IF;
    SELECT o.customer_name INTO v_name FROM orders o WHERE o.seller_id = r.seller_id AND o.customer_phone = r.customer_phone ORDER BY o.created_at DESC LIMIT 1;
    PERFORM _notify(r.seller_id, 'relance', 'Client à rappeler', COALESCE(v_name, r.customer_phone) || ' (' || r.customer_phone || ') : c''est l''heure de le rappeler.', 'relances');
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- « Aujourd'hui » du vendeur : clients à rappeler (rappels arrivés à échéance et pas encore faits)
DO $$
DECLARE d text; a text := E'      (jsonb_build_object(''key'',''proposals'',''label'',''Message(s) non lu(s)'',''tone'','''',''tab'',''wallet'',';
  b text := E'      (jsonb_build_object(''key'',''reminders'',''label'',''Client(s) à rappeler'',''tone'',''warn'',''tab'',''relances'',''n'',(SELECT count(*) FROM relance_reminders WHERE seller_id = p_actor AND ((due_on + COALESCE(due_time, time ''08:00''))::timestamp AT TIME ZONE ''UTC'') <= now()))),\n';
BEGIN
  d := pg_get_functiondef('fn_today(uuid)'::regprocedure);
  IF position(a IN d) = 0 THEN RAISE EXCEPTION 'fn_today : motif introuvable'; END IF;
  EXECUTE replace(d, a, b || a);
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
