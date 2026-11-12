-- 065 : Comptabilité de la société (administrateur seulement), à imprimer.
-- Lecture seule. Ne contient QUE des chiffres de la société : le portefeuille de la plateforme (en totaux par jour et par nature, jamais par personne ni par commande)
-- et les écritures que l'administrateur saisit lui-même dans « Mes finances » sur les comptes qu'il choisit.
-- Aucun nom, téléphone, adresse ni référence de commande n'en sort. Aucune règle fiscale n'est appliquée : le document est une base à faire valider par un expert-comptable.

CREATE FUNCTION _acc_label(p_kind text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'platform_revenue'   THEN 'Livraisons : frais, call center et marge'
    WHEN 'subscription'       THEN 'Abonnements vendeurs'
    WHEN 'pf_subscription'    THEN 'Abonnements Mes finances'
    WHEN 'team_pay'           THEN 'Rémunération de l''équipe'
    WHEN 'courier_prime'      THEN 'Primes livreurs'
    WHEN 'tour_bonus'         THEN 'Primes de tournée'
    WHEN 'tour_adjust'        THEN 'Ajustements de tournée'
    WHEN 'failed_trip'        THEN 'Courses non abouties'
    WHEN 'referral_bonus'     THEN 'Bonus de parrainage'
    WHEN 'return_fees'        THEN 'Frais de retour'
    WHEN 'return_fee_supplier' THEN 'Frais de retour (produit défectueux)'
    WHEN 'cash_shortage'      THEN 'Manques de caisse'
    WHEN 'transport_loss'     THEN 'Compensations de transport'
    ELSE 'Autres mouvements' END
$$;

CREATE FUNCTION fn_admin_accounting(p_actor uuid, p_from date, p_to date, p_accounts uuid[] DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_accs uuid[];
  v_auto jsonb; v_manual jsonb; v_rev bigint; v_chg bigint; v_open bigint; v_close bigint; v_wallet bigint; v_list jsonb;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN PERFORM _err('invalid_input', 'Période invalide'); END IF;
  IF p_to - p_from > 366 THEN PERFORM _err('invalid_input', 'Période d''un an au plus'); END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_accs FROM pf_accounts
   WHERE owner_id = p_actor AND archived_at IS NULL AND (p_accounts IS NULL OR id = ANY(p_accounts));

  -- Portefeuille de la plateforme : totaux par jour et par nature (le signe donne produit ou charge)
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'day', x->>'label'), '[]'::jsonb) INTO v_auto FROM (
    SELECT jsonb_build_object('day', created_at::date, 'label', _acc_label(kind), 'side', CASE WHEN amount > 0 THEN 'revenue' ELSE 'charge' END,
                              'count', count(*), 'amount', abs(sum(amount))) AS x
      FROM wallet_entries
     WHERE user_id = _platform() AND created_at::date BETWEEN p_from AND p_to
     GROUP BY created_at::date, _acc_label(kind), (amount > 0)
  ) s;

  -- Écritures de l'administrateur (exploitation seulement : les prêts et remboursements ne sont ni produit ni charge)
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'day', x->>'created'), '[]'::jsonb) INTO v_manual FROM (
    SELECT jsonb_build_object('day', t.occurred_on, 'created', t.created_at, 'side', CASE t.kind WHEN 'income' THEN 'revenue' ELSE 'charge' END,
             'label', COALESCE(cc.label, cs.label, t.category), 'note', t.note, 'amount', t.amount, 'account', a.name) AS x
      FROM pf_transactions t
      JOIN pf_accounts a ON a.id = t.account_id
      LEFT JOIN pf_cat_custom cc ON cc.owner_id = t.owner_id AND cc.key = t.category
      LEFT JOIN pf_cat_system cs ON cs.key = t.category
     WHERE t.owner_id = p_actor AND t.account_id = ANY(v_accs) AND t.voided_at IS NULL
       AND t.kind IN ('income','expense') AND COALESCE(cs.operating, true)
       AND t.occurred_on BETWEEN p_from AND p_to
  ) s;

  SELECT COALESCE(sum((x->>'amount')::bigint) FILTER (WHERE x->>'side' = 'revenue'), 0),
         COALESCE(sum((x->>'amount')::bigint) FILTER (WHERE x->>'side' = 'charge'), 0)
    INTO v_rev, v_chg FROM jsonb_array_elements(v_auto || v_manual) x;

  -- Trésorerie : comptes choisis (solde d'ouverture + mouvements avant la période, puis à la fin) et portefeuille de la plateforme
  SELECT COALESCE(sum(a.opening_balance), 0) + COALESCE((SELECT sum(CASE WHEN t.kind IN ('income','transfer_in') THEN t.amount ELSE -t.amount END)
           FROM pf_transactions t WHERE t.account_id = ANY(v_accs) AND t.voided_at IS NULL AND t.occurred_on < p_from), 0)
    INTO v_open FROM pf_accounts a WHERE a.id = ANY(v_accs);
  SELECT COALESCE(sum(a.opening_balance), 0) + COALESCE((SELECT sum(CASE WHEN t.kind IN ('income','transfer_in') THEN t.amount ELSE -t.amount END)
           FROM pf_transactions t WHERE t.account_id = ANY(v_accs) AND t.voided_at IS NULL AND t.occurred_on <= p_to), 0)
    INTO v_close FROM pf_accounts a WHERE a.id = ANY(v_accs);
  SELECT COALESCE(sum(amount), 0) INTO v_wallet FROM wallet_entries WHERE user_id = _platform() AND created_at::date <= p_to;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind) ORDER BY created_at), '[]'::jsonb) INTO v_list
    FROM pf_accounts WHERE owner_id = p_actor AND archived_at IS NULL;

  RETURN jsonb_build_object(
    'company', (SELECT to_jsonb(c) - 'id' FROM company_profile c WHERE id = 1),
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'accounts', v_list, 'selected', to_jsonb(v_accs),
    'automatic', v_auto, 'manual', v_manual,
    'revenue', v_rev, 'charges', v_chg, 'result', v_rev - v_chg,
    'treasury', jsonb_build_object('accounts_open', v_open, 'accounts_close', v_close, 'platform_wallet', v_wallet),
    'generated_at', now());
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
