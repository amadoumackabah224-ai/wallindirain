-- 077 : performances. Ajoute à fn_performance (075) la quantité livrée par produit et la courbe d'évolution (par jour, ou par semaine au-delà de 92 jours).
-- Lecture seule, mêmes droits (administrateur : tout ; vendeur : ses chiffres), aucune marge pour le vendeur.
CREATE OR REPLACE FUNCTION fn_performance(p_actor uuid, p_from date, p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users; v_admin boolean; v_sell uuid; v_tot jsonb; v_prod jsonb; v_zone jsonb; v_people jsonb; v_series jsonb; v_week boolean;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND OR u.role NOT IN ('admin','seller') THEN PERFORM _err('forbidden', 'Accès refusé'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 366 THEN PERFORM _err('invalid_input', 'Période invalide'); END IF;
  v_admin := u.role = 'admin'; v_sell := CASE WHEN v_admin THEN NULL ELSE p_actor END;

  SELECT jsonb_build_object('orders', count(*), 'delivered', count(*) FILTER (WHERE status = 'delivered'),
           'lost', count(*) FILTER (WHERE status IN ('returned','refused','cancelled')),
           'in_progress', count(*) FILTER (WHERE status NOT IN ('delivered','returned','refused','cancelled')),
           'sales', COALESCE(sum(sale_total) FILTER (WHERE status = 'delivered'), 0))
    INTO v_tot FROM orders WHERE created_at::date BETWEEN p_from AND p_to AND (v_sell IS NULL OR seller_id = v_sell);

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'sales')::bigint DESC), '[]'::jsonb) INTO v_prod FROM (
    SELECT jsonb_build_object('name', COALESCE(p.name, o.own_product_name), 'orders', count(*), 'delivered', count(*) FILTER (WHERE o.status = 'delivered'), 'qty', COALESCE(sum(o.qty) FILTER (WHERE o.status = 'delivered'), 0),
             'lost', count(*) FILTER (WHERE o.status IN ('returned','refused','cancelled')), 'sales', COALESCE(sum(o.sale_total) FILTER (WHERE o.status = 'delivered'), 0)) AS x
      FROM orders o LEFT JOIN products p ON p.id = o.product_id
     WHERE o.created_at::date BETWEEN p_from AND p_to AND (v_sell IS NULL OR o.seller_id = v_sell)
     GROUP BY COALESCE(p.name, o.own_product_name) ORDER BY 1 LIMIT 15) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'orders')::int DESC), '[]'::jsonb) INTO v_zone FROM (
    SELECT jsonb_build_object('commune', commune, 'orders', count(*), 'delivered', count(*) FILTER (WHERE status = 'delivered'),
             'lost', count(*) FILTER (WHERE status IN ('returned','refused','cancelled'))) AS x
      FROM orders WHERE created_at::date BETWEEN p_from AND p_to AND (v_sell IS NULL OR seller_id = v_sell)
     GROUP BY commune LIMIT 20) s;

  -- évolution : par jour jusqu'à 92 jours, par semaine au-delà
  v_week := p_to - p_from > 92;
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'d'), '[]'::jsonb) INTO v_series FROM (
    SELECT jsonb_build_object('d', to_char(CASE WHEN v_week THEN date_trunc('week', created_at)::date ELSE created_at::date END, 'YYYY-MM-DD'), 'orders', count(*), 'delivered', count(*) FILTER (WHERE status = 'delivered'),
             'sales', COALESCE(sum(sale_total) FILTER (WHERE status = 'delivered'), 0)) AS x
      FROM orders WHERE created_at::date BETWEEN p_from AND p_to AND (v_sell IS NULL OR seller_id = v_sell)
     GROUP BY CASE WHEN v_week THEN date_trunc('week', created_at)::date ELSE created_at::date END) s;

  IF v_admin THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'sales')::bigint DESC), '[]'::jsonb) INTO v_people FROM (
      SELECT jsonb_build_object('name', u2.full_name, 'orders', count(*), 'delivered', count(*) FILTER (WHERE o.status = 'delivered'),
               'lost', count(*) FILTER (WHERE o.status IN ('returned','refused','cancelled')), 'sales', COALESCE(sum(o.sale_total) FILTER (WHERE o.status = 'delivered'), 0)) AS x
        FROM orders o JOIN users u2 ON u2.id = o.seller_id
       WHERE o.created_at::date BETWEEN p_from AND p_to GROUP BY u2.id, u2.full_name ORDER BY 1 LIMIT 15) s;
    v_tot := v_tot || jsonb_build_object('platform_revenue',
      (SELECT COALESCE(sum(amount) FILTER (WHERE amount > 0), 0) FROM wallet_entries WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid AND created_at::date BETWEEN p_from AND p_to));
  ELSE
    v_people := '[]'::jsonb;
    v_tot := v_tot || jsonb_build_object('gains', (SELECT COALESCE(sum(amount), 0) FROM wallet_entries WHERE user_id = p_actor AND kind = 'seller_gain' AND created_at::date BETWEEN p_from AND p_to));
  END IF;
  RETURN jsonb_build_object('scope', CASE WHEN v_admin THEN 'admin' ELSE 'seller' END, 'period', jsonb_build_object('from', p_from, 'to', p_to),
    'totals', v_tot, 'series', v_series, 'weekly', v_week, 'products', v_prod, 'zones', v_zone, 'sellers', v_people);
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
