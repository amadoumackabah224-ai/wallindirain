-- RETOUR ARRIÈRE de la migration 037 (comptes de vendeurs de l'étranger). JAMAIS AUTOMATIQUE.
-- REFUSE de s'exécuter si un compte avec numéro étranger ou des coordonnées de versement « autre » existent déjà : on ne perd pas ces comptes.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE phone LIKE '+%' OR payout_method = 'other') OR EXISTS (SELECT 1 FROM withdrawals WHERE method = 'other')
     OR EXISTS (SELECT 1 FROM data_requests WHERE phone LIKE '+%') OR EXISTS (SELECT 1 FROM support_threads WHERE phone LIKE '+%') THEN
    RAISE EXCEPTION 'Retour arrière refusé : des comptes ou des données avec numéro étranger existent (à conserver)';
  END IF;
END $$;
ALTER TABLE support_threads DROP CONSTRAINT support_threads_phone_ok;
ALTER TABLE support_threads ADD CONSTRAINT support_threads_phone_check CHECK (phone ~ '^[0-9]{9}$');
ALTER TABLE data_requests DROP CONSTRAINT data_requests_phone_ok;
ALTER TABLE data_requests ADD CONSTRAINT data_requests_phone_check CHECK (phone ~ '^[0-9]{9}$');
ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_payout_ok;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_method_check CHECK (method IN ('orange_money','mtn_momo'));
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_account_number_check CHECK (account_number ~ '^[0-9]{9}$');
ALTER TABLE users DROP CONSTRAINT users_payout_ok;
ALTER TABLE users ADD CONSTRAINT users_payout_method_check CHECK (payout_method IN ('orange_money','mtn_momo'));
ALTER TABLE users ADD CONSTRAINT users_payout_phone_check CHECK (payout_phone ~ '^[0-9]{9}$');
ALTER TABLE users DROP CONSTRAINT users_phone_ok;
ALTER TABLE users ADD CONSTRAINT users_phone_check CHECK (phone ~ '^[0-9]{9}$' OR role = 'system');

CREATE OR REPLACE FUNCTION fn_register(p_phone text, p_name text, p_role user_role, p_password_hash text, p_identity_doc text,
                            p_payout_method text DEFAULT NULL, p_payout_phone text DEFAULT NULL, p_terms_version text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_doc text := NULLIF(trim(COALESCE(p_identity_doc, '')), '');
BEGIN
  IF p_role NOT IN ('seller','supplier') THEN
    PERFORM _err('invalid_role', 'Inscription ouverte aux vendeurs et fournisseurs uniquement');
  END IF;
  -- vendeur et fournisseur : aucune pièce à l'inscription ; elle est demandée au premier retrait (ou plus tard, une fois le compte validé)
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

CREATE OR REPLACE FUNCTION fn_set_payout(p_actor uuid, p_method text, p_phone text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier']::user_role[]);
  IF u.payout_phone IS NOT NULL THEN
    PERFORM _err('payout_locked', 'Numéro de versement déjà enregistré : contactez l''administration pour le modifier');
  END IF;
  IF p_method NOT IN ('orange_money','mtn_momo') OR p_phone IS NULL OR p_phone !~ '^[0-9]{9}$' THEN
    PERFORM _err('invalid_input', 'Opérateur ou numéro de versement invalide');
  END IF;
  UPDATE users SET payout_method = p_method, payout_phone = p_phone WHERE id = p_actor;
  PERFORM _audit(p_actor, 'payout_set', 'user', p_actor::text, jsonb_build_object('method', p_method));
END $$;

CREATE OR REPLACE FUNCTION fn_change_payout(p_actor uuid, p_method text, p_phone text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier']::user_role[]);
  IF p_method NOT IN ('orange_money','mtn_momo') OR p_phone IS NULL OR p_phone !~ '^[0-9]{9}$' THEN
    PERFORM _err('invalid_input', 'Opérateur ou numéro de versement invalide');
  END IF;
  IF u.payout_phone = p_phone AND u.payout_method = p_method THEN PERFORM _err('invalid_input', 'C''est déjà votre numéro de versement'); END IF;
  IF EXISTS (SELECT 1 FROM withdrawals WHERE user_id = p_actor AND status = 'requested') THEN
    PERFORM _err('invalid_state', 'Un retrait est en attente : attendez qu''il soit payé avant de changer de numéro');
  END IF;
  UPDATE users SET payout_method = p_method, payout_phone = p_phone WHERE id = p_actor;
  IF u.payout_phone IS NOT NULL THEN
    PERFORM _queue_message(u.payout_phone, 'payout_changed',
      'Wallindirain : le numéro de versement de votre compte a été modifié. Si ce n''est pas vous, appelez-nous tout de suite.');
  END IF;
  PERFORM _audit(p_actor, 'payout_changed', 'user', p_actor::text, jsonb_build_object('method', p_method));
END $$;

CREATE OR REPLACE FUNCTION fn_withdrawal_request(p_actor uuid, p_amount bigint, p_method text DEFAULT NULL, p_account text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE u users; v_id uuid := gen_random_uuid(); v_min bigint;
BEGIN
  u := _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier']::user_role[]);
  IF NOT u.identity_verified THEN
    PERFORM _err('identity_required', 'Identité non vérifiée : retrait impossible');
  END IF;
  IF u.payout_phone IS NOT NULL THEN
    p_method := u.payout_method; p_account := u.payout_phone;
  ELSIF p_method IS NULL OR p_account IS NULL THEN
    PERFORM _err('payout_missing', 'Aucun numéro de versement enregistré : renseignez-le dans votre profil');
  END IF;
  v_min := _setting('min_withdrawal');
  IF p_amount IS NULL OR p_amount < v_min THEN PERFORM _err('below_minimum', 'Retrait minimum : ' || v_min || ' GNF'); END IF;
  IF p_method NOT IN ('orange_money','mtn_momo') THEN PERFORM _err('invalid_input', 'Mode de paiement invalide'); END IF;
  IF p_account !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro de paiement invalide (9 chiffres)'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wallet:' || p_actor::text));
  IF _wallet_free(p_actor) < p_amount THEN PERFORM _err('insufficient_funds', 'Solde disponible insuffisant (les retraits en attente sont déjà réservés)'); END IF;
  INSERT INTO withdrawals(id, user_id, amount, method, account_number, status) VALUES (v_id, p_actor, p_amount, p_method, p_account, 'requested');
  PERFORM _audit(p_actor, 'withdrawal_requested', 'withdrawal', v_id::text, jsonb_build_object('amount', p_amount));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION fn_record_consent(p_kind text, p_user uuid, p_phone text, p_version text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_version IS NULL OR length(p_version) < 4 THEN PERFORM _err('invalid_input', 'Version des conditions manquante'); END IF;
  IF p_user IS NULL AND (p_phone IS NULL OR p_phone !~ '^[0-9]{9}$') THEN PERFORM _err('invalid_input', 'Numéro invalide'); END IF;
  INSERT INTO consents(kind, user_id, subject_hash, version)
  VALUES (p_kind, p_user, CASE WHEN p_user IS NULL THEN encode(digest(p_phone, 'sha256'), 'hex') END, p_version);
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

DELETE FROM schema_migrations WHERE name = '037_comptes_etrangers.sql';
COMMIT;
