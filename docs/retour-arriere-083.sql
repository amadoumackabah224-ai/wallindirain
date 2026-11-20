-- Retour arrière de la 083 (rappels à heure). Refusé s'il existe des rappels avec une heure : rien n'est supprimé.
BEGIN;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM relance_reminders WHERE due_time IS NOT NULL) THEN RAISE EXCEPTION 'Retour arrière refusé : des rappels avec heure existent. Rien n''a été supprimé.'; END IF; END $$;
DO $$
DECLARE d text; b text := E'      (jsonb_build_object(''key'',''reminders'',''label'',''Client(s) à rappeler'',''tone'',''warn'',''tab'',''relances'',''n'',(SELECT count(*) FROM relance_reminders WHERE seller_id = p_actor AND ((due_on + COALESCE(due_time, time ''08:00''))::timestamp AT TIME ZONE ''UTC'') <= now()))),\n';
BEGIN
  d := pg_get_functiondef('fn_today(uuid)'::regprocedure);
  EXECUTE replace(d, b, '');
  d := pg_get_functiondef('fn_seller_relance_remind(uuid,text,date)'::regprocedure);
  EXECUTE replace(d, 'DO UPDATE SET due_on = EXCLUDED.due_on, due_time = NULL, notified_at = NULL, created_at = now();', 'DO UPDATE SET due_on = EXCLUDED.due_on, created_at = now();');
END $$;
DROP FUNCTION IF EXISTS fn_run_relance_reminders();
DROP FUNCTION IF EXISTS fn_seller_reminders(uuid);
DROP FUNCTION IF EXISTS fn_seller_relance_remind_at(uuid, text, date, text);
ALTER TABLE relance_reminders DROP COLUMN IF EXISTS due_time, DROP COLUMN IF EXISTS notified_at;
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

DELETE FROM schema_migrations WHERE name = '083_rappels_heure.sql';
COMMIT;
