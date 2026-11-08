-- 049 : « Plan financier » de Mes finances, pour tous les rôles : budgets par catégorie, objectif du mois, dépenses et revenus récurrents, prévision.
-- Réservé à la formule Pro (la formule gratuite garde ses données en lecture seule si elle en avait). Rien n'est débité ni créé automatiquement :
-- les récurrents sont des repères pour la prévision et les rappels ; la personne note elle-même la transaction réelle.
-- Aucune table ni fonction existante modifiée. Aucun montant de la plateforme touché.

CREATE TABLE pf_budgets (
  owner_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL CHECK (category IN ('food','transport','housing','telecom','health','family','business','shopping','savings','other_out')),
  amount   bigint NOT NULL CHECK (amount BETWEEN 1 AND 100000000000),
  PRIMARY KEY (owner_id, category)
);
CREATE TABLE pf_goals (
  owner_id uuid NOT NULL REFERENCES users(id),
  month    date NOT NULL CHECK (month = date_trunc('month', month)::date),
  target   bigint NOT NULL CHECK (target BETWEEN 1 AND 100000000000),
  PRIMARY KEY (owner_id, month)
);
CREATE TABLE pf_recurring (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  label      text NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 40),
  kind       text NOT NULL CHECK (kind IN ('income','expense')),
  category   text NOT NULL,
  amount     bigint NOT NULL CHECK (amount BETWEEN 1 AND 100000000000),
  frequency  text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  anchor_on  date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  CHECK (frequency <> 'monthly' OR extract(day FROM anchor_on) <= 28)
);
CREATE INDEX pf_recurring_owner_idx ON pf_recurring(owner_id) WHERE stopped_at IS NULL;

-- Les fonctions du Plan financier demandent la formule Pro
CREATE FUNCTION _pf_pro(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF _pf_tier(p_actor) <> 'pro' THEN PERFORM _err('pro_required', 'Le Plan financier fait partie de la formule Pro'); END IF;
END $$;

-- Budget mensuel d'une catégorie de dépense ; p_amount vide = retirer le budget
CREATE FUNCTION fn_pf_budget_set(p_actor uuid, p_category text, p_amount bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  IF p_category NOT IN ('food','transport','housing','telecom','health','family','business','shopping','savings','other_out') THEN PERFORM _err('invalid_input', 'Catégorie invalide'); END IF;
  IF p_amount IS NULL THEN DELETE FROM pf_budgets WHERE owner_id = p_actor AND category = p_category; RETURN; END IF;
  IF p_amount < 1 OR p_amount > 100000000000 THEN PERFORM _err('invalid_input', 'Montant invalide'); END IF;
  INSERT INTO pf_budgets(owner_id, category, amount) VALUES (p_actor, p_category, p_amount) ON CONFLICT (owner_id, category) DO UPDATE SET amount = EXCLUDED.amount;
END $$;

-- Objectif du mois en cours : combien on veut mettre de côté (revenus moins dépenses) ; p_target vide = retirer
CREATE FUNCTION fn_pf_goal_set(p_actor uuid, p_target bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_month date := date_trunc('month', current_date)::date;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  IF p_target IS NULL THEN DELETE FROM pf_goals WHERE owner_id = p_actor AND month = v_month; RETURN; END IF;
  IF p_target < 1 OR p_target > 100000000000 THEN PERFORM _err('invalid_input', 'Objectif invalide'); END IF;
  INSERT INTO pf_goals(owner_id, month, target) VALUES (p_actor, v_month, p_target) ON CONFLICT (owner_id, month) DO UPDATE SET target = EXCLUDED.target;
END $$;

-- Créer (p_id vide) ou modifier un revenu / une dépense récurrente
CREATE FUNCTION fn_pf_recurring_save(p_actor uuid, p_id uuid, p_label text, p_kind text, p_category text, p_amount bigint, p_frequency text, p_anchor date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := p_id; v_label text := trim(COALESCE(p_label, ''));
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pfrec:' || p_actor::text));
  IF length(v_label) < 2 OR length(v_label) > 40 THEN PERFORM _err('invalid_input', 'Nom invalide (2 à 40 caractères)'); END IF;
  IF p_kind NOT IN ('income','expense') THEN PERFORM _err('invalid_input', 'Type invalide'); END IF;
  IF p_kind = 'income' AND p_category NOT IN ('sales','salary','gift','other_in') THEN PERFORM _err('invalid_input', 'Catégorie de revenu invalide'); END IF;
  IF p_kind = 'expense' AND p_category NOT IN ('food','transport','housing','telecom','health','family','business','shopping','savings','other_out') THEN PERFORM _err('invalid_input', 'Catégorie de dépense invalide'); END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 100000000000 THEN PERFORM _err('invalid_input', 'Montant invalide'); END IF;
  IF p_frequency NOT IN ('daily','weekly','monthly') THEN PERFORM _err('invalid_input', 'Fréquence invalide'); END IF;
  IF p_anchor IS NULL OR p_anchor < current_date - 3650 OR p_anchor > current_date + 3650 THEN PERFORM _err('invalid_input', 'Date invalide'); END IF;
  IF p_frequency = 'monthly' AND extract(day FROM p_anchor) > 28 THEN PERFORM _err('invalid_input', 'Pour un paiement mensuel, choisissez un jour entre 1 et 28'); END IF;
  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM pf_recurring WHERE owner_id = p_actor AND stopped_at IS NULL) >= 30 THEN PERFORM _err('limit', '30 récurrents au plus'); END IF;
    INSERT INTO pf_recurring(owner_id, label, kind, category, amount, frequency, anchor_on) VALUES (p_actor, v_label, p_kind, p_category, p_amount, p_frequency, p_anchor) RETURNING id INTO v_id;
  ELSE
    UPDATE pf_recurring SET label = v_label, kind = p_kind, category = p_category, amount = p_amount, frequency = p_frequency, anchor_on = p_anchor WHERE id = p_id AND owner_id = p_actor AND stopped_at IS NULL;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Récurrent introuvable'); END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_pf_recurring_stop(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  UPDATE pf_recurring SET stopped_at = now() WHERE id = p_id AND owner_id = p_actor AND stopped_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Récurrent introuvable'); END IF;
END $$;

-- Un compte anonymisé perd aussi son plan financier
CREATE FUNCTION trg_pf_plan_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pf_budgets WHERE owner_id = NEW.id;
  DELETE FROM pf_goals WHERE owner_id = NEW.id;
  DELETE FROM pf_recurring WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_pf_plan_anonymized() SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER users_pf_plan_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_plan_anonymized();

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
