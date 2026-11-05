-- 045 : « Tableau argent » du vendeur (module Finances) : dépenses récurrentes, budget par catégorie, objectif du mois, réglage de la prévision.
-- Lecture seule sur l'argent de la plateforme : aucun portefeuille, frais, marge, tarif ni écriture n'est touché. Aucune table existante n'est modifiée.
-- Chaque ligne a un propriétaire (owner_id) : aujourd'hui le compte du vendeur, demain une organisation (voir la feuille de route SaaS).
-- Éteint par défaut (réglage feature_finances = 0) : l'administrateur l'allume dans « Réglages ».

INSERT INTO settings(key, value, label) VALUES
  ('feature_finances', 0, 'Tableau argent du vendeur : prévision, dépenses récurrentes, budget, objectif (0 = éteint, 1 = allumé)');

-- Dépenses qui reviennent (pub, loyer, internet…). Rien n'est débité : ce sont des repères pour la prévision et les rappels.
CREATE TABLE finance_recurring (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  label      text NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 40),
  category   text NOT NULL CHECK (category IN ('ads','goods','transport','other')),
  amount     bigint NOT NULL CHECK (amount BETWEEN 1 AND 100000000000),
  frequency  text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  anchor_on  date NOT NULL,                       -- 1re échéance : le jour de la semaine (hebdo) ou du mois (mensuel, 1 à 28) en découle
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  CHECK (frequency <> 'monthly' OR extract(day FROM anchor_on) <= 28)
);
CREATE INDEX finance_recurring_owner_idx ON finance_recurring(owner_id) WHERE stopped_at IS NULL;

-- Budget mensuel par catégorie de dépense (mêmes catégories que « Mon bénéfice »)
CREATE TABLE finance_budgets (
  owner_id   uuid NOT NULL REFERENCES users(id),
  category   text NOT NULL CHECK (category IN ('ads','goods','transport','other')),
  amount     bigint NOT NULL CHECK (amount BETWEEN 1 AND 100000000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, category)
);

-- Objectif de gains du mois (premier jour du mois)
CREATE TABLE finance_goals (
  owner_id   uuid NOT NULL REFERENCES users(id),
  month      date NOT NULL CHECK (extract(day FROM month) = 1),
  target     bigint NOT NULL CHECK (target BETWEEN 1 AND 100000000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, month)
);

-- Réglage de la prévision : taux de livraison que le vendeur veut utiliser (vide = son taux réel)
CREATE TABLE finance_prefs (
  owner_id      uuid PRIMARY KEY REFERENCES users(id),
  delivery_rate int CHECK (delivery_rate IS NULL OR delivery_rate BETWEEN 5 AND 100),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION _finance_feature_on() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF _setting('feature_finances') < 1 THEN PERFORM _err('feature_off', 'Le tableau argent n''est pas encore activé'); END IF;
END $$;

-- Créer (p_id vide) ou modifier une dépense récurrente. 30 actives au plus.
CREATE FUNCTION fn_seller_finance_recurring_save(p_actor uuid, p_id uuid, p_label text, p_category text, p_amount bigint, p_frequency text, p_anchor date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := p_id; v_label text := trim(COALESCE(p_label, ''));
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _finance_feature_on();
  IF length(v_label) < 2 OR length(v_label) > 40 THEN PERFORM _err('invalid_input', 'Nom invalide (2 à 40 caractères)'); END IF;
  IF p_category IS NULL OR p_category NOT IN ('ads','goods','transport','other') THEN PERFORM _err('invalid_input', 'Catégorie invalide'); END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 100000000000 THEN PERFORM _err('invalid_input', 'Montant invalide'); END IF;
  IF p_frequency IS NULL OR p_frequency NOT IN ('daily','weekly','monthly') THEN PERFORM _err('invalid_input', 'Fréquence invalide'); END IF;
  IF p_anchor IS NULL OR p_anchor < current_date - 400 OR p_anchor > current_date + 400 THEN PERFORM _err('invalid_input', 'Date invalide'); END IF;
  IF p_frequency = 'monthly' AND extract(day FROM p_anchor) > 28 THEN PERFORM _err('invalid_input', 'Pour un paiement mensuel, choisissez un jour entre le 1 et le 28'); END IF;
  IF v_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('finance:' || p_actor::text, 0));
    IF (SELECT count(*) FROM finance_recurring WHERE owner_id = p_actor AND stopped_at IS NULL) >= 30 THEN PERFORM _err('invalid_input', 'Maximum 30 dépenses récurrentes'); END IF;
    INSERT INTO finance_recurring(owner_id, label, category, amount, frequency, anchor_on) VALUES (p_actor, v_label, p_category, p_amount, p_frequency, p_anchor) RETURNING id INTO v_id;
  ELSE
    UPDATE finance_recurring SET label = v_label, category = p_category, amount = p_amount, frequency = p_frequency, anchor_on = p_anchor
      WHERE id = v_id AND owner_id = p_actor AND stopped_at IS NULL;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Dépense récurrente introuvable'); END IF;
  END IF;
  PERFORM _audit(p_actor, 'finance_recurring_saved', 'finance_recurring', v_id::text, jsonb_build_object('amount', p_amount, 'frequency', p_frequency));
  RETURN v_id;
END $$;

-- Arrêter une dépense récurrente (elle reste dans la base, mais n'entre plus dans la prévision)
CREATE FUNCTION fn_seller_finance_recurring_stop(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _finance_feature_on();
  UPDATE finance_recurring SET stopped_at = now() WHERE id = p_id AND owner_id = p_actor AND stopped_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Dépense récurrente introuvable'); END IF;
  PERFORM _audit(p_actor, 'finance_recurring_stopped', 'finance_recurring', p_id::text);
END $$;

-- Budget mensuel d'une catégorie ; montant vide = retirer le budget
CREATE FUNCTION fn_seller_finance_budget_set(p_actor uuid, p_category text, p_amount bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _finance_feature_on();
  IF p_category IS NULL OR p_category NOT IN ('ads','goods','transport','other') THEN PERFORM _err('invalid_input', 'Catégorie invalide'); END IF;
  IF p_amount IS NULL THEN
    DELETE FROM finance_budgets WHERE owner_id = p_actor AND category = p_category;
  ELSE
    IF p_amount < 1 OR p_amount > 100000000000 THEN PERFORM _err('invalid_input', 'Montant invalide'); END IF;
    INSERT INTO finance_budgets(owner_id, category, amount) VALUES (p_actor, p_category, p_amount)
      ON CONFLICT (owner_id, category) DO UPDATE SET amount = EXCLUDED.amount, updated_at = now();
  END IF;
  PERFORM _audit(p_actor, 'finance_budget_set', 'finance_budget', p_category, jsonb_build_object('amount', p_amount));
END $$;

-- Objectif de gains du mois en cours ; montant vide = retirer l'objectif
CREATE FUNCTION fn_seller_finance_goal_set(p_actor uuid, p_target bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_month date := date_trunc('month', current_date)::date;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _finance_feature_on();
  IF p_target IS NULL THEN
    DELETE FROM finance_goals WHERE owner_id = p_actor AND month = v_month;
  ELSE
    IF p_target < 1 OR p_target > 100000000000 THEN PERFORM _err('invalid_input', 'Objectif invalide'); END IF;
    INSERT INTO finance_goals(owner_id, month, target) VALUES (p_actor, v_month, p_target)
      ON CONFLICT (owner_id, month) DO UPDATE SET target = EXCLUDED.target, updated_at = now();
  END IF;
  PERFORM _audit(p_actor, 'finance_goal_set', 'finance_goal', v_month::text, jsonb_build_object('target', p_target));
END $$;

-- Taux de livraison utilisé pour la prévision (5 à 100 %) ; vide = utiliser le taux réel
CREATE FUNCTION fn_seller_finance_rate_set(p_actor uuid, p_rate int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _finance_feature_on();
  IF p_rate IS NOT NULL AND (p_rate < 5 OR p_rate > 100) THEN PERFORM _err('invalid_input', 'Le taux doit être entre 5 et 100 %'); END IF;
  INSERT INTO finance_prefs(owner_id, delivery_rate) VALUES (p_actor, p_rate)
    ON CONFLICT (owner_id) DO UPDATE SET delivery_rate = EXCLUDED.delivery_rate, updated_at = now();
END $$;

-- Un compte anonymisé perd ses données de finances
CREATE FUNCTION trg_finances_user_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM finance_recurring WHERE owner_id = NEW.id;
  DELETE FROM finance_budgets WHERE owner_id = NEW.id;
  DELETE FROM finance_goals WHERE owner_id = NEW.id;
  DELETE FROM finance_prefs WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_finances_user_anonymized() SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER users_finances_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_finances_user_anonymized();

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
