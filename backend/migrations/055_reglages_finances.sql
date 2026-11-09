-- 055 : réglages de « Mes finances » : général (décimales, période par défaut), widgets du tableau de bord, seuils des jauges.
-- Tout est facultatif et personnel : sans réglage, rien ne change (30 jours, mêmes blocs qu'avant, seuils 0,9 et 1,2). Aucune donnée existante n'est modifiée.

ALTER TABLE pf_prefs
  ADD COLUMN decimals       boolean NOT NULL DEFAULT false,
  ADD COLUMN default_period text NOT NULL DEFAULT 'd30' CHECK (default_period IN ('today','week','month','year','d7','d30','w12','m6','y1')),
  ADD COLUMN widgets        jsonb CHECK (widgets IS NULL OR jsonb_typeof(widgets) = 'object'),
  ADD COLUMN g_income_low   numeric(5,2) CHECK (g_income_low   IS NULL OR g_income_low   BETWEEN 0 AND 10),
  ADD COLUMN g_income_high  numeric(5,2) CHECK (g_income_high  IS NULL OR g_income_high  BETWEEN 0 AND 10),
  ADD COLUMN g_flow_low     numeric(5,2) CHECK (g_flow_low     IS NULL OR g_flow_low     BETWEEN 0 AND 10),
  ADD COLUMN g_flow_high    numeric(5,2) CHECK (g_flow_high    IS NULL OR g_flow_high    BETWEEN 0 AND 10),
  ADD COLUMN g_balance_low  numeric(5,2) CHECK (g_balance_low  IS NULL OR g_balance_low  BETWEEN 0 AND 10),
  ADD COLUMN g_balance_high numeric(5,2) CHECK (g_balance_high IS NULL OR g_balance_high BETWEEN 0 AND 10),
  ADD CONSTRAINT pf_prefs_gauges_order CHECK (
    (g_income_low  IS NULL OR g_income_high  IS NULL OR g_income_low  < g_income_high) AND
    (g_flow_low    IS NULL OR g_flow_high    IS NULL OR g_flow_low    < g_flow_high) AND
    (g_balance_low IS NULL OR g_balance_high IS NULL OR g_balance_low < g_balance_high));

-- Enregistre tous les réglages d'un coup (la personne les voit sur un seul écran). p_gauges : objet {income_low, income_high, flow_low, ...} ; valeur vide = valeur par défaut.
CREATE FUNCTION fn_pf_settings_set(p_actor uuid, p_decimals boolean, p_period text, p_widgets jsonb, p_gauges jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE k text; val jsonb; g text[] := ARRAY['income_low','income_high','flow_low','flow_high','balance_low','balance_high']; n numeric(5,2)[] := ARRAY[NULL,NULL,NULL,NULL,NULL,NULL]::numeric[]; i int;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF p_period IS NULL OR p_period NOT IN ('today','week','month','year','d7','d30','w12','m6','y1') THEN PERFORM _err('invalid_input', 'Période invalide'); END IF;
  IF p_widgets IS NOT NULL THEN
    IF jsonb_typeof(p_widgets) <> 'object' THEN PERFORM _err('invalid_input', 'Réglage des blocs invalide'); END IF;
    FOR k, val IN SELECT * FROM jsonb_each(p_widgets) LOOP
      IF k NOT IN ('balance_evolution','accounts','cash_flow','planned_payments','cash_forecast','balance','expenses','top_expense','exchange_rate','budget','recent_tx') OR jsonb_typeof(val) <> 'boolean' THEN PERFORM _err('invalid_input', 'Bloc inconnu : ' || left(k, 30)); END IF;
    END LOOP;
  END IF;
  IF p_gauges IS NOT NULL THEN
    IF jsonb_typeof(p_gauges) <> 'object' THEN PERFORM _err('invalid_input', 'Seuils invalides'); END IF;
    FOR k IN SELECT jsonb_object_keys(p_gauges) LOOP
      IF NOT k = ANY (g) THEN PERFORM _err('invalid_input', 'Seuil inconnu'); END IF;
    END LOOP;
    FOR i IN 1..6 LOOP
      val := p_gauges -> g[i];
      IF val IS NOT NULL AND jsonb_typeof(val) <> 'null' THEN
        IF jsonb_typeof(val) <> 'number' THEN PERFORM _err('invalid_input', 'Seuil invalide'); END IF;
        n[i] := (val #>> '{}')::numeric;
        IF n[i] < 0 OR n[i] > 10 THEN PERFORM _err('invalid_input', 'Un seuil est compris entre 0 et 10'); END IF;
      END IF;
    END LOOP;
    IF (n[1] IS NOT NULL AND n[2] IS NOT NULL AND n[1] >= n[2]) OR (n[3] IS NOT NULL AND n[4] IS NOT NULL AND n[3] >= n[4]) OR (n[5] IS NOT NULL AND n[6] IS NOT NULL AND n[5] >= n[6]) THEN
      PERFORM _err('invalid_input', 'Le seuil « faible » doit être plus petit que le seuil « élevé »');
    END IF;
  END IF;
  INSERT INTO pf_prefs(owner_id, decimals, default_period, widgets, g_income_low, g_income_high, g_flow_low, g_flow_high, g_balance_low, g_balance_high)
    VALUES (p_actor, COALESCE(p_decimals, false), p_period, p_widgets, n[1], n[2], n[3], n[4], n[5], n[6])
    ON CONFLICT (owner_id) DO UPDATE SET decimals = EXCLUDED.decimals, default_period = EXCLUDED.default_period, widgets = EXCLUDED.widgets,
      g_income_low = EXCLUDED.g_income_low, g_income_high = EXCLUDED.g_income_high, g_flow_low = EXCLUDED.g_flow_low, g_flow_high = EXCLUDED.g_flow_high,
      g_balance_low = EXCLUDED.g_balance_low, g_balance_high = EXCLUDED.g_balance_high, updated_at = now();
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
