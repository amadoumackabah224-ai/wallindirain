-- 060 : Mes finances pour l'administrateur (toujours Pro, sans abonnement) et Paie des employés.
-- Paie : liste d'employés avec leur salaire mensuel ; « Payer » crée la dépense (catégorie « Employés ») sur un compte GNF et
-- note le paiement du mois, pour voir d'un coup d'œil qui est payé. Un employé peut être relié à un membre de l'équipe Wallindirain.

-- 1) L'administrateur est toujours en formule Pro.
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('_pf_tier(uuid)'::regprocedure) INTO d;
  IF position('SELECT CASE WHEN _setting(''pf_price_monthly'') = 0' in d) = 0 THEN RAISE EXCEPTION '_pf_tier : repère introuvable'; END IF;
  EXECUTE replace(d, 'SELECT CASE WHEN _setting(''pf_price_monthly'') = 0', 'SELECT CASE WHEN _setting(''pf_price_monthly'') = 0 OR EXISTS (SELECT 1 FROM users u WHERE u.id = p_owner AND u.role = ''admin'')');
END $$;

-- 2) Paie
CREATE TABLE pf_payroll (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users(id),
  name           text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  job            text CHECK (job IS NULL OR length(job) <= 60),
  monthly_amount bigint NOT NULL CHECK (monthly_amount > 0 AND monthly_amount <= 100000000000),
  user_id        uuid REFERENCES users(id),
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pf_payroll_owner ON pf_payroll(owner_id, created_at);
CREATE TABLE pf_payroll_pay (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  payroll_id uuid NOT NULL REFERENCES pf_payroll(id),
  month      date NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount     bigint NOT NULL CHECK (amount > 0),
  tx_id      uuid NOT NULL REFERENCES pf_transactions(id),
  paid_on    date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_id, month)
);

CREATE FUNCTION fn_pf_payroll_save(p_actor uuid, p_id uuid, p_name text, p_job text, p_amount bigint, p_user uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pfpay:' || p_actor::text));
  IF length(trim(COALESCE(p_name, ''))) < 2 THEN PERFORM _err('invalid_input', 'Nom trop court'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN PERFORM _err('invalid_input', 'Salaire invalide'); END IF;
  IF p_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND deleted_at IS NULL AND role IN ('agent','call_chief','courier','warehouse','admin')) THEN PERFORM _err('not_found', 'Membre de l''équipe introuvable'); END IF;
  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM pf_payroll WHERE owner_id = p_actor AND archived_at IS NULL) >= 100 THEN PERFORM _err('limit', '100 employés au plus'); END IF;
    INSERT INTO pf_payroll(owner_id, name, job, monthly_amount, user_id) VALUES (p_actor, trim(p_name), NULLIF(trim(COALESCE(p_job, '')), ''), p_amount, p_user) RETURNING id INTO v_id;
  ELSE
    UPDATE pf_payroll SET name = trim(p_name), job = NULLIF(trim(COALESCE(p_job, '')), ''), monthly_amount = p_amount, user_id = p_user WHERE id = p_id AND owner_id = p_actor RETURNING id INTO v_id;
    IF v_id IS NULL THEN PERFORM _err('not_found', 'Employé introuvable'); END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_pf_payroll_archive(p_actor uuid, p_id uuid, p_archived boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  UPDATE pf_payroll SET archived_at = CASE WHEN p_archived THEN now() ELSE NULL END WHERE id = p_id AND owner_id = p_actor;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Employé introuvable'); END IF;
END $$;

-- Payer le salaire d'un mois : dépense « Employés » sur un compte GNF + trace du paiement (un seul paiement par employé et par mois).
CREATE FUNCTION fn_pf_payroll_pay(p_actor uuid, p_id uuid, p_month date, p_account uuid, p_amount bigint, p_day date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE e pf_payroll; v_month date := date_trunc('month', p_month)::date; v_amt bigint; v_tx uuid;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pfpay:' || p_actor::text));
  SELECT * INTO e FROM pf_payroll WHERE id = p_id AND owner_id = p_actor;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Employé introuvable'); END IF;
  IF e.archived_at IS NOT NULL THEN PERFORM _err('invalid_state', 'Employé archivé'); END IF;
  IF EXISTS (SELECT 1 FROM pf_payroll_pay WHERE payroll_id = p_id AND month = v_month) THEN PERFORM _err('duplicate', 'Ce mois est déjà payé'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pf_accounts WHERE id = p_account AND owner_id = p_actor AND currency = 'GNF') THEN PERFORM _err('invalid_input', 'Choisissez un compte en GNF'); END IF;
  v_amt := COALESCE(p_amount, e.monthly_amount);
  v_tx := fn_pf_tx_add(p_actor, p_account, 'expense', v_amt, 'employees', 'Salaire ' || to_char(v_month, 'MM/YYYY') || ' : ' || e.name, p_day);
  INSERT INTO pf_payroll_pay(owner_id, payroll_id, month, amount, tx_id, paid_on) VALUES (p_actor, p_id, v_month, v_amt, v_tx, p_day);
  RETURN v_tx;
END $$;

-- Annuler un paiement (erreur de saisie) : la dépense est annulée, le mois redevient « à payer ».
CREATE FUNCTION fn_pf_payroll_unpay(p_actor uuid, p_id uuid, p_month date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r pf_payroll_pay;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  SELECT * INTO r FROM pf_payroll_pay WHERE payroll_id = p_id AND owner_id = p_actor AND month = date_trunc('month', p_month)::date FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Paiement introuvable'); END IF;
  PERFORM fn_pf_tx_void(p_actor, r.tx_id);
  DELETE FROM pf_payroll_pay WHERE id = r.id;
END $$;

-- Effacement des données Mes finances (058) et anonymisation : y ajouter la paie.
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('fn_pf_erase(uuid,text)'::regprocedure) INTO d;
  IF position('DELETE FROM pf_transactions WHERE owner_id = p_actor;' in d) = 0 THEN RAISE EXCEPTION 'fn_pf_erase : repère introuvable'; END IF;
  EXECUTE replace(d, 'DELETE FROM pf_transactions WHERE owner_id = p_actor;', 'DELETE FROM pf_payroll_pay WHERE owner_id = p_actor;' || E'\n  ' || 'DELETE FROM pf_transactions WHERE owner_id = p_actor;');
  SELECT pg_get_functiondef('fn_pf_erase(uuid,text)'::regprocedure) INTO d;
  EXECUTE replace(d, 'DELETE FROM pf_accounts WHERE owner_id = p_actor;', 'DELETE FROM pf_payroll WHERE owner_id = p_actor;' || E'\n  ' || 'DELETE FROM pf_accounts WHERE owner_id = p_actor;');
END $$;
CREATE FUNCTION trg_pf_payroll_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pf_payroll_pay WHERE owner_id = NEW.id;
  UPDATE pf_payroll SET user_id = NULL WHERE user_id = NEW.id;
  DELETE FROM pf_payroll WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER users_pf_payroll_anonymized BEFORE UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_payroll_anonymized();

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
