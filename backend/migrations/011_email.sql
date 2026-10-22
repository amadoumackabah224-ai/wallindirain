-- =====================================================================
-- Migration 011 : adresse e-mail (connexion et mot de passe oublié) et envoi d'e-mails.
--  - chaque personne peut enregistrer une adresse e-mail ; elle doit être VÉRIFIÉE par un code reçu dans la boîte
--  - connexion avec le numéro OU l'adresse e-mail vérifiée
--  - le code de réinitialisation du mot de passe part par e-mail quand une adresse vérifiée existe
--  - les e-mails passent par la même file que les messages (table messages, canal « email »)
-- =====================================================================
ALTER TABLE users ADD COLUMN email text CHECK (email IS NULL OR (email = lower(email) AND length(email) <= 254 AND email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'));
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
-- une adresse VÉRIFIÉE n'appartient qu'à un seul compte (une adresse non vérifiée ne bloque personne)
CREATE UNIQUE INDEX users_email_verified_uq ON users (email) WHERE email_verified_at IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE one_time_codes DROP CONSTRAINT one_time_codes_purpose_check;
ALTER TABLE one_time_codes ADD CONSTRAINT one_time_codes_purpose_check CHECK (purpose IN ('password_reset','withdrawal','email_verify'));

-- ---------- File d'envoi : les e-mails utilisent la table messages ----------
ALTER TABLE messages ALTER COLUMN to_phone DROP NOT NULL;
ALTER TABLE messages ADD COLUMN to_email text;
ALTER TABLE messages ADD COLUMN subject text;
ALTER TABLE messages ADD CONSTRAINT messages_dest_check CHECK (to_phone IS NOT NULL OR to_email IS NOT NULL);

CREATE FUNCTION _queue_email(p_to text, p_template text, p_subject text, p_body text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO messages(to_phone, to_email, channel, template, subject, body) VALUES (NULL, p_to, 'email', p_template, p_subject, p_body)
$$;

DROP FUNCTION fn_messages_claim(int);
CREATE FUNCTION fn_messages_claim(p_limit int DEFAULT 20)
RETURNS TABLE(id bigint, to_phone text, to_email text, channel text, template text, subject text, body text, order_id uuid)
LANGUAGE sql AS $$
  SELECT m.id, m.to_phone, m.to_email, m.channel, m.template, m.subject, m.body, m.order_id
  FROM messages m WHERE m.status = 'queued' ORDER BY m.id LIMIT p_limit FOR UPDATE SKIP LOCKED
$$;

-- une fois réellement envoyé, un code n'est plus conservé en clair
CREATE OR REPLACE FUNCTION fn_message_mark(p_id bigint, p_status text, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_status NOT IN ('sent','simulated','failed','queued') THEN PERFORM _err('invalid_input', 'Statut de message invalide'); END IF;
  UPDATE messages SET status = p_status, error = p_error,
         sent_at = CASE WHEN p_status IN ('sent','simulated') THEN now() END,
         body = CASE WHEN p_status = 'sent' THEN
                  CASE template
                    WHEN 'delivery_code'   THEN regexp_replace(body, '(Code de livraison : )\d{4}', '\1••••')
                    WHEN 'withdrawal_code' THEN regexp_replace(body, '(GNF : )\d{6}', '\1••••')
                    WHEN 'password_reset'  THEN regexp_replace(body, '(est )\d{6}', '\1••••')
                    WHEN 'password_reset_email' THEN regexp_replace(body, '(est )\d{6}', '\1••••')
                    WHEN 'email_verify'    THEN regexp_replace(body, '(est )\d{6}', '\1••••')
                    WHEN 'temp_password'   THEN regexp_replace(body, '(temporaire est : )\S+', '\1••••••••')
                    ELSE body END
                ELSE body END
   WHERE id = p_id;
END $$;

-- ---------- Retrouver un compte par numéro OU par e-mail vérifié ----------
CREATE FUNCTION _user_id_by_identifier(p_identifier text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM users
   WHERE deleted_at IS NULL AND role <> 'system'
     AND CASE WHEN position('@' in COALESCE(p_identifier, '')) > 0
              THEN email = lower(trim(p_identifier)) AND email_verified_at IS NOT NULL
              ELSE phone = trim(p_identifier) END
   LIMIT 1
$$;

DROP FUNCTION fn_login_lookup(text);
CREATE FUNCTION fn_login_lookup(p_identifier text)
RETURNS TABLE(id uuid, password_hash text, role user_role, status user_status, full_name text)
LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  SELECT x.* INTO u FROM users x WHERE x.id = _user_id_by_identifier(p_identifier);
  IF NOT FOUND THEN RETURN; END IF;
  IF u.locked_until IS NOT NULL AND u.locked_until > now() THEN
    PERFORM _err('locked', 'Compte bloqué 15 minutes après trop d''échecs. Réessayez plus tard.');
  END IF;
  RETURN QUERY SELECT u.id, u.password_hash, u.role, u.status, u.full_name;
END $$;

DROP FUNCTION fn_login_failed(text);
CREATE FUNCTION fn_login_failed(p_identifier text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE id = _user_id_by_identifier(p_identifier) FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF u.failed_attempts + 1 >= 5 THEN
    UPDATE users SET failed_attempts = 0, locked_until = now() + interval '15 minutes' WHERE id = u.id;
    PERFORM _audit(u.id, 'login_locked', 'user', u.id::text);
  ELSE
    UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = u.id;
  END IF;
END $$;

-- la session renvoie aussi l'e-mail et son état
DROP FUNCTION fn_session_user(text);
CREATE FUNCTION fn_session_user(p_token_hash text)
RETURNS TABLE(id uuid, role user_role, full_name text, phone text, team text, identity_verified boolean, email text, email_verified boolean)
LANGUAGE sql STABLE AS $$
  SELECT u.id, u.role, u.full_name, u.phone, u.team, u.identity_verified, u.email, u.email_verified_at IS NOT NULL
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash AND s.expires_at > now()
    AND u.status = 'active' AND u.deleted_at IS NULL
$$;

-- ---------- Mot de passe oublié : par e-mail si une adresse vérifiée existe, sinon par message au numéro ----------
DROP FUNCTION fn_password_reset_request(text);
CREATE FUNCTION fn_password_reset_request(p_identifier text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users; v_id uuid := gen_random_uuid(); v_code text;
BEGIN
  SELECT * INTO u FROM users WHERE id = _user_id_by_identifier(p_identifier) AND status <> 'suspended';
  IF NOT FOUND THEN RETURN; END IF;                       -- pas de fuite d'information
  UPDATE one_time_codes SET used_at = now() WHERE user_id = u.id AND purpose = 'password_reset' AND used_at IS NULL;
  v_code := _rand_digits(6);
  INSERT INTO one_time_codes(id, user_id, purpose, code_hash, expires_at)
  VALUES (v_id, u.id, 'password_reset', _code_hash(v_code, v_id), now() + interval '15 minutes');
  IF u.email IS NOT NULL AND u.email_verified_at IS NOT NULL THEN
    PERFORM _queue_email(u.email, 'password_reset_email', 'Wallindirain : votre code pour changer de mot de passe',
      'Bonjour ' || split_part(u.full_name, ' ', 1) || E',\n\nVotre code de réinitialisation est ' || v_code || E'. Il expire dans 15 minutes.\n\n'
      || E'Si vous n''avez pas demandé ce code, ignorez ce message : votre mot de passe ne change pas. Ne communiquez jamais ce code à personne, pas même à l''équipe Wallindirain.');
  ELSE
    PERFORM _queue_message(u.phone, 'password_reset', 'Wallindirain : votre code de réinitialisation est ' || v_code || '. Il expire dans 15 minutes.');
  END IF;
END $$;

DROP FUNCTION fn_password_reset_confirm(text, text, text);
CREATE FUNCTION fn_password_reset_confirm(p_identifier text, p_code text, p_new_hash text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; c one_time_codes;
BEGIN
  SELECT * INTO u FROM users WHERE id = _user_id_by_identifier(p_identifier);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid'); END IF;
  SELECT * INTO c FROM one_time_codes
   WHERE user_id = u.id AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR c.attempts >= 5 THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid'); END IF;
  IF c.code_hash <> _code_hash(p_code, c.id) THEN
    UPDATE one_time_codes SET attempts = attempts + 1 WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  UPDATE one_time_codes SET used_at = now() WHERE id = c.id;
  UPDATE users SET password_hash = p_new_hash, failed_attempts = 0, locked_until = NULL WHERE id = u.id;
  DELETE FROM sessions WHERE user_id = u.id;
  PERFORM _audit(u.id, 'password_reset', 'user', u.id::text);
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------- Enregistrer et vérifier son adresse e-mail ----------
CREATE FUNCTION _email_send_code(p_user users) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_code text := _rand_digits(6);
BEGIN
  UPDATE one_time_codes SET used_at = now() WHERE user_id = p_user.id AND purpose = 'email_verify' AND used_at IS NULL;
  INSERT INTO one_time_codes(id, user_id, purpose, code_hash, expires_at)
  VALUES (v_id, p_user.id, 'email_verify', _code_hash(v_code, v_id), now() + interval '30 minutes');
  PERFORM _queue_email(p_user.email, 'email_verify', 'Wallindirain : confirmez votre adresse e-mail',
    'Bonjour ' || split_part(p_user.full_name, ' ', 1) || E',\n\nVotre code de vérification est ' || v_code || E'. Il expire dans 30 minutes.\n\n'
    || E'Saisissez-le dans l''application (Profil > Adresse e-mail) pour pouvoir vous connecter avec cette adresse et recevoir vos codes par e-mail.\n\n'
    || E'Si vous n''êtes pas à l''origine de cette demande, ignorez ce message.');
END $$;

CREATE FUNCTION _email_normalize(p_email text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE e text := lower(trim(COALESCE(p_email, '')));
BEGIN
  IF length(e) > 254 OR e !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' THEN PERFORM _err('invalid_input', 'Adresse e-mail invalide'); END IF;
  RETURN e;
END $$;

-- après l'inscription : l'adresse est enregistrée (non vérifiée) et un code est envoyé
CREATE FUNCTION fn_register_email(p_user uuid, p_email text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users; e text := _email_normalize(p_email);
BEGIN
  SELECT * INTO u FROM users WHERE id = p_user AND deleted_at IS NULL AND email IS NULL AND created_at > now() - interval '10 minutes' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE users SET email = e WHERE id = u.id RETURNING * INTO u;
  PERFORM _email_send_code(u);
END $$;

CREATE FUNCTION fn_email_set(p_actor uuid, p_email text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users; e text := _email_normalize(p_email); v_old text; v_was_verified boolean;
BEGIN
  u := _require(p_actor, ARRAY['admin','seller','supplier','agent','call_chief','courier','warehouse']::user_role[]);
  IF u.email = e AND u.email_verified_at IS NOT NULL THEN RETURN; END IF;
  v_old := u.email; v_was_verified := u.email_verified_at IS NOT NULL;
  UPDATE users SET email = e, email_verified_at = NULL WHERE id = u.id RETURNING * INTO u;
  IF v_was_verified AND v_old IS DISTINCT FROM e THEN   -- alerte sur l'ancienne adresse
    PERFORM _queue_email(v_old, 'email_changed', 'Wallindirain : votre adresse e-mail a été changée',
      E'Bonjour,\n\nL''adresse e-mail de votre compte Wallindirain vient d''être remplacée. Si ce n''est pas vous, contactez immédiatement Wallindirain.');
  END IF;
  PERFORM _email_send_code(u);
  PERFORM _audit(p_actor, 'email_set', 'user', p_actor::text);
END $$;

CREATE FUNCTION fn_email_resend(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, ARRAY['admin','seller','supplier','agent','call_chief','courier','warehouse']::user_role[]);
  IF u.email IS NULL THEN PERFORM _err('invalid_state', 'Aucune adresse e-mail enregistrée'); END IF;
  IF u.email_verified_at IS NOT NULL THEN PERFORM _err('invalid_state', 'Adresse déjà vérifiée'); END IF;
  PERFORM _email_send_code(u);
END $$;

CREATE FUNCTION fn_email_verify(p_actor uuid, p_code text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; c one_time_codes;
BEGIN
  u := _require(p_actor, ARRAY['admin','seller','supplier','agent','call_chief','courier','warehouse']::user_role[]);
  IF u.email IS NULL OR u.email_verified_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_verify'); END IF;
  SELECT * INTO c FROM one_time_codes
   WHERE user_id = u.id AND purpose = 'email_verify' AND used_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR c.attempts >= 5 THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid'); END IF;
  IF c.code_hash <> _code_hash(COALESCE(p_code, ''), c.id) THEN
    UPDATE one_time_codes SET attempts = attempts + 1 WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE email = u.email AND email_verified_at IS NOT NULL AND deleted_at IS NULL AND id <> u.id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'taken');
  END IF;
  UPDATE one_time_codes SET used_at = now() WHERE id = c.id;
  UPDATE users SET email_verified_at = now() WHERE id = u.id;
  PERFORM _audit(p_actor, 'email_verified', 'user', p_actor::text);
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------- Anonymisation : l'e-mail et les e-mails envoyés sont effacés ----------
CREATE OR REPLACE FUNCTION trg_user_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    DELETE FROM avatars WHERE user_id = NEW.id;
    DELETE FROM identity_documents WHERE user_id = NEW.id;
    DELETE FROM support_messages WHERE thread_id IN (SELECT id FROM support_threads WHERE user_id = NEW.id);
    DELETE FROM support_threads WHERE user_id = NEW.id;
    IF NEW.email IS NOT NULL THEN DELETE FROM messages WHERE to_email = NEW.email; END IF;
    UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

-- mot de passe temporaire envoyé par l'administration : par e-mail si une adresse vérifiée existe
CREATE OR REPLACE FUNCTION fn_admin_send_temp_password(p_actor uuid, p_user uuid, p_new_hash text, p_plain text, p_thread uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users; v_text text;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO u FROM users WHERE id = p_user AND deleted_at IS NULL AND role <> 'system' FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  UPDATE users SET password_hash = p_new_hash, failed_attempts = 0, locked_until = NULL WHERE id = u.id;
  DELETE FROM sessions WHERE user_id = u.id;
  v_text := 'Wallindirain : votre mot de passe temporaire est : ' || p_plain || ' . Connectez-vous puis changez-le dans Profil.';
  IF u.email IS NOT NULL AND u.email_verified_at IS NOT NULL THEN
    PERFORM _queue_email(u.email, 'temp_password', 'Wallindirain : votre mot de passe temporaire', v_text);
  ELSE
    PERFORM _queue_message(u.phone, 'temp_password', v_text);
  END IF;
  IF p_thread IS NOT NULL THEN
    INSERT INTO support_messages(thread_id, sender, body) VALUES (p_thread, 'admin',
      CASE WHEN u.email IS NOT NULL AND u.email_verified_at IS NOT NULL THEN 'Un mot de passe temporaire a été envoyé par e-mail à l''adresse du compte. Changez-le dans Profil après la connexion.'
           ELSE 'Un mot de passe temporaire a été envoyé par message au numéro du compte. Changez-le dans Profil après la connexion.' END);
    UPDATE support_threads SET unread_admin = false, unread_user = true, last_message_at = now() WHERE id = p_thread;
  END IF;
  PERFORM _audit(p_actor, 'temp_password_sent', 'user', u.id::text);
END $$;

-- Confidentialité de l'administration : la personne ne voit plus QUI a consulté ses photos (cela exposait le personnel).
-- La trace reste enregistrée dans le journal d'audit, visible des administrateurs seulement.
CREATE OR REPLACE FUNCTION fn_my_identity(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; d identity_documents;
BEGIN
  u := _kyc_user(p_actor);
  SELECT * INTO d FROM identity_documents WHERE user_id = p_actor;
  RETURN jsonb_build_object(
    'verified', u.identity_verified, 'doc_number', u.identity_doc,
    'status', CASE WHEN u.identity_verified THEN 'verified' ELSE COALESCE(d.status, 'none') END,
    'doc_type', COALESCE(d.doc_type, 'cni'),
    'has_front', d.front IS NOT NULL, 'has_back', d.back IS NOT NULL, 'has_selfie', d.selfie IS NOT NULL,
    'reject_reason', d.reject_reason, 'submitted_at', d.submitted_at, 'decided_at', d.decided_at);
END $$;

-- ---------- Droits (mêmes règles que les migrations précédentes) ----------
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
       AND NOT (r.relname IN ('proofs','avatars') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
