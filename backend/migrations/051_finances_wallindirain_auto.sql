-- 051 : Mes finances reliées automatiquement au compte Wallindirain (Pro).
-- Une fois reliée, l'activité du portefeuille Wallindirain (gains, rémunérations, achats de stock, frais, abonnement) apparaît toute seule dans Mes finances,
-- dans un compte « Wallindirain » automatique ; les dépôts et retraits sont des virements avec le compte choisi (par défaut un compte « Mobile Money » créé pour l'occasion).
-- Lecture seule : une VUE lit les écritures du portefeuille, rien n'est copié ni écrit dans le portefeuille, et le grand livre n'est pas touché.
-- Chaque personne ne voit que son activité. Délier retire le compte automatique ; les comptes et transactions saisis à la main restent.

ALTER TABLE pf_prefs
  ADD COLUMN wallet_linked  boolean NOT NULL DEFAULT false,
  ADD COLUMN wallet_account uuid REFERENCES pf_accounts(id);

-- Transactions de Mes finances = celles saisies + celles qui viennent du portefeuille Wallindirain (si relié)
CREATE VIEW pf_all_tx AS
  SELECT t.id::text AS id, t.owner_id, t.account_id, t.kind, t.amount, t.category, t.note, t.occurred_on, t.transfer_id, t.created_at, t.voided_at, 'manual'::text AS source
    FROM pf_transactions t
  UNION ALL
  SELECT 'w' || e.id, e.user_id, NULL::uuid, m.kind, abs(e.amount), m.category, m.note, e.available_at::date, NULL::uuid, e.created_at, NULL::timestamptz, 'wallindirain'
    FROM wallet_entries e
    JOIN pf_prefs p ON p.owner_id = e.user_id AND p.wallet_linked
    CROSS JOIN LATERAL (SELECT
        CASE WHEN e.kind IN ('deposit','withdrawal_refund') THEN 'transfer_in' WHEN e.kind = 'withdrawal' THEN 'transfer_out' WHEN e.amount > 0 THEN 'income' ELSE 'expense' END AS kind,
        CASE e.kind WHEN 'seller_gain' THEN 'sales' WHEN 'supplier_payment' THEN 'sales' WHEN 'team_pay' THEN 'salary' WHEN 'courier_prime' THEN 'salary' WHEN 'tour_bonus' THEN 'salary' WHEN 'tour_adjust' THEN CASE WHEN e.amount > 0 THEN 'salary' ELSE 'other_out' END
          WHEN 'failed_trip' THEN 'salary' WHEN 'share' THEN 'salary' WHEN 'referral_bonus' THEN 'gift'
          WHEN 'deposit' THEN 'transfer' WHEN 'withdrawal' THEN 'transfer' WHEN 'withdrawal_refund' THEN 'transfer'
          WHEN 'stock_purchase' THEN 'business' WHEN 'return_fees' THEN 'business' WHEN 'return_fee_supplier' THEN 'business' WHEN 'cash_shortage' THEN 'business' WHEN 'subscription' THEN 'business'
          ELSE CASE WHEN e.amount > 0 THEN 'other_in' ELSE 'other_out' END END AS category,
        COALESCE(CASE e.kind WHEN 'seller_gain' THEN 'Gain de vente' WHEN 'supplier_payment' THEN 'Paiement produit' WHEN 'team_pay' THEN 'Rémunération' WHEN 'courier_prime' THEN 'Prime livreur' WHEN 'tour_bonus' THEN 'Bonus de tournée'
          WHEN 'tour_adjust' THEN 'Ajustement de tournée' WHEN 'failed_trip' THEN 'Course non aboutie' WHEN 'share' THEN 'Part de tournée' WHEN 'referral_bonus' THEN 'Bonus de parrainage' WHEN 'deposit' THEN 'Dépôt sur Wallindirain'
          WHEN 'withdrawal' THEN 'Retrait vers mon compte' WHEN 'withdrawal_refund' THEN 'Retrait refusé (remboursé)' WHEN 'stock_purchase' THEN 'Achat de stock' WHEN 'return_fees' THEN 'Frais de retour'
          WHEN 'return_fee_supplier' THEN 'Frais de retour (produit défectueux)' WHEN 'cash_shortage' THEN 'Manque de caisse' WHEN 'subscription' THEN 'Abonnement Wallindirain' WHEN 'prepaid_refund' THEN 'Remboursement de stock'
          WHEN 'transport_loss' THEN 'Compensation transport' WHEN 'pf_subscription' THEN 'Abonnement Mes finances' END, e.description, 'Wallindirain') AS note) m
   WHERE e.available_at <= now()
  UNION ALL
  -- l'autre côté des dépôts et retraits : le compte choisi (par défaut « Mobile Money »)
  SELECT 'm' || e.id, e.user_id, p.wallet_account, CASE WHEN e.kind IN ('withdrawal') THEN 'transfer_in' ELSE 'transfer_out' END, abs(e.amount), 'transfer',
         CASE e.kind WHEN 'deposit' THEN 'Dépôt sur Wallindirain' WHEN 'withdrawal' THEN 'Retrait depuis Wallindirain' ELSE 'Retrait refusé (remboursé)' END,
         e.available_at::date, NULL::uuid, e.created_at, NULL::timestamptz, 'wallindirain'
    FROM wallet_entries e
    JOIN pf_prefs p ON p.owner_id = e.user_id AND p.wallet_linked AND p.wallet_account IS NOT NULL
   WHERE e.available_at <= now() AND e.kind IN ('deposit','withdrawal','withdrawal_refund');

-- Relier (Pro) : p_account vide = créer un compte « Mobile Money » qui reçoit les retraits ; sinon un de mes comptes
CREATE FUNCTION fn_pf_wallet_link(p_actor uuid, p_account uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_acc uuid := p_account;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pfwl:' || p_actor::text));
  IF (SELECT role FROM users WHERE id = p_actor) NOT IN ('seller','supplier','agent','call_chief','courier') THEN PERFORM _err('forbidden', 'Ce compte n''a pas de portefeuille Wallindirain'); END IF;
  IF v_acc IS NULL THEN
    v_acc := fn_pf_account_save(p_actor, NULL, 'Mobile Money', 'mobile_money', 'orange', 0);
  ELSIF NOT EXISTS (SELECT 1 FROM pf_accounts WHERE id = v_acc AND owner_id = p_actor AND archived_at IS NULL) THEN
    PERFORM _err('not_found', 'Compte introuvable');
  END IF;
  INSERT INTO pf_prefs(owner_id, wallet_linked, wallet_account) VALUES (p_actor, true, v_acc)
    ON CONFLICT (owner_id) DO UPDATE SET wallet_linked = true, wallet_account = v_acc, updated_at = now();
  RETURN v_acc;
END $$;

CREATE FUNCTION fn_pf_wallet_unlink(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  UPDATE pf_prefs SET wallet_linked = false, updated_at = now() WHERE owner_id = p_actor;
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
GRANT SELECT ON pf_all_tx TO wld_app;
