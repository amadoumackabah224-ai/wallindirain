-- =====================================================================
-- Migration 007 : protection des données personnelles
--   * preuves de consentement (sans conserver le numéro des clients : seulement son empreinte)
--   * demandes des personnes (accès, rectification, suppression, opposition)
--   * anonymisation d'un compte, purge automatique des données périmées
--   * pièce d'identité demandée seulement quand elle est nécessaire (fournisseurs : à l'inscription ; vendeurs : avant le premier retrait)
-- =====================================================================

-- ---------- Consentements ----------
CREATE TABLE consents (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('register','order')),
  user_id      uuid REFERENCES users(id),
  subject_hash text,                          -- empreinte SHA-256 du numéro d'un client (le numéro lui-même n'est pas conservé ici)
  version      text NOT NULL,                 -- version des conditions et de la politique acceptées
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NOT NULL) <> (subject_hash IS NOT NULL))
);
CREATE TRIGGER consents_immutable BEFORE UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION trg_append_only();

CREATE FUNCTION fn_record_consent(p_kind text, p_user uuid, p_phone text, p_version text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_version IS NULL OR length(p_version) < 4 THEN PERFORM _err('invalid_input', 'Version des conditions manquante'); END IF;
  IF p_user IS NULL AND (p_phone IS NULL OR p_phone !~ '^[0-9]{9}$') THEN PERFORM _err('invalid_input', 'Numéro invalide'); END IF;
  INSERT INTO consents(kind, user_id, subject_hash, version)
  VALUES (p_kind, p_user, CASE WHEN p_user IS NULL THEN encode(digest(p_phone, 'sha256'), 'hex') END, p_version);
END $$;

-- ---------- Inscription : pièce d'identité seulement pour les fournisseurs ; consentement enregistré dans la même transaction ----------
DROP FUNCTION fn_register(text, text, user_role, text, text, text, text);
CREATE FUNCTION fn_register(p_phone text, p_name text, p_role user_role, p_password_hash text, p_identity_doc text,
                            p_payout_method text DEFAULT NULL, p_payout_phone text DEFAULT NULL, p_terms_version text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_doc text := NULLIF(trim(COALESCE(p_identity_doc, '')), '');
BEGIN
  IF p_role NOT IN ('seller','supplier') THEN
    PERFORM _err('invalid_role', 'Inscription ouverte aux vendeurs et fournisseurs uniquement');
  END IF;
  -- fournisseur : pièce obligatoire (validation du compte) ; vendeur : demandée plus tard, avant son premier retrait
  IF p_role = 'supplier' AND (v_doc IS NULL OR length(v_doc) < 4) THEN
    PERFORM _err('identity_required', 'La pièce d''identité est obligatoire pour un fournisseur');
  END IF;
  IF v_doc IS NOT NULL AND length(v_doc) < 4 THEN PERFORM _err('invalid_input', 'Pièce d''identité invalide'); END IF;
  IF (p_payout_method IS NULL) <> (p_payout_phone IS NULL) THEN
    PERFORM _err('invalid_input', 'Indiquez l''opérateur et le numéro de versement');
  END IF;
  BEGIN
    INSERT INTO users(role, status, full_name, phone, password_hash, identity_doc, payout_method, payout_phone)
    VALUES (p_role, CASE WHEN p_role = 'supplier' THEN 'pending'::user_status ELSE 'active'::user_status END,
            trim(p_name), p_phone, p_password_hash, v_doc, p_payout_method, p_payout_phone)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN PERFORM _err('phone_taken', 'Ce numéro est déjà inscrit');
    WHEN check_violation  THEN PERFORM _err('invalid_input', 'Nom, numéro ou numéro de versement invalide (9 chiffres attendus)');
  END;
  IF p_terms_version IS NOT NULL THEN PERFORM fn_record_consent('register', v_id, NULL, p_terms_version); END IF;
  PERFORM _audit(v_id, 'register', 'user', v_id::text, jsonb_build_object('role', p_role));
  RETURN v_id;
END $$;

-- Le vendeur (ou le fournisseur) ajoute sa pièce d'identité quand il en a besoin ; elle est figée une fois vérifiée
CREATE FUNCTION fn_set_identity_doc(p_actor uuid, p_doc text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, ARRAY['seller','supplier']::user_role[]);
  IF u.identity_verified THEN PERFORM _err('identity_locked', 'Pièce déjà vérifiée : contactez l''administration pour la modifier'); END IF;
  IF p_doc IS NULL OR length(trim(p_doc)) < 4 OR length(trim(p_doc)) > 60 THEN PERFORM _err('invalid_input', 'Pièce d''identité invalide'); END IF;
  UPDATE users SET identity_doc = trim(p_doc) WHERE id = p_actor;
  PERFORM _audit(p_actor, 'identity_doc_set', 'user', p_actor::text);
END $$;

-- ---------- Demandes des personnes sur leurs données ----------
CREATE TABLE data_requests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('access','rectification','erasure','opposition')),
  full_name  text NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 100),
  phone      text NOT NULL CHECK (phone ~ '^[0-9]{9}$'),
  message    text CHECK (message IS NULL OR length(message) <= 1000),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','rejected')),
  handled_by uuid REFERENCES users(id),
  handled_at timestamptz,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_requests_status_idx ON data_requests(status);
-- Suppression interdite, sauf par la purge automatique de conservation (fn_purge_old_data)
CREATE FUNCTION trg_data_requests_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('wld.purge', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'table data_requests : suppression interdite hors purge de conservation' USING ERRCODE = '23000';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER data_requests_no_delete BEFORE DELETE ON data_requests FOR EACH ROW EXECUTE FUNCTION trg_data_requests_delete();

CREATE FUNCTION fn_data_request_create(p_kind text, p_name text, p_phone text, p_message text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_kind NOT IN ('access','rectification','erasure','opposition') THEN PERFORM _err('invalid_input', 'Type de demande invalide'); END IF;
  IF (SELECT count(*) FROM data_requests WHERE phone = p_phone AND status = 'open') >= 3 THEN
    PERFORM _err('too_many', 'Des demandes sont déjà en cours pour ce numéro : nous y répondons dès que possible');
  END IF;
  BEGIN
    INSERT INTO data_requests(kind, full_name, phone, message) VALUES (p_kind, trim(p_name), p_phone, NULLIF(trim(COALESCE(p_message, '')), ''))
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Nom, numéro ou message invalide');
  END;
  PERFORM _audit(NULL, 'data_request', 'data_request', v_id::text, jsonb_build_object('kind', p_kind));
  RETURN v_id;
END $$;

CREATE FUNCTION fn_admin_close_data_request(p_actor uuid, p_request uuid, p_status text, p_note text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_status NOT IN ('done','rejected') THEN PERFORM _err('invalid_input', 'Statut invalide'); END IF;
  IF p_note IS NULL OR length(trim(p_note)) < 3 THEN PERFORM _err('invalid_input', 'Indiquez ce qui a été fait ou le motif du refus'); END IF;
  UPDATE data_requests SET status = p_status, note = trim(p_note), handled_by = p_actor, handled_at = now() WHERE id = p_request AND status = 'open';
  IF NOT FOUND THEN PERFORM _err('invalid_state', 'Demande introuvable ou déjà traitée'); END IF;
  PERFORM _audit(p_actor, 'data_request_closed', 'data_request', p_request::text, jsonb_build_object('status', p_status));
END $$;

-- ---------- Anonymisation d'un compte (droit à l'effacement) ----------
-- Efface les données d'identification ; les écritures comptables restent, sans nom. Refusée tant qu'il reste de l'argent ou une opération en cours.
CREATE FUNCTION fn_admin_anonymize_user(p_actor uuid, p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users; v_phone text;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO u FROM users WHERE id = p_user AND deleted_at IS NULL AND role <> 'system' FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  IF u.id = p_actor THEN PERFORM _err('invalid_state', 'Vous ne pouvez pas anonymiser votre propre compte'); END IF;
  IF u.role = 'admin' THEN PERFORM _err('invalid_state', 'Un compte administrateur ne s''anonymise pas : suspendez-le'); END IF;
  IF COALESCE((SELECT sum(amount) FROM wallet_entries WHERE user_id = u.id), 0) <> 0 THEN
    PERFORM _err('balance_not_zero', 'Le portefeuille n''est pas à zéro : soldez-le (retrait ou régularisation) avant d''anonymiser');
  END IF;
  IF EXISTS (SELECT 1 FROM withdrawals WHERE user_id = u.id AND status IN ('pending_code','requested')) THEN
    PERFORM _err('invalid_state', 'Un retrait est encore en cours');
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE (seller_id = u.id OR courier_id = u.id)
             AND status IN ('new','in_call','confirmed','assigned','picked_up','on_the_way','failed','return_pending')) THEN
    PERFORM _err('invalid_state', 'Des commandes sont encore en cours pour ce compte');
  END IF;
  IF EXISTS (SELECT 1 FROM courier_cash_entries WHERE courier_id = u.id AND count_id IS NULL) THEN
    PERFORM _err('invalid_state', 'Une caisse de ce livreur n''est pas encore comptée');
  END IF;
  IF EXISTS (SELECT 1 FROM products WHERE supplier_id = u.id AND deleted_at IS NULL AND status = 'approved') THEN
    PERFORM _err('invalid_state', 'Ce fournisseur a encore des produits en vente : retirez-les d''abord');
  END IF;
  LOOP
    v_phone := '000' || lpad((floor(random() * 1000000))::int::text, 6, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE phone = v_phone);
  END LOOP;
  DELETE FROM messages WHERE to_phone = u.phone;
  UPDATE users SET full_name = 'Compte supprimé', phone = v_phone, password_hash = encode(gen_random_bytes(32), 'hex'),
         identity_doc = NULL, identity_verified = false, payout_method = NULL, payout_phone = NULL, team = NULL,
         status = 'suspended', deleted_at = now(), failed_attempts = 0, locked_until = NULL
   WHERE id = u.id;
  DELETE FROM sessions WHERE user_id = u.id;
  DELETE FROM one_time_codes WHERE user_id = u.id;
  PERFORM _audit(p_actor, 'user_anonymized', 'user', u.id::text, jsonb_build_object('role', u.role));
END $$;

-- ---------- Purge automatique (appelée toutes les quelques heures par le serveur) ----------
-- Les commandes closes depuis plus de 5 ans perdent le nom, le téléphone et l'adresse du client (montants et références conservés).
CREATE OR REPLACE FUNCTION trg_orders_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sale_total          IS DISTINCT FROM OLD.sale_total
  OR NEW.supplier_unit_price IS DISTINCT FROM OLD.supplier_unit_price
  OR NEW.margin_unit         IS DISTINCT FROM OLD.margin_unit
  OR NEW.seller_unit_price   IS DISTINCT FROM OLD.seller_unit_price
  OR NEW.delivery_fee        IS DISTINCT FROM OLD.delivery_fee
  OR NEW.call_fee            IS DISTINCT FROM OLD.call_fee
  OR NEW.agent_pay           IS DISTINCT FROM OLD.agent_pay
  OR NEW.courier_pay         IS DISTINCT FROM OLD.courier_pay
  OR NEW.unlock_hours        IS DISTINCT FROM OLD.unlock_hours
  OR NEW.delivery_code_hash  IS DISTINCT FROM OLD.delivery_code_hash
  OR NEW.qty                 IS DISTINCT FROM OLD.qty
  OR NEW.seller_id           IS DISTINCT FROM OLD.seller_id
  OR NEW.product_id          IS DISTINCT FROM OLD.product_id
  OR NEW.formula             IS DISTINCT FROM OLD.formula
  OR NEW.commune             IS DISTINCT FROM OLD.commune
  OR (NEW.customer_phone     IS DISTINCT FROM OLD.customer_phone AND COALESCE(current_setting('wld.purge', true), '') <> '1') THEN
    RAISE EXCEPTION 'montants et identité de la commande figés après création'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION fn_purge_old_data() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_sessions int; v_codes int; v_messages int; v_risky int; v_orders int; v_requests int;
BEGIN
  DELETE FROM sessions WHERE expires_at < now();                                             GET DIAGNOSTICS v_sessions = ROW_COUNT;
  DELETE FROM one_time_codes WHERE expires_at < now() - interval '7 days'
                                OR (used_at IS NOT NULL AND used_at < now() - interval '7 days'); GET DIAGNOSTICS v_codes = ROW_COUNT;
  DELETE FROM messages WHERE created_at < now() - interval '90 days';                        GET DIAGNOSTICS v_messages = ROW_COUNT;
  DELETE FROM risky_customers WHERE updated_at < now() - interval '24 months';               GET DIAGNOSTICS v_risky = ROW_COUNT;
  PERFORM set_config('wld.purge', '1', true);
  DELETE FROM data_requests WHERE status <> 'open' AND handled_at < now() - interval '1 year'; GET DIAGNOSTICS v_requests = ROW_COUNT;
  UPDATE orders SET customer_name = 'Client anonymisé', customer_phone = '000000000', address = 'Adresse supprimée', note = NULL
   WHERE closed_at IS NOT NULL AND closed_at < now() - interval '5 years' AND customer_phone <> '000000000';
  GET DIAGNOSTICS v_orders = ROW_COUNT;
  RETURN jsonb_build_object('sessions', v_sessions, 'codes', v_codes, 'messages', v_messages, 'risky_customers', v_risky, 'data_requests', v_requests, 'orders_anonymized', v_orders);
END $$;

-- ---------- Droits (mêmes règles que les migrations 004 et 005) ----------
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
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash')
       AND NOT (r.relname = 'proofs' AND column_name = 'data');
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
