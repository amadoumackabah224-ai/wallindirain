-- Retour arrière de la 077 : retour à la fn_performance de la 075 (sans courbe ni quantité).
BEGIN;
CREATE OR REPLACE FUNCTION fn_performance(p_actor uuid, p_from date, p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users; v_admin boolean; v_sell uuid; v_tot jsonb; v_prod jsonb; v_zone jsonb; v_people jsonb;
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
    SELECT jsonb_build_object('name', COALESCE(p.name, o.own_product_name), 'orders', count(*), 'delivered', count(*) FILTER (WHERE o.status = 'delivered'),
             'lost', count(*) FILTER (WHERE o.status IN ('returned','refused','cancelled')), 'sales', COALESCE(sum(o.sale_total) FILTER (WHERE o.status = 'delivered'), 0)) AS x
      FROM orders o LEFT JOIN products p ON p.id = o.product_id
     WHERE o.created_at::date BETWEEN p_from AND p_to AND (v_sell IS NULL OR o.seller_id = v_sell)
     GROUP BY COALESCE(p.name, o.own_product_name) ORDER BY 1 LIMIT 15) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'orders')::int DESC), '[]'::jsonb) INTO v_zone FROM (
    SELECT jsonb_build_object('commune', commune, 'orders', count(*), 'delivered', count(*) FILTER (WHERE status = 'delivered'),
             'lost', count(*) FILTER (WHERE status IN ('returned','refused','cancelled'))) AS x
      FROM orders WHERE created_at::date BETWEEN p_from AND p_to AND (v_sell IS NULL OR seller_id = v_sell)
     GROUP BY commune LIMIT 20) s;

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
    'totals', v_tot, 'products', v_prod, 'zones', v_zone, 'sellers', v_people);
END $$;
DELETE FROM schema_migrations WHERE name = '077_performances_courbe.sql';
COMMIT;
