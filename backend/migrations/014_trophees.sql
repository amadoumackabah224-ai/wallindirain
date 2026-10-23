-- =====================================================================
-- Migration 014 : trophées et classement mensuel des vendeurs.
-- Basé uniquement sur les commandes LIVRÉES (donc encaissées par le livreur) de produits des FOURNISSEURS du catalogue :
-- les ventes de produits personnels du vendeur ne comptent pas.
-- Les autres vendeurs ne voient jamais les montants : seulement rang, prénom + initiale, nombre de livraisons, trophée.
-- =====================================================================
INSERT INTO settings(key, value, label) VALUES
  ('trophy_bronze', 1000000,  'Trophée Bronze : ventes livrées cumulées (GNF)'),
  ('trophy_silver', 5000000,  'Trophée Argent : ventes livrées cumulées (GNF)'),
  ('trophy_gold',   20000000, 'Trophée Or : ventes livrées cumulées (GNF)'),
  ('trophy_diamond', 50000000, 'Trophée Diamant : ventes livrées cumulées (GNF)');

-- un vendeur peut se retirer du classement
ALTER TABLE users ADD COLUMN hide_ranking boolean NOT NULL DEFAULT false;

CREATE FUNCTION _trophy_tier(p_sales numeric) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_sales >= _setting('trophy_diamond') THEN 'diamond'
              WHEN p_sales >= _setting('trophy_gold') THEN 'gold'
              WHEN p_sales >= _setting('trophy_silver') THEN 'silver'
              WHEN p_sales >= _setting('trophy_bronze') THEN 'bronze'
              ELSE 'none' END
$$;

-- classement du mois en cours : vendeurs actifs, non masqués, avec au moins une livraison ce mois-ci
CREATE FUNCTION _month_ranking() RETURNS TABLE(seller_id uuid, sales bigint, delivered int, rk bigint) LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT o.seller_id, sum(o.sale_total)::bigint AS sales, count(*)::int AS delivered
      FROM orders o JOIN users s ON s.id = o.seller_id
     WHERE o.status = 'delivered' AND o.product_id IS NOT NULL AND o.delivered_at >= date_trunc('month', now())
       AND s.deleted_at IS NULL AND s.status = 'active' AND NOT s.hide_ranking
     GROUP BY o.seller_id)
  SELECT m.seller_id, m.sales, m.delivered, rank() OVER (ORDER BY m.sales DESC, m.delivered DESC) FROM m
$$;

CREATE FUNCTION fn_set_ranking_visibility(p_actor uuid, p_hidden boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, ARRAY['seller']::user_role[]);
  UPDATE users SET hide_ranking = COALESCE(p_hidden, false) WHERE id = u.id;
END $$;

CREATE FUNCTION fn_seller_ranking(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  u users; v_start timestamptz := date_trunc('month', now());
  v_life bigint; v_from bigint; v_tier text; v_next text; v_next_at bigint;
  v_rank int; v_n int; v_sales bigint := 0; v_deliv int := 0; v_top jsonb;
BEGIN
  u := _require(p_actor, ARRAY['seller']::user_role[]);
  SELECT COALESCE(sum(sale_total), 0) INTO v_life FROM orders WHERE seller_id = u.id AND status = 'delivered' AND product_id IS NOT NULL;
  v_tier := _trophy_tier(v_life);
  v_next := CASE v_tier WHEN 'none' THEN 'bronze' WHEN 'bronze' THEN 'silver' WHEN 'silver' THEN 'gold' WHEN 'gold' THEN 'diamond' ELSE NULL END;
  v_next_at := CASE v_next WHEN 'bronze' THEN _setting('trophy_bronze') WHEN 'silver' THEN _setting('trophy_silver') WHEN 'gold' THEN _setting('trophy_gold') WHEN 'diamond' THEN _setting('trophy_diamond') END;
  v_from := CASE v_tier WHEN 'bronze' THEN _setting('trophy_bronze') WHEN 'silver' THEN _setting('trophy_silver') WHEN 'gold' THEN _setting('trophy_gold') WHEN 'diamond' THEN _setting('trophy_diamond') ELSE 0 END;

  SELECT count(*) INTO v_n FROM _month_ranking();
  SELECT rk, sales, delivered INTO v_rank, v_sales, v_deliv FROM _month_ranking() WHERE seller_id = u.id;
  IF v_rank IS NULL THEN v_sales := 0; v_deliv := 0; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'rank', t.rk,
      'name', split_part(trim(s.full_name), ' ', 1)
              || CASE WHEN position(' ' IN trim(s.full_name)) > 0
                      THEN ' ' || upper(left(regexp_replace(trim(s.full_name), '^.*\s', ''), 1)) || '.' ELSE '' END,
      'delivered', t.delivered,
      'tier', _trophy_tier((SELECT COALESCE(sum(x.sale_total), 0) FROM orders x WHERE x.seller_id = t.seller_id AND x.status = 'delivered' AND x.product_id IS NOT NULL)),
      'me', t.seller_id = u.id) ORDER BY t.rk, t.delivered DESC), '[]'::jsonb)
    INTO v_top
    FROM (SELECT * FROM _month_ranking() ORDER BY rk, delivered DESC LIMIT 10) t JOIN users s ON s.id = t.seller_id;

  RETURN jsonb_build_object('month', to_char(v_start, 'YYYY-MM'), 'rank', v_rank, 'participants', v_n,
    'my_sales', v_sales, 'my_delivered', v_deliv, 'lifetime', v_life, 'tier', v_tier,
    'next_tier', v_next, 'next_at', v_next_at, 'tier_from', v_from,
    'tiers', jsonb_build_array(
      jsonb_build_object('tier', 'bronze', 'at', _setting('trophy_bronze')), jsonb_build_object('tier', 'silver', 'at', _setting('trophy_silver')),
      jsonb_build_object('tier', 'gold', 'at', _setting('trophy_gold')), jsonb_build_object('tier', 'diamond', 'at', _setting('trophy_diamond'))), 'hidden', u.hide_ranking, 'top', v_top);
END $$;

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
