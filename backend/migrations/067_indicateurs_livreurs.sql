-- 067 : indicateurs de performance des livreurs (lecture seule).
-- Pour chaque livreur, sur une période : colis confiés, livrés, échecs et retours, taux de réussite, délai moyen, retards, gains, manques de caisse.
-- L'administrateur voit tous les livreurs ; un livreur ne voit que lui. Aucune écriture, aucun montant modifié.
INSERT INTO settings(key, value, label) VALUES
  ('courier_late_hours', 24, 'Délai au-delà duquel une livraison est comptée en retard (en heures, de l''affectation à la livraison)')
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION fn_courier_stats(p_actor uuid, p_from date, p_to date) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_role user_role; v_late int := _setting('courier_late_hours'); v_rows jsonb;
BEGIN
  SELECT role INTO v_role FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'courier') THEN PERFORM _err('forbidden', 'Action non autorisée'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN PERFORM _err('invalid_input', 'Période invalide'); END IF;
  IF p_to - p_from > 366 THEN PERFORM _err('invalid_input', 'Période d''un an au plus'); END IF;

  WITH o AS (
    SELECT o.id, o.courier_id, o.status, o.courier_pay,
           (SELECT min(h.at) FROM order_history h WHERE h.order_id = o.id AND h.to_status = 'assigned') AS assigned_at,
           (SELECT max(h.at) FROM order_history h WHERE h.order_id = o.id AND h.to_status = 'delivered') AS delivered_at
      FROM orders o
     WHERE o.courier_id IS NOT NULL AND o.created_at::date BETWEEN p_from AND p_to
       AND (v_role = 'admin' OR o.courier_id = p_actor)
  ), agg AS (
    SELECT courier_id,
           count(*) AS total,
           count(*) FILTER (WHERE status = 'delivered') AS delivered,
           count(*) FILTER (WHERE status IN ('failed', 'return_pending', 'returned', 'refused')) AS failed,
           count(*) FILTER (WHERE status IN ('assigned', 'picked_up', 'on_the_way')) AS in_progress,
           round(avg(extract(epoch FROM (delivered_at - assigned_at)) / 60) FILTER (WHERE status = 'delivered' AND delivered_at >= assigned_at))::int AS avg_minutes,
           count(*) FILTER (WHERE status = 'delivered' AND delivered_at - assigned_at > make_interval(hours => v_late)) AS late,
           COALESCE(sum(courier_pay) FILTER (WHERE status = 'delivered'), 0) AS earnings
      FROM o GROUP BY courier_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'courier_id', a.courier_id, 'name', u.full_name,
           'total', a.total, 'delivered', a.delivered, 'failed', a.failed, 'in_progress', a.in_progress,
           'success_rate', CASE WHEN a.delivered + a.failed > 0 THEN round(100.0 * a.delivered / (a.delivered + a.failed)) END,
           'avg_minutes', a.avg_minutes, 'late', a.late, 'earnings', a.earnings,
           'shortages', COALESCE((SELECT -sum(w.amount) FROM wallet_entries w WHERE w.user_id = a.courier_id AND w.kind = 'cash_shortage' AND w.amount < 0 AND w.created_at::date BETWEEN p_from AND p_to), 0)
         ) ORDER BY a.delivered DESC, u.full_name), '[]'::jsonb)
    INTO v_rows FROM agg a JOIN users u ON u.id = a.courier_id;

  RETURN jsonb_build_object('period', jsonb_build_object('from', p_from, 'to', p_to), 'late_hours', v_late, 'couriers', v_rows);
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
