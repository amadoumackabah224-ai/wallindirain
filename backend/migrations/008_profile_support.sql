-- =====================================================================
-- Migration 008 : profil (photo, nom, mot de passe, numéro de versement), remise à zéro des activités,
-- et messagerie avec l'équipe (support).
-- =====================================================================

-- ---------- Photo de profil (facultative, petite, une seule par personne) ----------
CREATE TABLE avatars (
  user_id    uuid PRIMARY KEY REFERENCES users(id),
  mime       text  NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data       bytea NOT NULL CHECK (octet_length(data) BETWEEN 100 AND 150000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION fn_avatar_set(p_actor uuid, p_mime text, p_data bytea) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin','seller','supplier','agent','call_chief','courier','warehouse']::user_role[]);
  BEGIN
    INSERT INTO avatars(user_id, mime, data) VALUES (p_actor, p_mime, p_data)
    ON CONFLICT (user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now();
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Photo invalide ou trop lourde');
  END;
END $$;

CREATE FUNCTION fn_avatar_delete(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin','seller','supplier','agent','call_chief','courier','warehouse']::user_role[]);
  DELETE FROM avatars WHERE user_id = p_actor;
END $$;

-- La photo est visible de son propriétaire et de l'administration seulement
CREATE FUNCTION fn_avatar_get(p_actor uuid, p_user uuid) RETURNS TABLE(mime text, data bytea) LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Compte inactif ou introuvable'); END IF;
  IF u.id <> p_user AND u.role <> 'admin' THEN PERFORM _err('forbidden', 'Action non autorisée pour votre rôle'); END IF;
  RETURN QUERY SELECT a.mime, a.data FROM avatars a WHERE a.user_id = p_user;
END $$;

-- ---------- Profil ----------
CREATE FUNCTION fn_update_profile(p_actor uuid, p_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin','seller','supplier','agent','call_chief','courier','warehouse']::user_role[]);
  IF p_name IS NULL OR length(trim(p_name)) < 2 OR length(p_name) > 100 THEN PERFORM _err('invalid_input', 'Nom invalide'); END IF;
  UPDATE users SET full_name = trim(p_name) WHERE id = p_actor;
  PERFORM _audit(p_actor, 'profile_updated', 'user', p_actor::text);
END $$;

-- Changement de mot de passe (l'ancien mot de passe est vérifié par le serveur avant l'appel) ; les autres appareils sont déconnectés
CREATE FUNCTION fn_set_password(p_actor uuid, p_new_hash text, p_keep_session text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin','seller','supplier','agent','call_chief','courier','warehouse']::user_role[]);
  UPDATE users SET password_hash = p_new_hash, failed_attempts = 0, locked_until = NULL WHERE id = p_actor;
  DELETE FROM sessions WHERE user_id = p_actor AND token_hash <> p_keep_session;
  PERFORM _audit(p_actor, 'password_changed', 'user', p_actor::text);
END $$;

-- Changement du numéro de versement (mot de passe vérifié par le serveur). L'ancien numéro est prévenu.
CREATE FUNCTION fn_change_payout(p_actor uuid, p_method text, p_phone text) RETURNS void LANGUAGE plpgsql AS $$
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

-- ---------- Remise à zéro des activités (pour repartir avec de vraies informations) ----------
-- Efface : commandes, appels, argent (portefeuilles, retraits, caisses, preuves), arrivages, stocks vendeurs, messages envoyés.
-- Conserve : comptes, produits (stock remis à 0), tarifs, réglages, consentements, demandes sur les données, journal des actions.
CREATE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 order_history, calls, risky_customers, orders, arrivals, seller_stock, messages, one_time_codes, proofs
    RESTART IDENTITY;
  UPDATE products SET stock_qty = 0, reserved_qty = 0;
  PERFORM _audit(p_actor, 'activity_reset', 'system', NULL, jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries));
  RETURN jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries);
END $$;

-- ---------- Messagerie avec l'équipe ----------
CREATE TABLE support_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES users(id),             -- vide : visiteur sans compte (mot de passe oublié, urgence)
  full_name       text NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 100),
  phone           text NOT NULL CHECK (phone ~ '^[0-9]{9}$'),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  unread_admin    boolean NOT NULL DEFAULT true,
  unread_user     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX support_threads_user_idx ON support_threads(user_id);
CREATE INDEX support_threads_status_idx ON support_threads(status, last_message_at DESC);
CREATE TABLE support_messages (
  id         bigserial PRIMARY KEY,
  thread_id  uuid NOT NULL REFERENCES support_threads(id),
  sender     text NOT NULL CHECK (sender IN ('user','admin')),
  body       text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_thread_idx ON support_messages(thread_id, id);

-- Un utilisateur connecté écrit à l'équipe : sa conversation ouverte est réutilisée
CREATE FUNCTION fn_support_post(p_actor uuid, p_body text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE u users; v_thread uuid;
BEGIN
  u := _require(p_actor, ARRAY['admin','seller','supplier','agent','call_chief','courier','warehouse']::user_role[]);
  IF p_body IS NULL OR length(trim(p_body)) < 1 OR length(p_body) > 1000 THEN PERFORM _err('invalid_input', 'Message vide ou trop long (1000 caractères maximum)'); END IF;
  SELECT id INTO v_thread FROM support_threads WHERE user_id = p_actor AND status = 'open' ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO support_threads(user_id, full_name, phone) VALUES (u.id, u.full_name, u.phone) RETURNING id INTO v_thread;
  END IF;
  INSERT INTO support_messages(thread_id, sender, body) VALUES (v_thread, 'user', trim(p_body));
  UPDATE support_threads SET unread_admin = true, last_message_at = now() WHERE id = v_thread;
  RETURN v_thread;
END $$;

-- Marquer lus les messages reçus de l'équipe
CREATE FUNCTION fn_support_mark_read(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin','seller','supplier','agent','call_chief','courier','warehouse']::user_role[]);
  UPDATE support_threads SET unread_user = false WHERE user_id = p_actor AND unread_user;
END $$;

-- Visiteur sans compte (mot de passe oublié, urgence) : la réponse lui sera envoyée par message sur son numéro
CREATE FUNCTION fn_support_open_public(p_name text, p_phone text, p_body text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_thread uuid;
BEGIN
  IF p_body IS NULL OR length(trim(p_body)) < 3 OR length(p_body) > 1000 THEN PERFORM _err('invalid_input', 'Message trop court ou trop long (1000 caractères maximum)'); END IF;
  IF (SELECT count(*) FROM support_threads WHERE phone = p_phone AND status = 'open' AND user_id IS NULL) >= 3 THEN
    PERFORM _err('too_many', 'Vos demandes précédentes sont en cours : nous vous répondons dès que possible');
  END IF;
  BEGIN
    INSERT INTO support_threads(full_name, phone) VALUES (trim(p_name), p_phone) RETURNING id INTO v_thread;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Nom ou numéro invalide (9 chiffres attendus)');
  END;
  INSERT INTO support_messages(thread_id, sender, body) VALUES (v_thread, 'user', trim(p_body));
  RETURN v_thread;
END $$;

-- Réponse de l'équipe : dans la conversation, et par message sur le téléphone si la personne n'a pas de session (visiteur)
CREATE FUNCTION fn_support_reply(p_actor uuid, p_thread uuid, p_body text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t support_threads;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_body IS NULL OR length(trim(p_body)) < 1 OR length(p_body) > 1000 THEN PERFORM _err('invalid_input', 'Réponse vide ou trop longue'); END IF;
  SELECT * INTO t FROM support_threads WHERE id = p_thread FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Conversation introuvable'); END IF;
  INSERT INTO support_messages(thread_id, sender, body) VALUES (t.id, 'admin', trim(p_body));
  UPDATE support_threads SET unread_admin = false, unread_user = true, last_message_at = now(), status = 'open', closed_at = NULL WHERE id = t.id;
  IF t.user_id IS NULL THEN
    PERFORM _queue_message(t.phone, 'support_reply', 'Wallindirain : ' || trim(p_body));
  END IF;
END $$;

CREATE FUNCTION fn_support_close(p_actor uuid, p_thread uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  UPDATE support_threads SET status = 'closed', closed_at = now(), unread_admin = false WHERE id = p_thread;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Conversation introuvable'); END IF;
END $$;

-- Mot de passe oublié : l'administrateur génère un mot de passe temporaire, il est envoyé par message au numéro du compte
-- (le texte du message est masqué après l'envoi) ; la personne le change ensuite dans son profil.
CREATE FUNCTION fn_admin_send_temp_password(p_actor uuid, p_user uuid, p_new_hash text, p_plain text, p_thread uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO u FROM users WHERE id = p_user AND deleted_at IS NULL AND role <> 'system' FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  UPDATE users SET password_hash = p_new_hash, failed_attempts = 0, locked_until = NULL WHERE id = u.id;
  DELETE FROM sessions WHERE user_id = u.id;
  PERFORM _queue_message(u.phone, 'temp_password',
    'Wallindirain : votre mot de passe temporaire est : ' || p_plain || ' . Connectez-vous puis changez-le dans Profil.');
  IF p_thread IS NOT NULL THEN
    INSERT INTO support_messages(thread_id, sender, body) VALUES (p_thread, 'admin', 'Un mot de passe temporaire a été envoyé par message au numéro du compte. Changez-le dans Profil après la connexion.');
    UPDATE support_threads SET unread_admin = false, unread_user = true, last_message_at = now() WHERE id = p_thread;
  END IF;
  PERFORM _audit(p_actor, 'temp_password_sent', 'user', u.id::text);
END $$;

-- Masquer aussi le mot de passe temporaire une fois le message envoyé
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
                    WHEN 'temp_password'   THEN regexp_replace(body, '(temporaire est : )\S+', '\1••••••••')
                    ELSE body END
                ELSE body END
   WHERE id = p_id;
END $$;

-- Conservation : conversations fermées depuis plus d'un an supprimées
CREATE FUNCTION fn_purge_support() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  DELETE FROM support_messages WHERE thread_id IN (SELECT id FROM support_threads WHERE status = 'closed' AND closed_at < now() - interval '1 year');
  DELETE FROM support_threads WHERE status = 'closed' AND closed_at < now() - interval '1 year';
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;

-- Anonymisation d'un compte : la photo et les conversations avec l'équipe sont supprimées
CREATE FUNCTION trg_user_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    DELETE FROM avatars WHERE user_id = NEW.id;
    DELETE FROM support_messages WHERE thread_id IN (SELECT id FROM support_threads WHERE user_id = NEW.id);
    DELETE FROM support_threads WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW EXECUTE FUNCTION trg_user_anonymized();

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
       AND NOT (r.relname IN ('proofs','avatars') AND column_name = 'data');
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
