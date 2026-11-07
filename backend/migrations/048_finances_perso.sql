-- 048 : « Mes finances » : gestion financière personnelle pour tous les rôles (comptes, transactions), gratuite et payante.
-- Principe : ce sont les NOTES PERSONNELLES de la personne (Orange Money, espèces, épargne…), pas de l'argent détenu par Wallindirain.
-- Aucun portefeuille, frais, marge ni tarif de la plateforme n'est touché, sauf le paiement de l'abonnement (même mécanisme que l'abonnement vendeur).
-- Le compte « Wallindirain » affiché dans l'écran vient du portefeuille réel, en lecture seule : on ne peut rien y saisir (pas de double comptage).
-- Chaque ligne porte un propriétaire (owner_id) : aujourd'hui la personne, demain une organisation.
-- Éteint par défaut (feature_finances_perso = 0). Tant qu'aucun prix n'est fixé (pf_price_monthly = 0), tout le monde a toutes les fonctions.
-- Un abonnement qui se termine ne supprime rien : la personne repasse au gratuit (anciens comptes lisibles, nouvelles limites).

INSERT INTO settings(key, value, label) VALUES
  ('feature_finances_perso', 0,   'Mes finances (comptes personnels, transactions) pour tous les rôles (0 = éteint, 1 = allumé)'),
  ('pf_price_monthly',       0,   'Mes finances : prix de la formule Pro par mois, en GNF (0 = pas encore de prix : tout le monde a tout)'),
  ('pf_price_yearly',        0,   'Mes finances : prix de la formule Pro par an, en GNF (0 = formule annuelle non proposée)'),
  ('pf_trial_days',          14,  'Mes finances : jours d''essai Pro offerts à la première utilisation'),
  ('pf_free_accounts',       2,   'Mes finances : nombre de comptes personnels de la formule gratuite'),
  ('pf_free_history_days',   90,  'Mes finances : jours d''historique visibles en formule gratuite');

CREATE TABLE pf_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id),
  name            text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 40),
  kind            text NOT NULL CHECK (kind IN ('cash','mobile_money','bank','savings','other')),
  color           text NOT NULL DEFAULT 'blue' CHECK (color IN ('blue','green','orange','red','purple','brown','teal','grey')),
  opening_balance bigint NOT NULL DEFAULT 0 CHECK (opening_balance BETWEEN -100000000000 AND 100000000000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX pf_accounts_owner_idx ON pf_accounts(owner_id, created_at);
CREATE UNIQUE INDEX pf_accounts_name_idx ON pf_accounts(owner_id, lower(trim(name))) WHERE archived_at IS NULL;

-- Transactions : revenu, dépense, ou les deux faces d'un virement entre deux comptes de la personne (même transfer_id).
-- origin prépare l'import et la synchronisation bancaire (non offerts pour l'instant : seule la saisie manuelle existe).
CREATE TABLE pf_transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id),
  account_id  uuid NOT NULL REFERENCES pf_accounts(id),
  kind        text NOT NULL CHECK (kind IN ('income','expense','transfer_out','transfer_in')),
  amount      bigint NOT NULL CHECK (amount BETWEEN 1 AND 100000000000),
  category    text NOT NULL,
  note        text CHECK (note IS NULL OR length(note) <= 200),
  occurred_on date NOT NULL,
  transfer_id uuid,
  origin      text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','import','sync')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  voided_at   timestamptz,
  CHECK ((kind IN ('transfer_out','transfer_in')) = (transfer_id IS NOT NULL))
);
CREATE INDEX pf_tx_owner_day_idx ON pf_transactions(owner_id, occurred_on DESC) WHERE voided_at IS NULL;
CREATE INDEX pf_tx_account_idx ON pf_transactions(account_id) WHERE voided_at IS NULL;

-- Accès au module : essai Pro et abonnement
CREATE TABLE pf_access (
  owner_id    uuid PRIMARY KEY REFERENCES users(id),
  trial_until timestamptz,
  paid_until  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION _pf_feature_on() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF _setting('feature_finances_perso') < 1 THEN PERFORM _err('feature_off', 'Mes finances n''est pas encore activé'); END IF;
END $$;

CREATE FUNCTION _pf_actor(p_actor uuid) RETURNS users LANGUAGE plpgsql AS $$
BEGIN
  RETURN _require(p_actor, ARRAY['admin','supplier','seller','agent','call_chief','courier','warehouse']::user_role[]);
END $$;

-- Formule de la personne : 'pro' (abonnement, essai, ou aucun prix fixé) ou 'free'
CREATE FUNCTION _pf_tier(p_owner uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN _setting('pf_price_monthly') = 0
                OR EXISTS (SELECT 1 FROM pf_access a WHERE a.owner_id = p_owner AND (a.paid_until > now() OR a.trial_until > now()))
              THEN 'pro' ELSE 'free' END
$$;

-- Lecture de la formule par l'application (les fonctions internes ne sont pas appelables directement)
CREATE FUNCTION fn_pf_tier(p_owner uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT _pf_tier(p_owner) $$;

-- L'essai démarre à la première utilisation
CREATE FUNCTION _pf_touch(p_owner uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO pf_access(owner_id, trial_until) VALUES (p_owner, now() + make_interval(days => _setting('pf_trial_days')::int))
  ON CONFLICT (owner_id) DO NOTHING
$$;

-- En formule gratuite, seuls les N plus anciens comptes actifs peuvent recevoir des transactions
CREATE FUNCTION _pf_account_writable(p_owner uuid, p_account uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _pf_tier(p_owner) = 'pro' OR p_account IN (
    SELECT id FROM pf_accounts WHERE owner_id = p_owner AND archived_at IS NULL ORDER BY created_at, id LIMIT _setting('pf_free_accounts')::int)
$$;

-- Créer (p_id vide) ou modifier un compte personnel
CREATE FUNCTION fn_pf_account_save(p_actor uuid, p_id uuid, p_name text, p_kind text, p_color text, p_opening bigint) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := p_id; v_name text := trim(COALESCE(p_name, ''));
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  PERFORM pg_advisory_xact_lock(hashtext('pf:' || p_actor::text));
  IF length(v_name) < 2 OR length(v_name) > 40 THEN PERFORM _err('invalid_input', 'Nom invalide (2 à 40 caractères)'); END IF;
  IF p_kind NOT IN ('cash','mobile_money','bank','savings','other') THEN PERFORM _err('invalid_input', 'Type de compte invalide'); END IF;
  IF p_color NOT IN ('blue','green','orange','red','purple','brown','teal','grey') THEN PERFORM _err('invalid_input', 'Couleur invalide'); END IF;
  IF p_opening IS NULL OR abs(p_opening) > 100000000000 THEN PERFORM _err('invalid_input', 'Solde de départ invalide'); END IF;
  IF EXISTS (SELECT 1 FROM pf_accounts WHERE owner_id = p_actor AND archived_at IS NULL AND lower(trim(name)) = lower(v_name) AND id IS DISTINCT FROM p_id) THEN
    PERFORM _err('duplicate', 'Vous avez déjà un compte avec ce nom');
  END IF;
  IF p_id IS NULL THEN
    PERFORM _pf_touch(p_actor);
    IF _pf_tier(p_actor) = 'free' AND (SELECT count(*) FROM pf_accounts WHERE owner_id = p_actor AND archived_at IS NULL) >= _setting('pf_free_accounts') THEN
      PERFORM _err('pro_required', 'La formule gratuite permet ' || _setting('pf_free_accounts') || ' comptes. Passez à Pro pour en ajouter.');
    END IF;
    IF (SELECT count(*) FROM pf_accounts WHERE owner_id = p_actor) >= 50 THEN PERFORM _err('limit', '50 comptes au plus'); END IF;
    INSERT INTO pf_accounts(owner_id, name, kind, color, opening_balance) VALUES (p_actor, v_name, p_kind, p_color, p_opening) RETURNING id INTO v_id;
  ELSE
    UPDATE pf_accounts SET name = v_name, kind = p_kind, color = p_color, opening_balance = p_opening WHERE id = p_id AND owner_id = p_actor AND archived_at IS NULL;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Compte introuvable'); END IF;
  END IF;
  RETURN v_id;
END $$;

-- Archiver (rien n'est supprimé) ou rétablir un compte
CREATE FUNCTION fn_pf_account_archive(p_actor uuid, p_id uuid, p_archived boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  PERFORM pg_advisory_xact_lock(hashtext('pf:' || p_actor::text));
  IF NOT p_archived AND _pf_tier(p_actor) = 'free' AND (SELECT count(*) FROM pf_accounts WHERE owner_id = p_actor AND archived_at IS NULL) >= _setting('pf_free_accounts') THEN
    PERFORM _err('pro_required', 'La formule gratuite permet ' || _setting('pf_free_accounts') || ' comptes actifs');
  END IF;
  UPDATE pf_accounts SET archived_at = CASE WHEN p_archived THEN COALESCE(archived_at, now()) END WHERE id = p_id AND owner_id = p_actor;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Compte introuvable'); END IF;
END $$;

CREATE FUNCTION _pf_check_tx(p_actor uuid, p_account uuid, p_kind text, p_amount bigint, p_category text, p_note text, p_day date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 100000000000 THEN PERFORM _err('invalid_input', 'Montant invalide'); END IF;
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères)'); END IF;
  IF p_day IS NULL OR p_day > current_date + 1 OR p_day < current_date - 3650 THEN PERFORM _err('invalid_input', 'Date invalide'); END IF;
  IF p_kind = 'income' AND p_category NOT IN ('sales','salary','gift','other_in') THEN PERFORM _err('invalid_input', 'Catégorie de revenu invalide'); END IF;
  IF p_kind = 'expense' AND p_category NOT IN ('food','transport','housing','telecom','health','family','business','shopping','savings','other_out') THEN PERFORM _err('invalid_input', 'Catégorie de dépense invalide'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pf_accounts WHERE id = p_account AND owner_id = p_actor AND archived_at IS NULL) THEN PERFORM _err('not_found', 'Compte introuvable'); END IF;
  IF NOT _pf_account_writable(p_actor, p_account) THEN PERFORM _err('pro_required', 'Ce compte est en lecture seule dans la formule gratuite. Passez à Pro pour le réutiliser.'); END IF;
END $$;

-- Ajouter un revenu ou une dépense (saisie manuelle)
CREATE FUNCTION fn_pf_tx_add(p_actor uuid, p_account uuid, p_kind text, p_amount bigint, p_category text, p_note text, p_day date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF p_kind NOT IN ('income','expense') THEN PERFORM _err('invalid_input', 'Type invalide'); END IF;
  PERFORM _pf_check_tx(p_actor, p_account, p_kind, p_amount, p_category, v_note, p_day);
  PERFORM _pf_touch(p_actor);
  INSERT INTO pf_transactions(owner_id, account_id, kind, amount, category, note, occurred_on) VALUES (p_actor, p_account, p_kind, p_amount, p_category, v_note, p_day) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Modifier une transaction (pas un virement : on l'annule et on le refait)
CREATE FUNCTION fn_pf_tx_update(p_actor uuid, p_id uuid, p_account uuid, p_amount bigint, p_category text, p_note text, p_day date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t pf_transactions; v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  SELECT * INTO t FROM pf_transactions WHERE id = p_id AND owner_id = p_actor AND voided_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Transaction introuvable'); END IF;
  IF t.kind NOT IN ('income','expense') THEN PERFORM _err('invalid_state', 'Un virement ne se modifie pas : annulez-le puis refaites-le'); END IF;
  PERFORM _pf_check_tx(p_actor, p_account, t.kind, p_amount, p_category, v_note, p_day);
  UPDATE pf_transactions SET account_id = p_account, amount = p_amount, category = p_category, note = v_note, occurred_on = p_day WHERE id = p_id;
END $$;

-- Annuler (rien n'est supprimé) ; un virement s'annule des deux côtés
CREATE FUNCTION fn_pf_tx_void(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t pf_transactions;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  SELECT * INTO t FROM pf_transactions WHERE id = p_id AND owner_id = p_actor AND voided_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Transaction introuvable'); END IF;
  IF NOT _pf_account_writable(p_actor, t.account_id) THEN PERFORM _err('pro_required', 'Ce compte est en lecture seule dans la formule gratuite'); END IF;
  UPDATE pf_transactions SET voided_at = now() WHERE voided_at IS NULL AND (id = p_id OR (t.transfer_id IS NOT NULL AND transfer_id = t.transfer_id));
END $$;

-- Virement entre deux comptes de la personne : ne change ni les revenus ni les dépenses
CREATE FUNCTION fn_pf_transfer(p_actor uuid, p_from uuid, p_to uuid, p_amount bigint, p_note text, p_day date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_tid uuid := gen_random_uuid(); v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF p_from = p_to THEN PERFORM _err('invalid_input', 'Choisissez deux comptes différents'); END IF;
  PERFORM _pf_check_tx(p_actor, p_from, 'transfer_out', p_amount, 'transfer', v_note, p_day);
  PERFORM _pf_check_tx(p_actor, p_to, 'transfer_in', p_amount, 'transfer', v_note, p_day);
  PERFORM _pf_touch(p_actor);
  INSERT INTO pf_transactions(owner_id, account_id, kind, amount, category, note, occurred_on, transfer_id) VALUES
    (p_actor, p_from, 'transfer_out', p_amount, 'transfer', v_note, p_day, v_tid),
    (p_actor, p_to,   'transfer_in',  p_amount, 'transfer', v_note, p_day, v_tid);
  RETURN v_tid;
END $$;

-- Passer à Pro : prélevé sur le portefeuille Wallindirain de la personne (même mécanisme que l'abonnement vendeur)
CREATE FUNCTION fn_pf_subscribe(p_actor uuid, p_plan text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE v_amount bigint; v_months int; v_from timestamptz; v_until timestamptz;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF p_plan NOT IN ('monthly','yearly') THEN PERFORM _err('invalid_input', 'Formule invalide'); END IF;
  v_amount := CASE WHEN p_plan = 'monthly' THEN _setting('pf_price_monthly') ELSE _setting('pf_price_yearly') END;
  v_months := CASE WHEN p_plan = 'monthly' THEN 1 ELSE 12 END;
  IF v_amount <= 0 THEN PERFORM _err('invalid_state', 'Cette formule n''est pas proposée pour le moment'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wallet:' || p_actor::text));
  IF _wallet_available(p_actor) < v_amount THEN PERFORM _err('insufficient_funds', 'Solde disponible insuffisant dans votre portefeuille Wallindirain'); END IF;
  PERFORM _wallet_add(p_actor, 'pf_subscription', -v_amount, NULL, now(), 'Mes finances Pro : ' || v_months || ' mois');
  PERFORM _wallet_add(_platform(), 'pf_subscription', v_amount, NULL, now(), 'Abonnement Mes finances');
  SELECT GREATEST(COALESCE(paid_until, now()), now()) INTO v_from FROM pf_access WHERE owner_id = p_actor;
  v_until := COALESCE(v_from, now()) + make_interval(months => v_months);
  INSERT INTO pf_access(owner_id, paid_until) VALUES (p_actor, v_until)
    ON CONFLICT (owner_id) DO UPDATE SET paid_until = v_until, updated_at = now();
  PERFORM _audit(p_actor, 'pf_subscribed', 'user', p_actor::text, jsonb_build_object('plan', p_plan, 'amount', v_amount));
  RETURN v_until;
END $$;

-- L'administrateur offre ou encaisse hors plateforme (virement, espèces) : une note est obligatoire
CREATE FUNCTION fn_admin_pf_grant(p_actor uuid, p_user uuid, p_months int, p_note text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE v_from timestamptz; v_until timestamptz;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_months IS NULL OR p_months < 1 OR p_months > 24 THEN PERFORM _err('invalid_input', 'Durée invalide (1 à 24 mois)'); END IF;
  IF p_note IS NULL OR length(trim(p_note)) < 3 THEN PERFORM _err('note_required', 'Indiquez en quelques mots la raison (paiement reçu, cadeau…)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND deleted_at IS NULL AND role <> 'system') THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  SELECT GREATEST(COALESCE(paid_until, now()), now()) INTO v_from FROM pf_access WHERE owner_id = p_user;
  v_until := COALESCE(v_from, now()) + make_interval(months => p_months);
  INSERT INTO pf_access(owner_id, paid_until) VALUES (p_user, v_until) ON CONFLICT (owner_id) DO UPDATE SET paid_until = v_until, updated_at = now();
  PERFORM _audit(p_actor, 'pf_granted', 'user', p_user::text, jsonb_build_object('months', p_months, 'note', trim(p_note)));
  RETURN v_until;
END $$;

-- Réglages des jauges de la personne : objectifs qui placent l'aiguille (vide = calcul automatique)
CREATE TABLE pf_prefs (
  owner_id       uuid PRIMARY KEY REFERENCES users(id),
  income_target  bigint CHECK (income_target IS NULL OR income_target BETWEEN 1 AND 100000000000),
  balance_target bigint CHECK (balance_target IS NULL OR balance_target BETWEEN 1 AND 100000000000),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION fn_pf_prefs_set(p_actor uuid, p_income bigint, p_balance bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF (p_income IS NOT NULL AND (p_income < 1 OR p_income > 100000000000)) OR (p_balance IS NOT NULL AND (p_balance < 1 OR p_balance > 100000000000)) THEN PERFORM _err('invalid_input', 'Objectif invalide'); END IF;
  INSERT INTO pf_prefs(owner_id, income_target, balance_target) VALUES (p_actor, p_income, p_balance)
    ON CONFLICT (owner_id) DO UPDATE SET income_target = EXCLUDED.income_target, balance_target = EXCLUDED.balance_target, updated_at = now();
END $$;

-- Un compte anonymisé perd ses données de finances personnelles
CREATE FUNCTION trg_pf_user_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pf_transactions WHERE owner_id = NEW.id;
  DELETE FROM pf_accounts WHERE owner_id = NEW.id;
  DELETE FROM pf_access WHERE owner_id = NEW.id;
  DELETE FROM pf_prefs WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_pf_user_anonymized() SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER users_pf_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_user_anonymized();

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
