-- 075 : pilotage. Sept apports, TOUS en lecture : aucune règle économique, aucun circuit d'argent, aucune donnée n'est modifié.
--   1. anomalies comptables (liste + alerte périodique aux administrateurs, via fn_ops_alert de la 066)
--   2. centre « Aujourd'hui » par rôle
--   3. historique centralisé d'un produit (assemblé depuis les journaux existants)
--   4. rapports financiers automatiques (journalier, hebdomadaire, mensuel) archivés en AJOUT SEUL
--   5. dettes et créances de l'entreprise
--   6. performances commerciales (administrateur : tout ; vendeur : ses propres chiffres, sans marge de la plateforme)
--   7. dossier documentaire d'une commande et d'un retrait
-- Seule structure nouvelle : la table company_reports (archive des rapports). Retour arrière : docs/retour-arriere-075.sql.
INSERT INTO settings(key, value, label) VALUES
  ('auto_reports', 0, 'Rapports financiers automatiques (journalier, hebdomadaire, mensuel) : 1 = oui, 0 = non (la génération manuelle reste possible)')
ON CONFLICT (key) DO NOTHING;

-- ============ 4. archive des rapports (ajout seul) ============
CREATE TABLE company_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('daily','weekly','monthly')),
  period_from  date NOT NULL,
  period_to    date NOT NULL CHECK (period_to >= period_from),
  data         jsonb NOT NULL,
  generated_by uuid REFERENCES users(id),          -- NULL : généré automatiquement
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, period_from)
);
CREATE TRIGGER company_reports_append_only BEFORE UPDATE OR DELETE ON company_reports FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- ============ 1. anomalies comptables ============
-- Liste interne : (code, gravité, libellé, détail). Ne modifie rien.
CREATE FUNCTION _anomaly_list() RETURNS TABLE(code text, severity text, label text, detail text)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_cash bigint := _setting('alert_cash_hours');
BEGIN
  RETURN QUERY SELECT 'ledger'::text, 'bad'::text, ('Comptes : ' || l.problem)::text, l.detail FROM fn_ledger_check() l;
  RETURN QUERY
    SELECT 'negative_balance'::text, 'bad'::text, 'Solde négatif dans un portefeuille'::text,
           (u.full_name || ' (' || u.role::text || ') : ' || s.bal || ' GNF')::text
      FROM (SELECT user_id, sum(amount)::bigint AS bal FROM wallet_entries GROUP BY user_id HAVING sum(amount) < 0) s
      JOIN users u ON u.id = s.user_id
     WHERE s.user_id <> '00000000-0000-0000-0000-000000000001'::uuid AND u.role <> 'system';
  IF v_cash > 0 THEN
    RETURN QUERY
      SELECT 'cash_overdue'::text, 'warn'::text, 'Argent encaissé non reversé depuis longtemps'::text,
             (u.full_name || ' : ' || sum(e.amount)::bigint || ' GNF depuis plus de ' || (v_cash * 2) || ' h')::text
        FROM courier_cash_entries e JOIN users u ON u.id = e.courier_id
       WHERE e.count_id IS NULL AND e.remittance_id IS NULL AND e.created_at < now() - make_interval(hours => (v_cash * 2)::int)
       GROUP BY u.id, u.full_name;
  END IF;
  RETURN QUERY
    SELECT 'withdrawal_waiting'::text, 'warn'::text, 'Retrait en attente depuis plus de 3 jours'::text,
           (count(*) || ' demande(s), ' || COALESCE(sum(w.amount), 0)::bigint || ' GNF')::text
      FROM withdrawals w WHERE w.status = 'requested' AND w.created_at < now() - interval '3 days' HAVING count(*) > 0;
  RETURN QUERY
    SELECT 'remittance_waiting'::text, 'warn'::text, 'Reversement à contrôler depuis plus de 2 jours'::text,
           (count(*) || ' reversement(s), ' || COALESCE(sum(r.amount), 0)::bigint || ' GNF')::text
      FROM remittances r WHERE r.status = 'pending' AND r.created_at < now() - interval '2 days' HAVING count(*) > 0;
END $$;

CREATE FUNCTION fn_accounting_anomalies(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('code', code, 'severity', severity, 'label', label, 'detail', detail)
                          ORDER BY (severity = 'bad') DESC, code, detail) FROM _anomaly_list()), '[]'::jsonb);
END $$;

-- Appelée par le serveur toutes les 10 minutes. Une alerte par type et par demi-heure (fn_ops_alert), jamais de modification d'argent.
CREATE FUNCTION fn_run_anomaly_checks() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record; v_n int := 0; v_total int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(70075) THEN RETURN jsonb_build_object('skipped', true); END IF;
  FOR r IN SELECT code, severity, count(*)::int AS n, min(label) AS label FROM _anomaly_list() WHERE code <> 'ledger' GROUP BY code, severity LOOP
    v_total := v_total + r.n;
    IF fn_ops_alert('anomaly_' || r.code, r.label || ' (' || r.n || '). Ouvrez Suivi > Alertes pour le détail.') THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('anomalies', v_total, 'alerts', v_n);
END $$;

-- ============ 2. « Aujourd'hui » ============
-- Renvoie les actions à traiter, propres au rôle : [{key, label, n, tone, tab}] (seulement celles dont n > 0).
CREATE FUNCTION fn_today(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users; v jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Accès refusé'); END IF;

  IF u.role = 'admin' THEN
    SELECT jsonb_agg(x) INTO v FROM (VALUES
      (jsonb_build_object('key','anomalies','label','Anomalie(s) comptable(s) à examiner','tone','bad','tab','pilot','n',(SELECT count(*) FROM _anomaly_list()))),
      (jsonb_build_object('key','withdrawals','label','Retrait(s) à payer','tone','warn','tab','withdrawals','n',(SELECT count(*) FROM withdrawals WHERE status = 'requested'))),
      (jsonb_build_object('key','remittances','label','Reversement(s) de livreur à contrôler','tone','warn','tab','remit','n',(SELECT count(*) FROM remittances WHERE status = 'pending'))),
      (jsonb_build_object('key','products','label','Produit(s) à valider','tone','','tab','products','n',(SELECT count(*) FROM products WHERE status = 'pending' AND deleted_at IS NULL))),
      (jsonb_build_object('key','orders_new','label','Nouvelle(s) commande(s) non encore traitée(s)','tone','','tab','orders','n',(SELECT count(*) FROM orders WHERE status = 'new'))),
      (jsonb_build_object('key','orders_late','label','Colis en cours depuis plus de 24 h','tone','warn','tab','orders','n',(SELECT count(*) FROM orders WHERE status IN ('assigned','picked_up','on_the_way') AND confirmed_at < now() - interval '24 hours'))),
      (jsonb_build_object('key','dlv','label','Course(s) à la demande en attente','tone','','tab','dlv','n',(SELECT count(*) FROM dlv_requests WHERE status = 'new')))
    ) t(x) WHERE (x->>'n')::bigint > 0;
  ELSIF u.role = 'seller' THEN
    SELECT jsonb_agg(x) INTO v FROM (VALUES
      (jsonb_build_object('key','to_confirm','label','Commande(s) en attente de confirmation','tone','','tab','orders','n',(SELECT count(*) FROM orders WHERE seller_id = p_actor AND status IN ('new','in_call')))),
      (jsonb_build_object('key','on_road','label','Colis en cours de livraison','tone','','tab','orders','n',(SELECT count(*) FROM orders WHERE seller_id = p_actor AND status IN ('confirmed','assigned','picked_up','on_the_way')))),
      (jsonb_build_object('key','failed','label','Livraison(s) échouée(s) à relancer','tone','warn','tab','orders','n',(SELECT count(*) FROM orders WHERE seller_id = p_actor AND status IN ('failed','return_pending')))),
      (jsonb_build_object('key','delivered_today','label','Livraison(s) réussie(s) aujourd''hui','tone','ok','tab','orders','n',(SELECT count(*) FROM orders WHERE seller_id = p_actor AND status = 'delivered' AND delivered_at::date = current_date))),
      (jsonb_build_object('key','proposals','label','Message(s) non lu(s)','tone','','tab','wallet','n',(SELECT count(*) FROM notifications WHERE user_id = p_actor AND read_at IS NULL)))
    ) t(x) WHERE (x->>'n')::bigint > 0;
  ELSIF u.role = 'supplier' THEN
    SELECT jsonb_agg(x) INTO v FROM (VALUES
      (jsonb_build_object('key','pending','label','Produit(s) en attente de validation','tone','','tab','products','n',(SELECT count(*) FROM products WHERE supplier_id = p_actor AND status = 'pending' AND deleted_at IS NULL))),
      (jsonb_build_object('key','low','label','Produit(s) en stock bas ou en rupture','tone','warn','tab','products','n',(SELECT count(*) FROM products WHERE supplier_id = p_actor AND status = 'approved' AND deleted_at IS NULL AND storage = 'wallindirain' AND (stock_qty - reserved_qty) <= _setting('alert_low_stock_qty') AND _setting('alert_low_stock_qty') > 0))),
      (jsonb_build_object('key','parcels','label','Colis en cours pour vos produits','tone','','tab','orders','n',(SELECT count(*) FROM orders o JOIN products p ON p.id = o.product_id WHERE p.supplier_id = p_actor AND o.status IN ('confirmed','assigned','picked_up','on_the_way')))),
      (jsonb_build_object('key','unread','label','Message(s) non lu(s)','tone','','tab','products','n',(SELECT count(*) FROM notifications WHERE user_id = p_actor AND read_at IS NULL)))
    ) t(x) WHERE (x->>'n')::bigint > 0;
  ELSIF u.role = 'courier' THEN
    SELECT jsonb_agg(x) INTO v FROM (VALUES
      (jsonb_build_object('key','to_pick','label','Colis à récupérer','tone','warn','tab','orders','n',(SELECT count(*) FROM orders WHERE courier_id = p_actor AND status = 'assigned'))),
      (jsonb_build_object('key','to_deliver','label','Colis à livrer','tone','','tab','orders','n',(SELECT count(*) FROM orders WHERE courier_id = p_actor AND status IN ('picked_up','on_the_way')))),
      (jsonb_build_object('key','cash','label','Argent encaissé à reverser (GNF)','tone','warn','tab','cash','n',(SELECT COALESCE(sum(amount), 0) FROM courier_cash_entries WHERE courier_id = p_actor AND count_id IS NULL AND remittance_id IS NULL))),
      (jsonb_build_object('key','done_today','label','Livraison(s) réussie(s) aujourd''hui','tone','ok','tab','orders','n',(SELECT count(*) FROM orders WHERE courier_id = p_actor AND status = 'delivered' AND delivered_at::date = current_date)))
    ) t(x) WHERE (x->>'n')::bigint > 0;
  ELSIF u.role IN ('call_chief','agent') THEN
    SELECT jsonb_agg(x) INTO v FROM (VALUES
      (jsonb_build_object('key','queue','label','Commande(s) dans la file d''appel','tone','','tab','queue','n',(SELECT count(*) FROM orders WHERE status = 'new'))),
      (jsonb_build_object('key','mine','label','Commande(s) que vous traitez','tone','','tab','mine','n',(SELECT count(*) FROM orders WHERE status = 'in_call' AND locked_by = p_actor))),
      (jsonb_build_object('key','assign','label','Commande(s) confirmée(s) à affecter','tone','warn','tab','assign','n',(SELECT count(*) FROM orders WHERE status = 'confirmed' AND courier_id IS NULL AND u.role = 'call_chief'))),
      (jsonb_build_object('key','pickups','label','Colis affecté(s) non récupéré(s) depuis plus de 24 h','tone','warn','tab','assign','n',(SELECT count(*) FROM orders o WHERE o.status = 'assigned' AND u.role = 'call_chief' AND o.confirmed_at < now() - interval '24 hours')))
    ) t(x) WHERE (x->>'n')::bigint > 0;
  ELSIF u.role = 'warehouse' THEN
    SELECT jsonb_agg(x) INTO v FROM (VALUES
      (jsonb_build_object('key','arrivals','label','Arrivage(s) annoncé(s) à compter','tone','','tab','todo','n',(SELECT count(*) FROM arrivals WHERE counted_qty IS NULL))),
      (jsonb_build_object('key','returns','label','Retour(s) de stock à remettre','tone','','tab','todo','n',(SELECT count(*) FROM stock_returns WHERE status = 'approved')))
    ) t(x) WHERE (x->>'n')::bigint > 0;
  END IF;
  RETURN jsonb_build_object('role', u.role, 'items', COALESCE(v, '[]'::jsonb));
END $$;

-- ============ 3. historique d'un produit ============
-- Assemble les journaux existants (création, nom, prix, arrivages, inventaires, pertes, retours, commandes) : aucune marge n'y figure.
CREATE FUNCTION fn_product_history(p_actor uuid, p_product uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users; p products; v jsonb;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Accès refusé'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF NOT (u.role IN ('admin','warehouse') OR (u.role = 'supplier' AND p.supplier_id = p_actor)) THEN PERFORM _err('forbidden', 'Accès refusé'); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'text', e.txt) ORDER BY e.at DESC), '[]'::jsonb) INTO v FROM (
    SELECT p.created_at AS at, 'created' AS kind, 'Produit enregistré' AS txt
    UNION ALL SELECT paused_at, 'paused', 'Mis en pause' FROM products WHERE id = p_product AND paused_at IS NOT NULL
    UNION ALL SELECT retired_at, 'retired', 'Retiré de la vente' FROM products WHERE id = p_product AND retired_at IS NOT NULL
    UNION ALL SELECT created_at, 'price', 'Changement de prix demandé : ' || old_price || ' → ' || new_price || ' GNF (' || CASE status WHEN 'approved' THEN 'accepté' WHEN 'rejected' THEN 'refusé' ELSE 'en attente' END || ')' FROM product_price_changes WHERE product_id = p_product
    UNION ALL SELECT created_at, 'name', 'Changement de nom demandé : « ' || old_name || ' » → « ' || new_name || ' » (' || CASE status WHEN 'approved' THEN 'accepté' WHEN 'rejected' THEN 'refusé' ELSE 'en attente' END || ')' FROM product_name_changes WHERE product_id = p_product
    UNION ALL SELECT created_at, 'arrival', 'Arrivage annoncé : ' || announced_qty || ' unité(s)' FROM arrivals WHERE product_id = p_product
    UNION ALL SELECT counted_at, 'arrival', 'Arrivage compté : ' || counted_qty || ' unité(s)' FROM arrivals WHERE product_id = p_product AND counted_at IS NOT NULL
    UNION ALL SELECT counted_at, 'count', 'Inventaire : attendu ' || expected_qty || ', compté ' || counted_qty || ' (' || CASE status WHEN 'matched' THEN 'conforme' WHEN 'approved' THEN 'écart accepté' WHEN 'rejected' THEN 'écart refusé' ELSE 'écart à décider' END || ')' FROM stock_counts WHERE product_id = p_product
    UNION ALL SELECT created_at, 'loss', 'Perte déclarée : ' || qty || ' unité(s) (' || CASE reason WHEN 'damaged' THEN 'abîmé' WHEN 'lost' THEN 'perdu' WHEN 'expired' THEN 'périmé' ELSE 'autre' END || ')' FROM stock_losses WHERE product_id = p_product
    UNION ALL SELECT requested_at, 'return', 'Retour de stock demandé : ' || qty || ' unité(s)' FROM stock_returns WHERE product_id = p_product
    UNION ALL SELECT handed_at, 'return', 'Retour de stock remis : ' || qty || ' unité(s)' FROM stock_returns WHERE product_id = p_product AND handed_at IS NOT NULL
    UNION ALL SELECT created_at, 'order', 'Commande ' || ref || ' : ' || qty || ' unité(s), ' || status::text FROM (SELECT ref, qty, status, created_at FROM orders WHERE product_id = p_product ORDER BY created_at DESC LIMIT 40) o
  ) e(at, kind, txt) WHERE e.at IS NOT NULL;
  RETURN jsonb_build_object('product', jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status, 'stock_qty', p.stock_qty, 'reserved_qty', p.reserved_qty), 'events', v);
END $$;

-- ============ 4. rapports financiers ============
-- Chiffres d'une période (jamais de donnée personnelle). Interne.
CREATE FUNCTION _report_data(p_from date, p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE r jsonb;
BEGIN
  SELECT jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'orders_created', (SELECT count(*) FROM orders WHERE created_at::date BETWEEN p_from AND p_to),
    'delivered', (SELECT jsonb_build_object('count', count(*), 'sale_total', COALESCE(sum(sale_total), 0), 'delivery_fees', COALESCE(sum(delivery_fee), 0)) FROM orders WHERE status = 'delivered' AND delivered_at::date BETWEEN p_from AND p_to),
    'not_delivered', (SELECT count(*) FROM orders WHERE status IN ('returned','refused','cancelled') AND closed_at::date BETWEEN p_from AND p_to),
    'platform_revenue', (SELECT COALESCE(sum(amount) FILTER (WHERE amount > 0), 0) FROM wallet_entries WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid AND created_at::date BETWEEN p_from AND p_to),
    'platform_charges', (SELECT COALESCE(abs(sum(amount) FILTER (WHERE amount < 0)), 0) FROM wallet_entries WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid AND created_at::date BETWEEN p_from AND p_to),
    'seller_gains', (SELECT COALESCE(sum(amount), 0) FROM wallet_entries WHERE kind = 'seller_gain' AND created_at::date BETWEEN p_from AND p_to),
    'withdrawals_paid', (SELECT jsonb_build_object('count', count(*), 'total', COALESCE(sum(amount), 0)) FROM withdrawals WHERE status = 'paid' AND decided_at::date BETWEEN p_from AND p_to),
    'remittances_received', (SELECT COALESCE(sum(received), 0) FROM remittances WHERE status = 'confirmed' AND decided_at::date BETWEEN p_from AND p_to),
    'cash_held_now', (SELECT COALESCE(sum(amount), 0) FROM courier_cash_entries WHERE count_id IS NULL AND remittance_id IS NULL),
    'anomalies_now', (SELECT count(*) FROM _anomaly_list())
  ) INTO r;
  RETURN r;
END $$;

-- Crée un rapport s'il n'existe pas (le même rapport n'est jamais archivé deux fois). Renvoie vrai s'il vient d'être créé.
CREATE FUNCTION _report_make(p_kind text, p_from date, p_to date, p_actor uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  INSERT INTO company_reports(kind, period_from, period_to, data, generated_by)
  VALUES (p_kind, p_from, p_to, _report_data(p_from, p_to), p_actor) ON CONFLICT (kind, period_from) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

-- Appelée par le serveur : hier, la semaine ISO et le mois écoulés (périodes terminées seulement). Réglage auto_reports.
CREATE FUNCTION fn_run_reports() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_n int := 0; v_wk date := date_trunc('week', current_date)::date - 7; v_mo date := (date_trunc('month', current_date) - interval '1 month')::date; r record;
BEGIN
  IF _setting('auto_reports') <> 1 THEN RETURN jsonb_build_object('disabled', true); END IF;
  IF NOT pg_try_advisory_xact_lock(70076) THEN RETURN jsonb_build_object('skipped', true); END IF;
  IF _report_make('daily', current_date - 1, current_date - 1, NULL) THEN v_n := v_n + 1; END IF;
  IF _report_make('weekly', v_wk, v_wk + 6, NULL) THEN v_n := v_n + 1; END IF;
  IF _report_make('monthly', v_mo, (v_mo + interval '1 month - 1 day')::date, NULL) THEN v_n := v_n + 1; END IF;
  IF v_n > 0 THEN
    FOR r IN SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL LOOP
      PERFORM _notify_once(r.id, 'report:' || to_char(current_date, 'YYYY-MM-DD'), 'system', 'Rapports financiers disponibles', 'Les rapports de la période écoulée sont archivés (Finances > Rapports).', NULL);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('created', v_n);
END $$;

CREATE FUNCTION fn_admin_reports(p_actor uuid, p_kind text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'from', period_from, 'to', period_to, 'auto', generated_by IS NULL, 'created_at', created_at, 'data', data)
                          ORDER BY period_from DESC, kind) FROM (SELECT * FROM company_reports WHERE p_kind IS NULL OR kind = p_kind ORDER BY period_from DESC LIMIT 60) x), '[]'::jsonb);
END $$;

-- Génération manuelle d'un rapport pour une période terminée (jour, semaine ISO ou mois contenant p_day)
CREATE FUNCTION fn_admin_report_make(p_actor uuid, p_kind text, p_day date) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_from date; v_to date; v_new boolean;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_kind NOT IN ('daily','weekly','monthly') OR p_day IS NULL THEN PERFORM _err('invalid_input', 'Rapport invalide'); END IF;
  IF p_kind = 'daily' THEN v_from := p_day; v_to := p_day;
  ELSIF p_kind = 'weekly' THEN v_from := date_trunc('week', p_day)::date; v_to := v_from + 6;
  ELSE v_from := date_trunc('month', p_day)::date; v_to := (v_from + interval '1 month - 1 day')::date; END IF;
  IF v_to >= current_date THEN PERFORM _err('invalid_input', 'La période n''est pas terminée'); END IF;
  v_new := _report_make(p_kind, v_from, v_to, p_actor);
  IF v_new THEN PERFORM _audit(p_actor, 'finance_report', 'company_reports', p_kind || ':' || v_from, jsonb_build_object('from', v_from, 'to', v_to)); END IF;
  RETURN v_new;
END $$;

-- ============ 5. dettes et créances ============
CREATE FUNCTION fn_admin_debts(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE v_owed jsonb; v_recv jsonb; v_owed_total bigint; v_recv_total bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  -- Ce que la plateforme doit : soldes positifs des portefeuilles (retraits déjà demandés inclus, ils sont réservés dans le solde)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('role', role, 'people', n, 'available', av, 'pending', pe) ORDER BY role), '[]'::jsonb), COALESCE(sum(av + pe), 0)
    INTO v_owed, v_owed_total FROM (
      SELECT u.role::text AS role, count(*)::int AS n,
             COALESCE(sum(b.available), 0)::bigint AS av, COALESCE(sum(b.pending), 0)::bigint AS pe
        FROM (SELECT user_id, sum(amount) FILTER (WHERE available_at <= now())::bigint AS available, sum(amount) FILTER (WHERE available_at > now())::bigint AS pending, sum(amount)::bigint AS total
                FROM wallet_entries GROUP BY user_id) b
        JOIN users u ON u.id = b.user_id
       WHERE b.total > 0 AND u.role NOT IN ('system') AND b.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
       GROUP BY u.role) x;
  -- Ce qu'on attend : argent encaissé par les livreurs et pas encore reversé, par livreur, avec l'ancienneté
  SELECT COALESCE(jsonb_agg(jsonb_build_object('courier', name, 'amount', amt, 'orders', n, 'since', since) ORDER BY amt DESC), '[]'::jsonb), COALESCE(sum(amt), 0)
    INTO v_recv, v_recv_total FROM (
      SELECT u.full_name AS name, sum(e.amount)::bigint AS amt, count(*)::int AS n, min(e.created_at) AS since
        FROM courier_cash_entries e JOIN users u ON u.id = e.courier_id
       WHERE e.count_id IS NULL AND e.remittance_id IS NULL GROUP BY u.id, u.full_name) y;
  RETURN jsonb_build_object(
    'owed', jsonb_build_object('total', v_owed_total, 'by_role', v_owed,
       'withdrawals_waiting', (SELECT jsonb_build_object('count', count(*), 'total', COALESCE(sum(amount), 0)) FROM withdrawals WHERE status = 'requested')),
    'receivable', jsonb_build_object('total', v_recv_total, 'couriers', v_recv,
       'remittances_pending', (SELECT jsonb_build_object('count', count(*), 'total', COALESCE(sum(amount), 0)) FROM remittances WHERE status = 'pending')),
    'platform_balance', (SELECT COALESCE(sum(amount), 0) FROM wallet_entries WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid));
END $$;

-- ============ 6. performances commerciales ============
-- p_scope : 'seller' (ses propres chiffres) ou 'admin' (toute la plateforme). La marge de la plateforme n'apparaît que pour l'administrateur.
CREATE FUNCTION fn_performance(p_actor uuid, p_from date, p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
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

-- ============ 7. dossiers documentaires ============
-- Les pièces (preuves, factures) sont listées avec leurs identifiants ; leur contenu reste servi par les routes existantes, avec leurs propres contrôles.
CREATE FUNCTION fn_order_dossier(p_actor uuid, p_order uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users; o orders; v_ok boolean;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Accès refusé'); END IF;
  SELECT * INTO o FROM orders WHERE id = p_order;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  v_ok := u.role = 'admin' OR o.seller_id = p_actor OR o.courier_id = p_actor
          OR (u.role = 'supplier' AND EXISTS (SELECT 1 FROM products p WHERE p.id = o.product_id AND p.supplier_id = p_actor));
  IF NOT v_ok THEN PERFORM _err('forbidden', 'Accès refusé'); END IF;
  RETURN jsonb_build_object(
    'order', jsonb_build_object('id', o.id, 'ref', o.ref, 'status', o.status, 'qty', o.qty, 'sale_total', o.sale_total, 'commune', o.commune, 'created_at', o.created_at, 'delivered_at', o.delivered_at,
                                'product', COALESCE((SELECT name FROM products WHERE id = o.product_id), o.own_product_name)),
    'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', h.at, 'from', h.from_status, 'to', h.to_status, 'note', h.note) ORDER BY h.at, h.id) FROM order_history h WHERE h.order_id = o.id), '[]'::jsonb),
    'invoices', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'kind', i.kind, 'total', i.total, 'issued_at', i.issued_at) ORDER BY i.issued_at)
                            FROM invoices i WHERE i.order_id = o.id AND (u.role = 'admin' OR i.user_id = p_actor)), '[]'::jsonb),
    'payment', CASE WHEN u.role = 'admin' OR o.courier_id = p_actor
                 THEN (SELECT jsonb_build_object('method', op.method, 'reference', op.reference, 'proof_id', op.proof_id, 'at', op.created_at) FROM order_payments op WHERE op.order_id = o.id) END,
    'cash', CASE WHEN u.role IN ('admin') OR o.courier_id = p_actor
                 THEN (SELECT jsonb_build_object('amount', e.amount, 'at', e.created_at, 'counted', e.count_id IS NOT NULL, 'remitted', e.remittance_id IS NOT NULL) FROM courier_cash_entries e WHERE e.order_id = o.id) END);
END $$;

CREATE FUNCTION fn_withdrawal_dossier(p_actor uuid, p_withdrawal uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users; w withdrawals;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Accès refusé'); END IF;
  SELECT * INTO w FROM withdrawals WHERE id = p_withdrawal;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Retrait introuvable'); END IF;
  IF NOT (u.role = 'admin' OR w.user_id = p_actor) THEN PERFORM _err('forbidden', 'Accès refusé'); END IF;
  RETURN jsonb_build_object(
    'withdrawal', jsonb_build_object('id', w.id, 'amount', w.amount, 'method', w.method, 'status', w.status, 'payment_ref', w.payment_ref, 'created_at', w.created_at, 'decided_at', w.decided_at)
                  || CASE WHEN u.role = 'admin' THEN jsonb_build_object('owner', (SELECT full_name FROM users WHERE id = w.user_id)) ELSE '{}'::jsonb END,
    'invoices', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'kind', i.kind, 'total', i.total, 'issued_at', i.issued_at)) FROM invoices i WHERE i.withdrawal_id = w.id), '[]'::jsonb),
    'proofs', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', pr.id, 'kind', pr.kind, 'at', pr.created_at)) FROM proofs pr WHERE pr.id = w.proof_id), '[]'::jsonb));
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
