-- 054 : profil (personnel / entreprise) et catégories modifiables de « Mes finances ».
-- Un arbre de catégories (groupe > sous-catégorie > élément ajouté par la personne). Les catégories existantes gardent leur clé :
-- aucune transaction, aucun budget ni paiement planifié n'est modifié. Rien n'est supprimé : « masquer » garde l'historique.
-- Nouveauté : les clés de catégorie ne sont plus une liste figée ; elles sont vérifiées par _pf_cat_ok (système ou catégorie de la personne).

CREATE TABLE pf_cat_system (
  key        text PRIMARY KEY,
  parent_key text REFERENCES pf_cat_system(key),
  kind       text NOT NULL CHECK (kind IN ('income','expense')),
  label      text NOT NULL,
  icon       text NOT NULL,
  profile    text NOT NULL CHECK (profile IN ('personal','business','both')),
  operating  boolean NOT NULL,         -- false = financement / remboursement de prêt : hors revenus et dépenses d'exploitation
  position   int NOT NULL
);
INSERT INTO pf_cat_system(key, parent_key, kind, label, icon, profile, operating, position) VALUES
  ('sales', NULL, 'income', 'Revenus de vente', '🛍️', 'both', true, 1),
  ('sales_product', 'sales', 'income', 'Produit', '📦', 'both', true, 2),
  ('sales_service', 'sales', 'income', 'Service', '🛠️', 'both', true, 3),
  ('other_income', NULL, 'income', 'Autres revenus', '➕', 'business', true, 4),
  ('refund', 'other_income', 'income', 'Remboursement', '↩️', 'business', true, 5),
  ('interest_in', 'other_income', 'income', 'Intérêts', '🏦', 'business', true, 6),
  ('capital_gain', 'other_income', 'income', 'Plus-values', '📈', 'business', true, 7),
  ('misc_income', NULL, 'income', 'Revenus divers', '🧾', 'business', true, 8),
  ('unassigned_income', NULL, 'income', 'Revenus non affectés', '❔', 'business', true, 9),
  ('financing', NULL, 'income', 'Nouveaux financements', '💰', 'business', false, 10),
  ('loan_new', 'financing', 'income', 'Nouveau prêt', '🏦', 'business', false, 11),
  ('bond_new', 'financing', 'income', 'Nouvelle obligation', '📜', 'business', false, 12),
  ('promissory', 'financing', 'income', 'Billet à ordre', '✍️', 'business', false, 13),
  ('equity', 'financing', 'income', 'Investissement en capitaux propres', '🏛️', 'business', false, 14),
  ('salary', NULL, 'income', 'Salaire', '💼', 'personal', true, 15),
  ('gift', NULL, 'income', 'Cadeau ou aide', '🎁', 'personal', true, 16),
  ('other_in', NULL, 'income', 'Autre revenu', '➕', 'both', true, 17),
  ('food', NULL, 'expense', 'Alimentation', '🍽️', 'personal', true, 18),
  ('transport', NULL, 'expense', 'Transport', '🚗', 'personal', true, 19),
  ('housing', NULL, 'expense', 'Logement', '🏠', 'personal', true, 20),
  ('telecom', NULL, 'expense', 'Téléphone et internet', '📱', 'both', true, 21),
  ('health', NULL, 'expense', 'Santé', '❤️', 'personal', true, 22),
  ('family', NULL, 'expense', 'Famille', '👪', 'personal', true, 23),
  ('business', NULL, 'expense', 'Activité', '💼', 'both', true, 24),
  ('shopping', NULL, 'expense', 'Achats', '🛒', 'personal', true, 25),
  ('savings', NULL, 'expense', 'Épargne', '🐖', 'personal', true, 26),
  ('other_out', NULL, 'expense', 'Autre dépense', '➖', 'both', true, 27),
  ('space', NULL, 'expense', 'Espace et équipement', '🏢', 'business', true, 28),
  ('rent_space', 'space', 'expense', 'Location d''espace', '🏬', 'business', true, 29),
  ('utilities', 'space', 'expense', 'Services publics', '💡', 'business', true, 30),
  ('energy', 'space', 'expense', 'Énergie', '⚡', 'business', true, 31),
  ('security', 'space', 'expense', 'Sécurité', '🔒', 'business', true, 32),
  ('equip_lease', 'space', 'expense', 'Location ou leasing d''équipement', '🖨️', 'business', true, 33),
  ('maintenance', 'space', 'expense', 'Préparation et entretien', '🧹', 'business', true, 34),
  ('payroll', NULL, 'expense', 'Paie et dépenses', '👥', 'business', true, 35),
  ('employees', 'payroll', 'expense', 'Employés', '🧑‍💼', 'business', true, 36),
  ('contractors', 'payroll', 'expense', 'Contractants', '🤝', 'business', true, 37),
  ('education', 'payroll', 'expense', 'Éducation', '🎓', 'business', true, 38),
  ('team_events', 'payroll', 'expense', 'Événements d''équipe', '🎉', 'business', true, 39),
  ('travel', 'payroll', 'expense', 'Frais de voyage', '✈️', 'business', true, 40),
  ('stock', NULL, 'expense', 'Achat de stock', '📦', 'business', true, 41),
  ('materials', 'stock', 'expense', 'Matériel', '🧰', 'business', true, 42),
  ('parts', 'stock', 'expense', 'Pièces', '⚙️', 'business', true, 43),
  ('goods', 'stock', 'expense', 'Marchandises à vendre', '🏷️', 'business', true, 44),
  ('supplies', 'stock', 'expense', 'Autres fournitures', '🗂️', 'business', true, 45),
  ('opsvc', NULL, 'expense', 'Services opérationnels', '🧭', 'business', true, 46),
  ('svc_marketing', 'opsvc', 'expense', 'Marketing et vente', '📣', 'business', true, 47),
  ('svc_ops_it', 'opsvc', 'expense', 'Opérationnel et informatique', '💻', 'business', true, 48),
  ('svc_other', 'opsvc', 'expense', 'Autres services', '🔧', 'business', true, 49),
  ('svc_customer', 'opsvc', 'expense', 'Service client', '🎧', 'business', true, 50),
  ('svc_logistics', 'opsvc', 'expense', 'Logistique', '🚚', 'business', true, 51),
  ('bills', NULL, 'expense', 'Autres factures et frais', '🧾', 'business', true, 52),
  ('subs', 'bills', 'expense', 'Abonnements et logiciels', '🔁', 'business', true, 53),
  ('telecom_fees', 'bills', 'expense', 'Frais de télécommunication', '📞', 'business', true, 54),
  ('accounting_legal', 'bills', 'expense', 'Comptable et juridique', '⚖️', 'business', true, 55),
  ('admin_other', 'bills', 'expense', 'Autres dépenses administratives', '🗄️', 'business', true, 56),
  ('interest_out', 'bills', 'expense', 'Intérêts', '🏦', 'business', true, 57),
  ('fees', 'bills', 'expense', 'Frais', '💳', 'business', true, 58),
  ('insurance', 'bills', 'expense', 'Assurance', '🛡️', 'business', true, 59),
  ('tax', 'bills', 'expense', 'Impôt', '🏛️', 'business', true, 60),
  ('vat', 'bills', 'expense', 'TVA', '🧮', 'business', true, 61),
  ('other_cost', 'bills', 'expense', 'Autres coûts', '➖', 'business', true, 62),
  ('debt_repay', NULL, 'expense', 'Remboursement de prêt', '↘️', 'business', false, 63),
  ('repay_loan', 'debt_repay', 'expense', 'Prêt', '🏦', 'business', false, 64),
  ('repay_bond', 'debt_repay', 'expense', 'Obligation', '📜', 'business', false, 65),
  ('repay_bond_new', 'debt_repay', 'expense', 'Nouvelle obligation', '📜', 'business', false, 66),
  ('repay_promissory', 'debt_repay', 'expense', 'Billet à ordre', '✍️', 'business', false, 67),
  ('repay_other', 'debt_repay', 'expense', 'Autres dettes', '📉', 'business', false, 68);

-- Catégories ajoutées par la personne (jamais supprimées : « archivée » = masquée)
CREATE TABLE pf_cat_custom (
  owner_id    uuid NOT NULL REFERENCES users(id),
  key         text NOT NULL,
  parent_key  text,
  kind        text NOT NULL CHECK (kind IN ('income','expense')),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  icon        text CHECK (icon IS NULL OR length(icon) <= 12),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);
-- Nom ou icône changés, ou catégorie système masquée, par la personne
CREATE TABLE pf_cat_override (
  owner_id uuid NOT NULL REFERENCES users(id),
  key      text NOT NULL REFERENCES pf_cat_system(key),
  label    text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 40),
  icon     text CHECK (icon IS NULL OR length(icon) <= 12),
  hidden   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_id, key)
);
ALTER TABLE pf_prefs ADD COLUMN profile text CHECK (profile IS NULL OR profile IN ('personal','business','both'));
INSERT INTO settings(key, value, label) VALUES
  ('pf_free_categories', 5, 'Mes finances : nombre de catégories ajoutées par la personne en formule gratuite (Pro : illimité)');

-- La vérification des catégories passe de listes figées à la table
CREATE FUNCTION _pf_cat_ok(p_actor uuid, p_kind text, p_key text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_key IS NOT NULL AND (
    EXISTS (SELECT 1 FROM pf_cat_system WHERE key = p_key AND kind = p_kind)
    OR EXISTS (SELECT 1 FROM pf_cat_custom WHERE owner_id = p_actor AND key = p_key AND kind = p_kind));
$$;

ALTER TABLE pf_budgets DROP CONSTRAINT pf_budgets_category_check;

DO $$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('_pf_check_tx(uuid,uuid,text,bigint,text,text,date)'::regprocedure);
  n := replace(d, 'IF p_kind = ''income'' AND p_category NOT IN (''sales'',''salary'',''gift'',''other_in'') THEN PERFORM _err(''invalid_input'', ''Catégorie de revenu invalide''); END IF;', 'IF p_kind = ''income'' AND NOT _pf_cat_ok(p_actor, ''income'', p_category) THEN PERFORM _err(''invalid_input'', ''Catégorie de revenu invalide''); END IF;');
  n := replace(n, 'IF p_kind = ''expense'' AND p_category NOT IN (''food'',''transport'',''housing'',''telecom'',''health'',''family'',''business'',''shopping'',''savings'',''other_out'') THEN PERFORM _err(''invalid_input'', ''Catégorie de dépense invalide''); END IF;', 'IF p_kind = ''expense'' AND NOT _pf_cat_ok(p_actor, ''expense'', p_category) THEN PERFORM _err(''invalid_input'', ''Catégorie de dépense invalide''); END IF;');
  IF n = d OR n LIKE '%NOT IN (''sales''%' OR n LIKE '%NOT IN (''food''%' THEN RAISE EXCEPTION '_pf_check_tx : texte inattendu'; END IF;
  EXECUTE n;

  d := pg_get_functiondef('fn_pf_recurring_save(uuid,uuid,text,text,text,bigint,text,date)'::regprocedure);
  n := replace(d, 'IF p_kind = ''income'' AND p_category NOT IN (''sales'',''salary'',''gift'',''other_in'') THEN PERFORM _err(''invalid_input'', ''Catégorie de revenu invalide''); END IF;', 'IF p_kind = ''income'' AND NOT _pf_cat_ok(p_actor, ''income'', p_category) THEN PERFORM _err(''invalid_input'', ''Catégorie de revenu invalide''); END IF;');
  n := replace(n, 'IF p_kind = ''expense'' AND p_category NOT IN (''food'',''transport'',''housing'',''telecom'',''health'',''family'',''business'',''shopping'',''savings'',''other_out'') THEN PERFORM _err(''invalid_input'', ''Catégorie de dépense invalide''); END IF;', 'IF p_kind = ''expense'' AND NOT _pf_cat_ok(p_actor, ''expense'', p_category) THEN PERFORM _err(''invalid_input'', ''Catégorie de dépense invalide''); END IF;');
  IF n = d OR n LIKE '%NOT IN (''sales''%' OR n LIKE '%NOT IN (''food''%' THEN RAISE EXCEPTION 'fn_pf_recurring_save : texte inattendu'; END IF;
  EXECUTE n;

  d := pg_get_functiondef('fn_pf_budget_set(uuid,text,bigint)'::regprocedure);
  n := replace(d, 'IF p_category NOT IN (''food'',''transport'',''housing'',''telecom'',''health'',''family'',''business'',''shopping'',''savings'',''other_out'') THEN', 'IF NOT _pf_cat_ok(p_actor, ''expense'', p_category) THEN');
  IF n = d THEN RAISE EXCEPTION 'fn_pf_budget_set : texte inattendu'; END IF;
  EXECUTE n;
END $$;

-- Profil : personnel, entreprise ou les deux (choisi une fois, modifiable)
CREATE FUNCTION fn_pf_profile_set(p_actor uuid, p_profile text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF p_profile IS NULL OR p_profile NOT IN ('personal','business','both') THEN PERFORM _err('invalid_input', 'Profil invalide'); END IF;
  INSERT INTO pf_prefs(owner_id, profile) VALUES (p_actor, p_profile)
    ON CONFLICT (owner_id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = now();
END $$;

-- Ajouter une catégorie (sous un groupe, ou un nouveau groupe) ; 3 niveaux au plus
CREATE FUNCTION fn_pf_cat_add(p_actor uuid, p_parent text, p_kind text, p_label text, p_icon text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_label text := btrim(COALESCE(p_label, '')); v_kind text := p_kind; v_depth int := 1; v_key text; v_cur text := p_parent; v_n int;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF length(v_label) < 1 OR length(v_label) > 40 THEN PERFORM _err('invalid_input', 'Nom de 1 à 40 caractères'); END IF;
  IF p_icon IS NOT NULL AND length(p_icon) > 12 THEN PERFORM _err('invalid_input', 'Icône invalide'); END IF;
  IF p_parent IS NOT NULL THEN
    SELECT kind INTO v_kind FROM (SELECT kind FROM pf_cat_system WHERE key = p_parent UNION ALL SELECT kind FROM pf_cat_custom WHERE owner_id = p_actor AND key = p_parent) x LIMIT 1;
    IF v_kind IS NULL THEN PERFORM _err('not_found', 'Catégorie parente introuvable'); END IF;
    -- profondeur du parent
    LOOP
      SELECT parent_key INTO v_cur FROM (SELECT key, parent_key FROM pf_cat_system UNION ALL SELECT key, parent_key FROM pf_cat_custom WHERE owner_id = p_actor) x WHERE key = v_cur LIMIT 1;
      EXIT WHEN v_cur IS NULL OR v_depth > 5;
      v_depth := v_depth + 1;
    END LOOP;
    IF v_depth >= 3 THEN PERFORM _err('invalid_input', 'Trois niveaux au plus'); END IF;
  ELSIF v_kind IS NULL OR v_kind NOT IN ('income','expense') THEN PERFORM _err('invalid_input', 'Type invalide (revenu ou dépense)'); END IF;
  IF _pf_tier(p_actor) <> 'pro' THEN
    SELECT count(*) INTO v_n FROM pf_cat_custom WHERE owner_id = p_actor AND archived_at IS NULL;
    IF v_n >= _setting('pf_free_categories') THEN PERFORM _err('limit', 'Limite de catégories ajoutées atteinte dans la formule gratuite. Passez à Pro pour en ajouter autant que vous voulez.'); END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pf_cat_custom WHERE owner_id = p_actor AND parent_key IS NOT DISTINCT FROM p_parent AND kind = v_kind AND archived_at IS NULL AND lower(label) = lower(v_label))
     OR EXISTS (SELECT 1 FROM pf_cat_system WHERE parent_key IS NOT DISTINCT FROM p_parent AND kind = v_kind AND lower(label) = lower(v_label)) THEN
    PERFORM _err('duplicate', 'Une catégorie porte déjà ce nom ici');
  END IF;
  v_key := 'c_' || replace(left(gen_random_uuid()::text, 13), '-', '');
  INSERT INTO pf_cat_custom(owner_id, key, parent_key, kind, label, icon) VALUES (p_actor, v_key, p_parent, v_kind, v_label, NULLIF(btrim(COALESCE(p_icon, '')), ''));
  RETURN v_key;
END $$;

-- Renommer, changer l'icône, masquer ou ré-afficher (catégorie système ou ajoutée). Nom vide = nom d'origine.
CREATE FUNCTION fn_pf_cat_edit(p_actor uuid, p_key text, p_label text, p_icon text, p_hidden boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_label text := NULLIF(btrim(COALESCE(p_label, '')), ''); v_icon text := NULLIF(btrim(COALESCE(p_icon, '')), '');
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF v_label IS NOT NULL AND length(v_label) > 40 THEN PERFORM _err('invalid_input', 'Nom de 40 caractères au plus'); END IF;
  IF v_icon IS NOT NULL AND length(v_icon) > 12 THEN PERFORM _err('invalid_input', 'Icône invalide'); END IF;
  IF EXISTS (SELECT 1 FROM pf_cat_custom WHERE owner_id = p_actor AND key = p_key) THEN
    IF v_label IS NULL THEN PERFORM _err('invalid_input', 'Le nom est obligatoire'); END IF;
    UPDATE pf_cat_custom SET label = v_label, icon = v_icon, archived_at = CASE WHEN p_hidden THEN COALESCE(archived_at, now()) END WHERE owner_id = p_actor AND key = p_key;
  ELSIF EXISTS (SELECT 1 FROM pf_cat_system WHERE key = p_key) THEN
    INSERT INTO pf_cat_override(owner_id, key, label, icon, hidden) VALUES (p_actor, p_key, v_label, v_icon, COALESCE(p_hidden, false))
      ON CONFLICT (owner_id, key) DO UPDATE SET label = EXCLUDED.label, icon = EXCLUDED.icon, hidden = EXCLUDED.hidden;
  ELSE PERFORM _err('not_found', 'Catégorie introuvable'); END IF;
END $$;

-- Un compte anonymisé perd aussi ses catégories et son profil
CREATE FUNCTION trg_pf_cat_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pf_cat_override WHERE owner_id = NEW.id;
  DELETE FROM pf_cat_custom WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_pf_cat_anonymized() SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER users_pf_cat_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_cat_anonymized();

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
