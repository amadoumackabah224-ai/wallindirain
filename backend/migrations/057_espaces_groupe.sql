-- 057 : espaces de groupe de « Mes finances » (entreprises, petites équipes).
-- Un espace a ses propres comptes et transactions, partagés entre ses membres selon leur rôle. Il est totalement séparé des finances personnelles
-- (tables distinctes) : rien n'est mélangé avec les chiffres privés de chaque membre. Fermé par défaut (interrupteur admin), réservé au Pro du propriétaire.
-- Rôles : owner (tout), accountant (saisit et modifie tout), contributor (ajoute, modifie ce qu'il a saisi), viewer (lit). Comptes en GNF.

INSERT INTO settings(key, value, label) VALUES
  ('pf_spaces', 0, 'Mes finances : espaces de groupe pour entreprises et équipes (1 = actif)'),
  ('pf_space_max_spaces', 3, 'Mes finances : nombre d''espaces qu''une personne peut créer'),
  ('pf_space_max_members', 10, 'Mes finances : nombre de membres (invités compris) par espace');

CREATE TABLE pf_spaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE TABLE pf_space_members (
  space_id     uuid NOT NULL REFERENCES pf_spaces(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('owner','accountant','contributor','viewer')),
  status       text NOT NULL CHECK (status IN ('invited','active','declined','removed','left')),
  invited_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX pf_space_members_user ON pf_space_members(user_id, status);
CREATE TABLE pf_space_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id        uuid NOT NULL REFERENCES pf_spaces(id),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 40),
  kind            text NOT NULL CHECK (kind IN ('cash','mobile_money','bank','savings','other')),
  color           text NOT NULL CHECK (color IN ('blue','green','orange','red','purple','brown','teal','grey')),
  opening_balance bigint NOT NULL DEFAULT 0 CHECK (abs(opening_balance) <= 100000000000),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX pf_space_accounts_space ON pf_space_accounts(space_id);
CREATE TABLE pf_space_tx (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id    uuid NOT NULL REFERENCES pf_spaces(id),
  account_id  uuid NOT NULL REFERENCES pf_space_accounts(id),
  kind        text NOT NULL CHECK (kind IN ('income','expense','transfer_in','transfer_out')),
  amount      bigint NOT NULL CHECK (amount BETWEEN 1 AND 100000000000),
  category    text NOT NULL CHECK (length(category) <= 40),
  note        text CHECK (note IS NULL OR length(note) <= 200),
  occurred_on date NOT NULL,
  transfer_id uuid,
  author_id   uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  voided_at   timestamptz,
  voided_by   uuid REFERENCES users(id)
);
CREATE INDEX pf_space_tx_space ON pf_space_tx(space_id, occurred_on DESC);
CREATE INDEX pf_space_tx_account ON pf_space_tx(account_id);
-- Journal d'activité : en ajout seul
CREATE TABLE pf_space_log (
  id         bigserial PRIMARY KEY,
  space_id   uuid NOT NULL REFERENCES pf_spaces(id),
  actor_id   uuid REFERENCES users(id),
  action     text NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pf_space_log_space ON pf_space_log(space_id, id DESC);
CREATE TRIGGER pf_space_log_immutable BEFORE UPDATE OR DELETE ON pf_space_log FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- ---------- fonctions internes ----------
CREATE FUNCTION _space_on() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_feature_on();
  IF _setting('pf_spaces') < 1 THEN PERFORM _err('feature_off', 'Les espaces de groupe ne sont pas encore activés'); END IF;
END $$;

-- Contrôle d'accès : rôle de la personne dans l'espace. Un non-membre reçoit « introuvable » (on ne révèle pas l'existence de l'espace).
-- p_write : l'espace doit être actif et le Pro de son propriétaire en cours (sinon lecture seule, données conservées).
CREATE FUNCTION _space_need(p_actor uuid, p_space uuid, p_roles text[], p_write boolean) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_role text; v_owner uuid; v_arch timestamptz;
BEGIN
  SELECT m.role, s.owner_id, s.archived_at INTO v_role, v_owner, v_arch FROM pf_space_members m JOIN pf_spaces s ON s.id = m.space_id
    WHERE m.space_id = p_space AND m.user_id = p_actor AND m.status = 'active';
  IF v_role IS NULL THEN PERFORM _err('not_found', 'Espace introuvable'); END IF;
  IF NOT v_role = ANY (p_roles) THEN PERFORM _err('forbidden', 'Votre rôle ne permet pas cette action'); END IF;
  IF p_write THEN
    IF v_arch IS NOT NULL THEN PERFORM _err('invalid_state', 'Cet espace est archivé'); END IF;
    IF _pf_tier(v_owner) <> 'pro' THEN PERFORM _err('pro_required', 'L''espace est en lecture seule : l''abonnement Pro de son propriétaire a pris fin.'); END IF;
  END IF;
  RETURN v_role;
END $$;

CREATE FUNCTION _space_log(p_space uuid, p_actor uuid, p_action text, p_detail text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO pf_space_log(space_id, actor_id, action, detail) VALUES (p_space, p_actor, p_action, left(p_detail, 300))
$$;

-- Vérifie un mouvement d'espace (montant, date, note, catégorie du propriétaire, compte de l'espace)
CREATE FUNCTION _space_check_tx(p_space uuid, p_account uuid, p_kind text, p_amount bigint, p_category text, p_note text, p_day date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_owner uuid;
BEGIN
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 100000000000 THEN PERFORM _err('invalid_input', 'Montant invalide'); END IF;
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères)'); END IF;
  IF p_day IS NULL OR p_day > current_date + 1 OR p_day < current_date - 3650 THEN PERFORM _err('invalid_input', 'Date invalide'); END IF;
  SELECT owner_id INTO v_owner FROM pf_spaces WHERE id = p_space;
  IF p_kind IN ('income','expense') AND NOT _pf_cat_ok(v_owner, p_kind, p_category) THEN PERFORM _err('invalid_input', 'Catégorie invalide'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pf_space_accounts WHERE id = p_account AND space_id = p_space AND archived_at IS NULL) THEN PERFORM _err('not_found', 'Compte introuvable'); END IF;
END $$;

-- ---------- espaces et membres ----------
CREATE FUNCTION fn_pf_space_create(p_actor uuid, p_name text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_name text := btrim(COALESCE(p_name, ''));
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on();
  PERFORM pg_advisory_xact_lock(hashtext('pfspace:' || p_actor::text));
  IF length(v_name) < 2 OR length(v_name) > 60 THEN PERFORM _err('invalid_input', 'Nom de 2 à 60 caractères'); END IF;
  IF _pf_tier(p_actor) <> 'pro' THEN PERFORM _err('pro_required', 'Créer un espace de groupe fait partie de la formule Pro.'); END IF;
  IF (SELECT count(*) FROM pf_spaces WHERE owner_id = p_actor AND archived_at IS NULL) >= _setting('pf_space_max_spaces') THEN PERFORM _err('limit', 'Nombre maximum d''espaces atteint'); END IF;
  INSERT INTO pf_spaces(owner_id, name) VALUES (p_actor, v_name) RETURNING id INTO v_id;
  INSERT INTO pf_space_members(space_id, user_id, role, status, invited_by, responded_at) VALUES (v_id, p_actor, 'owner', 'active', p_actor, now());
  PERFORM _space_log(v_id, p_actor, 'space_create', v_name);
  RETURN v_id;
END $$;

CREATE FUNCTION fn_pf_space_rename(p_actor uuid, p_space uuid, p_name text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_name text := btrim(COALESCE(p_name, ''));
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); PERFORM _space_need(p_actor, p_space, ARRAY['owner'], false);
  IF length(v_name) < 2 OR length(v_name) > 60 THEN PERFORM _err('invalid_input', 'Nom de 2 à 60 caractères'); END IF;
  UPDATE pf_spaces SET name = v_name WHERE id = p_space;
  PERFORM _space_log(p_space, p_actor, 'space_rename', v_name);
END $$;

CREATE FUNCTION fn_pf_space_archive(p_actor uuid, p_space uuid, p_archived boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); PERFORM _space_need(p_actor, p_space, ARRAY['owner'], false);
  UPDATE pf_spaces SET archived_at = CASE WHEN p_archived THEN COALESCE(archived_at, now()) END WHERE id = p_space;
  PERFORM _space_log(p_space, p_actor, CASE WHEN p_archived THEN 'space_archive' ELSE 'space_restore' END, NULL);
END $$;

-- Inviter une personne qui a déjà un compte Wallindirain, par son numéro
CREATE FUNCTION fn_pf_space_invite(p_actor uuid, p_space uuid, p_phone text, p_role text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_target uuid; v_name text; v_status text; v_phone text := _pf_norm_phone(p_phone);
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); PERFORM _space_need(p_actor, p_space, ARRAY['owner'], true);
  PERFORM pg_advisory_xact_lock(hashtext('pfspacem:' || p_space::text));
  IF p_role NOT IN ('accountant','contributor','viewer') THEN PERFORM _err('invalid_input', 'Rôle invalide'); END IF;
  SELECT id INTO v_target FROM users WHERE phone = v_phone AND deleted_at IS NULL AND role <> 'system';
  IF v_target IS NULL THEN PERFORM _err('not_found', 'Aucun compte Wallindirain avec ce numéro. La personne doit d''abord s''inscrire.'); END IF;
  IF v_target = p_actor THEN PERFORM _err('invalid_input', 'Vous êtes déjà dans cet espace'); END IF;
  SELECT status INTO v_status FROM pf_space_members WHERE space_id = p_space AND user_id = v_target;
  IF v_status IN ('active','invited') THEN PERFORM _err('duplicate', 'Cette personne est déjà dans l''espace ou déjà invitée'); END IF;
  IF (SELECT count(*) FROM pf_space_members WHERE space_id = p_space AND status IN ('active','invited')) >= _setting('pf_space_max_members') THEN PERFORM _err('limit', 'Nombre maximum de membres atteint'); END IF;
  INSERT INTO pf_space_members(space_id, user_id, role, status, invited_by) VALUES (p_space, v_target, p_role, 'invited', p_actor)
    ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'invited', invited_by = p_actor, created_at = now(), responded_at = NULL;
  SELECT name INTO v_name FROM pf_spaces WHERE id = p_space;
  PERFORM _notify(v_target, 'pf', 'Invitation à un espace', 'Vous êtes invité(e) à rejoindre « ' || v_name || ' » dans Mes finances.', NULL);
  PERFORM _space_log(p_space, p_actor, 'invite', p_role || ' · ' || (SELECT full_name FROM users WHERE id = v_target));
  RETURN v_target;
END $$;

CREATE FUNCTION fn_pf_space_respond(p_actor uuid, p_space uuid, p_accept boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on();
  UPDATE pf_space_members SET status = CASE WHEN p_accept THEN 'active' ELSE 'declined' END, responded_at = now()
    WHERE space_id = p_space AND user_id = p_actor AND status = 'invited';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Invitation introuvable'); END IF;
  PERFORM _space_log(p_space, p_actor, CASE WHEN p_accept THEN 'join' ELSE 'decline' END, NULL);
END $$;

CREATE FUNCTION fn_pf_space_set_role(p_actor uuid, p_space uuid, p_user uuid, p_role text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); PERFORM _space_need(p_actor, p_space, ARRAY['owner'], true);
  IF p_role NOT IN ('accountant','contributor','viewer') THEN PERFORM _err('invalid_input', 'Rôle invalide'); END IF;
  UPDATE pf_space_members SET role = p_role WHERE space_id = p_space AND user_id = p_user AND status IN ('active','invited') AND role <> 'owner';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Membre introuvable'); END IF;
  PERFORM _space_log(p_space, p_actor, 'role', p_role || ' · ' || (SELECT full_name FROM users WHERE id = p_user));
END $$;

CREATE FUNCTION fn_pf_space_remove(p_actor uuid, p_space uuid, p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); PERFORM _space_need(p_actor, p_space, ARRAY['owner'], false);
  UPDATE pf_space_members SET status = 'removed', responded_at = now() WHERE space_id = p_space AND user_id = p_user AND status IN ('active','invited') AND role <> 'owner';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Membre introuvable'); END IF;
  PERFORM _space_log(p_space, p_actor, 'remove', (SELECT full_name FROM users WHERE id = p_user));
END $$;

CREATE FUNCTION fn_pf_space_leave(p_actor uuid, p_space uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on();
  UPDATE pf_space_members SET status = 'left', responded_at = now() WHERE space_id = p_space AND user_id = p_actor AND status = 'active' AND role <> 'owner';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Espace introuvable'); END IF;
  PERFORM _space_log(p_space, p_actor, 'leave', NULL);
END $$;

-- ---------- comptes de l'espace ----------
CREATE FUNCTION fn_pf_space_account_save(p_actor uuid, p_space uuid, p_id uuid, p_name text, p_kind text, p_color text, p_opening bigint) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := p_id; v_name text := btrim(COALESCE(p_name, ''));
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); PERFORM _space_need(p_actor, p_space, ARRAY['owner','accountant'], true);
  PERFORM pg_advisory_xact_lock(hashtext('pfspacea:' || p_space::text));
  IF length(v_name) < 2 OR length(v_name) > 40 THEN PERFORM _err('invalid_input', 'Nom invalide (2 à 40 caractères)'); END IF;
  IF p_kind NOT IN ('cash','mobile_money','bank','savings','other') THEN PERFORM _err('invalid_input', 'Type de compte invalide'); END IF;
  IF p_color NOT IN ('blue','green','orange','red','purple','brown','teal','grey') THEN PERFORM _err('invalid_input', 'Couleur invalide'); END IF;
  IF p_opening IS NULL OR abs(p_opening) > 100000000000 THEN PERFORM _err('invalid_input', 'Solde invalide'); END IF;
  IF EXISTS (SELECT 1 FROM pf_space_accounts WHERE space_id = p_space AND archived_at IS NULL AND lower(name) = lower(v_name) AND id IS DISTINCT FROM p_id) THEN PERFORM _err('duplicate', 'Un compte porte déjà ce nom'); END IF;
  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM pf_space_accounts WHERE space_id = p_space) >= 30 THEN PERFORM _err('limit', '30 comptes au plus par espace'); END IF;
    INSERT INTO pf_space_accounts(space_id, name, kind, color, opening_balance, created_by) VALUES (p_space, v_name, p_kind, p_color, p_opening, p_actor) RETURNING id INTO v_id;
    PERFORM _space_log(p_space, p_actor, 'account_add', v_name);
  ELSE
    UPDATE pf_space_accounts SET name = v_name, kind = p_kind, color = p_color, opening_balance = p_opening WHERE id = p_id AND space_id = p_space AND archived_at IS NULL;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Compte introuvable'); END IF;
    PERFORM _space_log(p_space, p_actor, 'account_edit', v_name);
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_pf_space_account_archive(p_actor uuid, p_space uuid, p_id uuid, p_archived boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); PERFORM _space_need(p_actor, p_space, ARRAY['owner','accountant'], true);
  UPDATE pf_space_accounts SET archived_at = CASE WHEN p_archived THEN COALESCE(archived_at, now()) END WHERE id = p_id AND space_id = p_space;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Compte introuvable'); END IF;
  PERFORM _space_log(p_space, p_actor, CASE WHEN p_archived THEN 'account_archive' ELSE 'account_restore' END, (SELECT name FROM pf_space_accounts WHERE id = p_id));
END $$;

-- ---------- mouvements de l'espace ----------
CREATE FUNCTION fn_pf_space_tx_add(p_actor uuid, p_space uuid, p_account uuid, p_kind text, p_amount bigint, p_category text, p_note text, p_day date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); PERFORM _space_need(p_actor, p_space, ARRAY['owner','accountant','contributor'], true);
  IF p_kind NOT IN ('income','expense') THEN PERFORM _err('invalid_input', 'Type invalide'); END IF;
  PERFORM _space_check_tx(p_space, p_account, p_kind, p_amount, p_category, v_note, p_day);
  INSERT INTO pf_space_tx(space_id, account_id, kind, amount, category, note, occurred_on, author_id) VALUES (p_space, p_account, p_kind, p_amount, p_category, v_note, p_day, p_actor) RETURNING id INTO v_id;
  PERFORM _space_log(p_space, p_actor, 'tx_add', p_kind || ' ' || p_amount || ' · ' || p_category);
  RETURN v_id;
END $$;

CREATE FUNCTION fn_pf_space_tx_update(p_actor uuid, p_space uuid, p_id uuid, p_account uuid, p_amount bigint, p_category text, p_note text, p_day date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_role text; t pf_space_tx%ROWTYPE; v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); v_role := _space_need(p_actor, p_space, ARRAY['owner','accountant','contributor'], true);
  SELECT * INTO t FROM pf_space_tx WHERE id = p_id AND space_id = p_space AND voided_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Transaction introuvable'); END IF;
  IF t.kind NOT IN ('income','expense') THEN PERFORM _err('invalid_state', 'Un virement ne se modifie pas : annulez-le et refaites-le'); END IF;
  IF v_role = 'contributor' AND t.author_id <> p_actor THEN PERFORM _err('forbidden', 'Vous ne pouvez modifier que ce que vous avez saisi'); END IF;
  PERFORM _space_check_tx(p_space, p_account, t.kind, p_amount, p_category, v_note, p_day);
  UPDATE pf_space_tx SET account_id = p_account, amount = p_amount, category = p_category, note = v_note, occurred_on = p_day WHERE id = p_id;
  PERFORM _space_log(p_space, p_actor, 'tx_edit', t.kind || ' ' || p_amount || ' · ' || p_category);
END $$;

CREATE FUNCTION fn_pf_space_tx_void(p_actor uuid, p_space uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_role text; t pf_space_tx%ROWTYPE;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); v_role := _space_need(p_actor, p_space, ARRAY['owner','accountant','contributor'], true);
  SELECT * INTO t FROM pf_space_tx WHERE id = p_id AND space_id = p_space AND voided_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Transaction introuvable'); END IF;
  IF v_role = 'contributor' AND (t.author_id <> p_actor OR t.kind NOT IN ('income','expense')) THEN PERFORM _err('forbidden', 'Vous ne pouvez annuler que ce que vous avez saisi'); END IF;
  IF t.transfer_id IS NOT NULL THEN
    UPDATE pf_space_tx SET voided_at = now(), voided_by = p_actor WHERE transfer_id = t.transfer_id AND space_id = p_space AND voided_at IS NULL;
  ELSE
    UPDATE pf_space_tx SET voided_at = now(), voided_by = p_actor WHERE id = p_id;
  END IF;
  PERFORM _space_log(p_space, p_actor, 'tx_void', t.kind || ' ' || t.amount || ' · ' || t.category);
END $$;

CREATE FUNCTION fn_pf_space_transfer(p_actor uuid, p_space uuid, p_from uuid, p_to uuid, p_amount bigint, p_note text, p_day date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_tid uuid := gen_random_uuid(); v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _space_on(); PERFORM _space_need(p_actor, p_space, ARRAY['owner','accountant'], true);
  IF p_from = p_to THEN PERFORM _err('invalid_input', 'Choisissez deux comptes différents'); END IF;
  PERFORM _space_check_tx(p_space, p_from, 'transfer_out', p_amount, 'transfer', v_note, p_day);
  PERFORM _space_check_tx(p_space, p_to, 'transfer_in', p_amount, 'transfer', v_note, p_day);
  INSERT INTO pf_space_tx(space_id, account_id, kind, amount, category, note, occurred_on, transfer_id, author_id) VALUES
    (p_space, p_from, 'transfer_out', p_amount, 'transfer', v_note, p_day, v_tid, p_actor),
    (p_space, p_to,   'transfer_in',  p_amount, 'transfer', v_note, p_day, v_tid, p_actor);
  PERFORM _space_log(p_space, p_actor, 'transfer', p_amount::text);
  RETURN v_tid;
END $$;

-- Compte anonymisé : il quitte les espaces où il est membre ; ses espaces sont archivés (rien n'est supprimé)
CREATE FUNCTION trg_pf_space_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pf_space_members SET status = 'left', responded_at = now() WHERE user_id = NEW.id AND status IN ('active','invited') AND role <> 'owner';
  UPDATE pf_spaces SET archived_at = COALESCE(archived_at, now()) WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_pf_space_anonymized() SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER users_pf_space_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_space_anonymized();

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
