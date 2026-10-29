-- 033 : factures et documents numérotés (facture de livraison, facture de services du vendeur, relevé du fournisseur, reçu de retrait).
-- Les documents sont ÉMIS À LA DEMANDE, numérotés sans trou, figés (copie des chiffres au moment de l'émission, jamais modifiables ni supprimables).
-- Tous les montants viennent de ce qui existe déjà (commandes livrées, écritures des portefeuilles, retraits payés) : AUCUN calcul d'argent nouveau,
-- AUCUN tarif, pourcentage, frais ou marge modifié, aucune écriture de portefeuille créée. Les informations légales de l'entreprise (NIF, RCCM, adresse…) sont saisies
-- par l'administrateur : rien n'est inventé, ce qui est vide n'est pas imprimé.

CREATE TABLE company_profile (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  legal_name  text CHECK (legal_name IS NULL OR length(legal_name) BETWEEN 2 AND 150),
  address     text CHECK (address IS NULL OR length(address) <= 250),
  phone       text CHECK (phone IS NULL OR length(phone) <= 40),
  email       text CHECK (email IS NULL OR length(email) <= 120),
  nif         text CHECK (nif IS NULL OR length(nif) <= 60),
  rccm        text CHECK (rccm IS NULL OR length(rccm) <= 60),
  footer_note text CHECK (footer_note IS NULL OR length(footer_note) <= 400),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO company_profile(id, legal_name) VALUES (1, 'Wallindirain');

CREATE TABLE invoice_counters (
  prefix text NOT NULL,
  year   int  NOT NULL,
  last   int  NOT NULL CHECK (last > 0),
  PRIMARY KEY (prefix, year)
);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('delivery','seller_services','supplier_statement','withdrawal_receipt')),
  user_id       uuid NOT NULL REFERENCES users(id),          -- destinataire du document (vendeur, fournisseur, ou titulaire du retrait)
  order_id      uuid REFERENCES orders(id),
  withdrawal_id uuid REFERENCES withdrawals(id),
  period_from   date,
  period_to     date,
  total         bigint NOT NULL,
  data          jsonb NOT NULL,
  issued_by     uuid NOT NULL REFERENCES users(id),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'delivery') = (order_id IS NOT NULL)),
  CHECK ((kind = 'withdrawal_receipt') = (withdrawal_id IS NOT NULL)),
  CHECK ((kind IN ('seller_services','supplier_statement')) = (period_from IS NOT NULL AND period_to IS NOT NULL AND period_from <= period_to))
);
CREATE UNIQUE INDEX invoices_order_uq ON invoices(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_withdrawal_uq ON invoices(withdrawal_id) WHERE withdrawal_id IS NOT NULL;
CREATE INDEX invoices_user_idx ON invoices(user_id, issued_at DESC);
CREATE INDEX invoices_issued_idx ON invoices(issued_at DESC);
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- Informations de l'entreprise (administrateur)
CREATE FUNCTION fn_admin_set_company(p_actor uuid, p_name text, p_address text, p_phone text, p_email text, p_nif text, p_rccm text, p_footer text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_name text := NULLIF(trim(COALESCE(p_name, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF v_name IS NULL THEN PERFORM _err('invalid_input', 'Le nom de l''entreprise est obligatoire'); END IF;
  BEGIN
    UPDATE company_profile SET legal_name = v_name, address = NULLIF(trim(COALESCE(p_address, '')), ''), phone = NULLIF(trim(COALESCE(p_phone, '')), ''),
           email = NULLIF(trim(COALESCE(p_email, '')), ''), nif = NULLIF(trim(COALESCE(p_nif, '')), ''), rccm = NULLIF(trim(COALESCE(p_rccm, '')), ''),
           footer_note = NULLIF(trim(COALESCE(p_footer, '')), ''), updated_by = p_actor, updated_at = now() WHERE id = 1;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Un des champs est trop long');
  END;
  PERFORM _audit(p_actor, 'company_profile_set', 'system', NULL, '{}'::jsonb);
END $$;

CREATE FUNCTION fn_company_get(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN (SELECT to_jsonb(c) - 'id' FROM company_profile c WHERE id = 1);
END $$;

-- ---------- Numérotation sans trou : PRÉFIXE-ANNÉE-NNNNNN (le compteur est dans la même transaction que le document) ----------
CREATE FUNCTION _invoice_number(p_kind text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_prefix text := CASE p_kind WHEN 'delivery' THEN 'FAC' WHEN 'seller_services' THEN 'FSV' WHEN 'supplier_statement' THEN 'REL' ELSE 'REC' END;
        v_year int := extract(year FROM now())::int; v_n int;
BEGIN
  INSERT INTO invoice_counters(prefix, year, last) VALUES (v_prefix, v_year, 1)
  ON CONFLICT (prefix, year) DO UPDATE SET last = invoice_counters.last + 1 RETURNING last INTO v_n;
  RETURN v_prefix || '-' || v_year || '-' || lpad(v_n::text, 6, '0');
END $$;

CREATE FUNCTION _issuer() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('name', COALESCE(legal_name, 'Wallindirain'), 'address', address, 'phone', phone, 'email', email, 'nif', nif, 'rccm', rccm, 'footer', footer_note))
    FROM company_profile WHERE id = 1
$$;

CREATE FUNCTION _invoice_store(p_kind text, p_user uuid, p_order uuid, p_withdrawal uuid, p_from date, p_to date, p_total bigint, p_data jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_no text := _invoice_number(p_kind);
BEGIN
  INSERT INTO invoices(id, number, kind, user_id, order_id, withdrawal_id, period_from, period_to, total, data, issued_by)
  VALUES (v_id, v_no, p_kind, p_user, p_order, p_withdrawal, p_from, p_to, p_total, p_data || jsonb_build_object('number', v_no, 'issuer', _issuer()), p_actor);
  PERFORM _audit(p_actor, 'invoice_issued', 'invoice', v_id::text, jsonb_build_object('number', v_no, 'kind', p_kind, 'total', p_total));
  RETURN v_id;
END $$;

-- ---------- Facture de livraison (client) : commande livrée ; le client paie le total de la commande, rien d'autre n'est montré ----------
CREATE FUNCTION fn_invoice_issue_delivery(p_actor uuid, p_order uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE a users; o orders; v_id uuid; v_name text; v_seller text; v_method text; v_goods bigint;
BEGIN
  a := _require(p_actor, ARRAY['seller','admin']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order;
  IF NOT FOUND OR (a.role = 'seller' AND o.seller_id <> a.id) THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status <> 'delivered' THEN PERFORM _err('invalid_state', 'La facture est possible une fois la commande livrée'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('invoice:order:' || o.id::text));
  SELECT id INTO v_id FROM invoices WHERE order_id = o.id;
  IF FOUND THEN RETURN v_id; END IF;
  v_goods := o.sale_total - o.delivery_fee;
  IF v_goods < 0 THEN PERFORM _err('ledger_mismatch', 'Montants incohérents : facture impossible'); END IF;
  SELECT COALESCE(p.name, o.own_product_name) INTO v_name FROM (SELECT 1) x LEFT JOIN products p ON p.id = o.product_id;
  SELECT full_name INTO v_seller FROM users WHERE id = o.seller_id;
  SELECT CASE method WHEN 'cash' THEN 'Espèces à la livraison' WHEN 'orange_money' THEN 'Orange Money' ELSE 'MTN MoMo' END INTO v_method FROM order_payments WHERE order_id = o.id;
  RETURN _invoice_store('delivery', o.seller_id, o.id, NULL, NULL, NULL, o.sale_total, jsonb_build_object(
    'title', 'Facture de livraison', 'date', o.delivered_at::date,
    'recipient', jsonb_build_object('name', o.customer_name, 'phone', o.customer_phone, 'address', o.commune || ' · ' || o.address),
    'seller', v_seller, 'order_ref', o.ref,
    'lines', jsonb_build_array(
      jsonb_build_object('label', v_name, 'qty', o.qty, 'amount', v_goods),
      jsonb_build_object('label', 'Frais de livraison · ' || o.commune, 'qty', 1, 'amount', o.delivery_fee)),
    'payment', COALESCE(v_method, 'à la livraison'), 'paid_on', o.delivered_at::date), p_actor);
END $$;

-- ---------- Relevé de période : facture de services du vendeur, ou relevé du fournisseur (selon le titulaire) ----------
CREATE FUNCTION fn_invoice_issue_statement(p_actor uuid, p_user uuid, p_from date, p_to date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE a users; t users; v_kind text; v_lines jsonb; v_total bigint; v_id uuid; v_title text;
BEGIN
  a := _require(p_actor, ARRAY['seller','supplier','admin']::user_role[]);
  IF a.role <> 'admin' THEN
    IF p_user IS NOT NULL AND p_user <> a.id THEN PERFORM _err('forbidden', 'Action non autorisée pour votre rôle'); END IF;
    p_user := a.id;
  END IF;
  SELECT * INTO t FROM users WHERE id = p_user AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Compte introuvable'); END IF;
  IF t.role NOT IN ('seller','supplier') THEN PERFORM _err('invalid_input', 'Relevé réservé aux vendeurs et aux fournisseurs'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN PERFORM _err('invalid_input', 'Période invalide'); END IF;
  IF p_to >= current_date THEN PERFORM _err('invalid_state', 'La période doit être terminée : choisissez une date de fin jusqu''à hier'); END IF;
  IF p_to - p_from > 92 THEN PERFORM _err('invalid_input', 'Période de 93 jours au plus'); END IF;
  v_kind := CASE t.role WHEN 'seller' THEN 'seller_services' ELSE 'supplier_statement' END;
  PERFORM pg_advisory_xact_lock(hashtext('invoice:user:' || t.id::text));
  SELECT id INTO v_id FROM invoices WHERE kind = v_kind AND user_id = t.id AND period_from = p_from AND period_to = p_to;
  IF FOUND THEN RETURN v_id; END IF;
  IF EXISTS (SELECT 1 FROM invoices WHERE kind = v_kind AND user_id = t.id AND period_from <= p_to AND period_to >= p_from) THEN
    PERFORM _err('invalid_state', 'Un document existe déjà pour une partie de cette période : choisissez une période qui ne le chevauche pas');
  END IF;
  IF v_kind = 'seller_services' THEN
    v_title := 'Facture de services';
    SELECT jsonb_agg(l ORDER BY l->>'date', l->>'ref'), COALESCE(sum((l->>'amount')::bigint), 0) INTO v_lines, v_total FROM (
      SELECT jsonb_build_object('ref', o.ref, 'date', o.delivered_at::date, 'label', 'Livraison de ' || COALESCE(p.name, o.own_product_name) || ' × ' || o.qty,
               'parts', jsonb_build_array(jsonb_build_object('k', 'Livraison', 'v', o.delivery_fee), jsonb_build_object('k', 'Call center', 'v', o.call_fee), jsonb_build_object('k', 'Plateforme', 'v', o.platform_fee)),
               'amount', o.delivery_fee + o.call_fee + o.platform_fee) AS l
        FROM orders o LEFT JOIN products p ON p.id = o.product_id
       WHERE o.seller_id = t.id AND o.status = 'delivered' AND o.delivered_at::date BETWEEN p_from AND p_to
      UNION ALL
      SELECT jsonb_build_object('ref', COALESCE(o.ref, ''), 'date', w.created_at::date, 'label', CASE w.kind WHEN 'return_fees' THEN 'Frais de retour' ELSE 'Abonnement' END, 'parts', '[]'::jsonb, 'amount', -w.amount)
        FROM wallet_entries w LEFT JOIN orders o ON o.id = w.order_id
       WHERE w.user_id = t.id AND w.kind IN ('return_fees','subscription') AND w.amount < 0 AND w.created_at::date BETWEEN p_from AND p_to
    ) s;
  ELSE
    v_title := 'Relevé du fournisseur';
    SELECT jsonb_agg(l ORDER BY l->>'date', l->>'ref'), COALESCE(sum((l->>'amount')::bigint), 0) INTO v_lines, v_total FROM (
      SELECT jsonb_build_object('ref', COALESCE(o.ref, ''), 'date', w.created_at::date,
               'label', CASE w.kind WHEN 'supplier_payment' THEN 'Vente de ' WHEN 'return_fee_supplier' THEN 'Frais de retour (défectueux) : ' ELSE 'Compensation transport : ' END || COALESCE(p.name, '') || CASE WHEN o.id IS NOT NULL THEN ' × ' || o.qty ELSE '' END,
               'parts', '[]'::jsonb, 'amount', w.amount) AS l
        FROM wallet_entries w LEFT JOIN orders o ON o.id = w.order_id LEFT JOIN products p ON p.id = o.product_id
       WHERE w.user_id = t.id AND w.kind IN ('supplier_payment','return_fee_supplier','transport_loss') AND w.created_at::date BETWEEN p_from AND p_to
    ) s;
  END IF;
  IF v_lines IS NULL THEN PERFORM _err('invalid_state', 'Aucune activité sur cette période'); END IF;
  RETURN _invoice_store(v_kind, t.id, NULL, NULL, p_from, p_to, v_total, jsonb_build_object(
    'title', v_title, 'date', current_date, 'recipient', jsonb_build_object('name', t.full_name, 'phone', t.phone),
    'period', jsonb_build_object('from', p_from, 'to', p_to), 'lines', v_lines,
    'note', CASE v_kind WHEN 'seller_services' THEN 'Frais de service facturés pour les commandes livrées sur la période (livraison, centre d''appel, plateforme), frais de retour et abonnements.'
                         ELSE 'Sommes créditées ou débitées sur votre portefeuille fournisseur sur la période (ventes, frais de retour de produits défectueux, compensations de transport).' END), p_actor);
END $$;

-- ---------- Reçu de retrait : retrait payé ----------
CREATE FUNCTION fn_invoice_issue_withdrawal(p_actor uuid, p_withdrawal uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE a users; wd withdrawals; t users; v_id uuid; v_label text;
BEGIN
  a := _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier','admin']::user_role[]);
  SELECT * INTO wd FROM withdrawals WHERE id = p_withdrawal;
  IF NOT FOUND OR (a.role <> 'admin' AND wd.user_id <> a.id) THEN PERFORM _err('not_found', 'Retrait introuvable'); END IF;
  IF wd.status <> 'paid' THEN PERFORM _err('invalid_state', 'Le reçu est disponible une fois le retrait payé'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('invoice:wd:' || wd.id::text));
  SELECT id INTO v_id FROM invoices WHERE withdrawal_id = wd.id;
  IF FOUND THEN RETURN v_id; END IF;
  SELECT * INTO t FROM users WHERE id = wd.user_id;
  v_label := CASE wd.method WHEN 'orange_money' THEN 'Orange Money' ELSE 'MTN MoMo' END;
  RETURN _invoice_store('withdrawal_receipt', wd.user_id, NULL, wd.id, NULL, NULL, wd.amount, jsonb_build_object(
    'title', 'Reçu de retrait', 'date', wd.decided_at::date, 'recipient', jsonb_build_object('name', t.full_name, 'phone', t.phone),
    'lines', jsonb_build_array(jsonb_build_object('label', 'Retrait vers ' || v_label || ' (numéro ' || left(wd.account_number, 3) || '••••' || right(wd.account_number, 2) || ')', 'qty', 1, 'amount', wd.amount, 'ref', COALESCE(wd.payment_ref, ''))),
    'payment', v_label, 'paid_on', wd.decided_at::date, 'requested_on', wd.created_at::date, 'payment_ref', wd.payment_ref), p_actor);
END $$;

-- ---------- Lecture ----------
CREATE FUNCTION fn_invoice_get(p_actor uuid, p_invoice uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a users; i invoices;
BEGIN
  a := _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier','admin']::user_role[]);
  SELECT * INTO i FROM invoices WHERE id = p_invoice;
  IF NOT FOUND OR (a.role <> 'admin' AND i.user_id <> a.id) THEN PERFORM _err('not_found', 'Document introuvable'); END IF;
  RETURN jsonb_build_object('id', i.id, 'number', i.number, 'kind', i.kind, 'issued_at', i.issued_at, 'total', i.total, 'period_from', i.period_from, 'period_to', i.period_to, 'data', i.data);
END $$;

CREATE FUNCTION fn_invoice_list(p_actor uuid, p_kind text DEFAULT NULL, p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_search text DEFAULT NULL, p_limit int DEFAULT 100)
RETURNS TABLE(id uuid, number text, kind text, total bigint, issued_at timestamptz, period_from date, period_to date, user_name text, user_role user_role, order_ref text) LANGUAGE plpgsql AS $$
DECLARE a users;
BEGIN
  a := _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier','admin']::user_role[]);
  RETURN QUERY SELECT i.id, i.number, i.kind, i.total, i.issued_at, i.period_from, i.period_to, u.full_name, u.role, o.ref
    FROM invoices i JOIN users u ON u.id = i.user_id LEFT JOIN orders o ON o.id = i.order_id
   WHERE (a.role = 'admin' OR i.user_id = a.id) AND (p_kind IS NULL OR i.kind = p_kind)
     AND (p_from IS NULL OR i.issued_at::date >= p_from) AND (p_to IS NULL OR i.issued_at::date <= p_to)
     AND (p_search IS NULL OR i.number ILIKE '%' || p_search || '%' OR u.full_name ILIKE '%' || p_search || '%' OR o.ref ILIKE '%' || p_search || '%')
   ORDER BY i.issued_at DESC, i.number DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END $$;

-- ---------- Vue d'ensemble pour la finance (administrateur) : uniquement des totaux lus dans les commandes, les portefeuilles, les retraits et les documents ----------
CREATE FUNCTION fn_admin_finance_summary(p_actor uuid, p_from date, p_to date) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN PERFORM _err('invalid_input', 'Période invalide'); END IF;
  IF p_to - p_from > 366 THEN PERFORM _err('invalid_input', 'Période d''un an au plus'); END IF;
  SELECT jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'deliveries', (SELECT jsonb_build_object('count', count(*), 'sale_total', COALESCE(sum(sale_total), 0), 'delivery_fees', COALESCE(sum(delivery_fee), 0), 'call_fees', COALESCE(sum(call_fee), 0),
                      'platform_fees', COALESCE(sum(platform_fee), 0), 'margin', COALESCE(sum(margin_unit * qty), 0)) FROM orders WHERE status = 'delivered' AND delivered_at::date BETWEEN p_from AND p_to),
    'returns', (SELECT count(*) FROM orders WHERE status = 'returned' AND closed_at::date BETWEEN p_from AND p_to),
    'ledger', (SELECT jsonb_build_object(
        'seller_gain', COALESCE(sum(amount) FILTER (WHERE kind = 'seller_gain'), 0),
        'supplier_payment', COALESCE(sum(amount) FILTER (WHERE kind = 'supplier_payment'), 0),
        'platform_revenue', COALESCE(sum(amount) FILTER (WHERE kind = 'platform_revenue'), 0),
        'subscriptions', COALESCE(sum(amount) FILTER (WHERE kind = 'subscription' AND amount > 0), 0),
        'team_pay', COALESCE(sum(amount) FILTER (WHERE kind = 'team_pay' AND amount > 0), 0))
      FROM wallet_entries WHERE created_at::date BETWEEN p_from AND p_to),
    'withdrawals_paid', (SELECT jsonb_build_object('count', count(*), 'total', COALESCE(sum(amount), 0)) FROM withdrawals WHERE status = 'paid' AND decided_at::date BETWEEN p_from AND p_to),
    'withdrawals_waiting', (SELECT jsonb_build_object('count', count(*), 'total', COALESCE(sum(amount), 0)) FROM withdrawals WHERE status = 'requested'),
    'invoices', COALESCE((SELECT jsonb_object_agg(kind, jsonb_build_object('count', c, 'total', t)) FROM (SELECT kind, count(*) AS c, sum(total) AS t FROM invoices WHERE issued_at::date BETWEEN p_from AND p_to GROUP BY kind) x), '{}'::jsonb)
  ) INTO r;
  RETURN r;
END $$;

-- Remise à zéro de l'activité (outil de nettoyage avant lancement, confirmation écrite et mot de passe exigés) : vide aussi les documents et leur compteur
CREATE OR REPLACE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 invoices, invoice_counters, stock_counts, order_handovers, return_notes, return_photos, stock_losses, order_history, calls, risky_customers, sheet_imports, order_requests, mission_offers, tour_stops, tours, orders, arrivals, seller_stock, messages, one_time_codes, proofs
    RESTART IDENTITY;
  UPDATE products SET stock_qty = 0, reserved_qty = 0;
  PERFORM _audit(p_actor, 'activity_reset', 'system', NULL, jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries));
  RETURN jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries);
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
