-- =====================================================================
-- Migration 005 : numéro de versement, preuves de paiement (captures d'écran),
-- reversements des livreurs par transfert, outils d'administration.
-- Aucun paiement automatique : tout reste manuel mais tracé dans la plateforme.
-- =====================================================================

-- ---------- Numéro de versement enregistré (modifiable seulement par l'administration) ----------
ALTER TABLE users
  ADD COLUMN payout_method text CHECK (payout_method IN ('orange_money','mtn_momo')),
  ADD COLUMN payout_phone  text CHECK (payout_phone ~ '^[0-9]{9}$'),
  ADD CONSTRAINT users_payout_both CHECK ((payout_method IS NULL) = (payout_phone IS NULL));

-- ---------- Preuves : captures d'écran (images stockées dans la base) ----------
CREATE TABLE proofs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('withdrawal_payment','order_payment','remittance')),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  size        int  NOT NULL CHECK (size BETWEEN 1 AND 700000),
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER proofs_immutable BEFORE UPDATE OR DELETE ON proofs
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

ALTER TABLE withdrawals ADD COLUMN proof_id uuid UNIQUE REFERENCES proofs(id);

-- Comment le client a payé (déclaré par le livreur ; un transfert exige une capture)
CREATE TABLE order_payments (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL UNIQUE REFERENCES orders(id),
  courier_id uuid NOT NULL REFERENCES users(id),
  method     text NOT NULL CHECK (method IN ('cash','orange_money','mtn_momo')),
  proof_id   uuid UNIQUE REFERENCES proofs(id),
  reference  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (method = 'cash' OR proof_id IS NOT NULL)
);

-- Reversement par transfert : le livreur envoie l'argent encaissé à Wallindirain et joint la capture
CREATE TABLE remittances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_id    uuid NOT NULL REFERENCES users(id),
  method        text NOT NULL CHECK (method IN ('orange_money','mtn_momo')),
  amount        bigint NOT NULL CHECK (amount > 0),      -- attendu : calculé par le serveur
  proof_id      uuid NOT NULL UNIQUE REFERENCES proofs(id),
  reference     text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  received      bigint,
  decided_by    uuid REFERENCES users(id),
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE INDEX remittances_status_idx ON remittances(status);
CREATE TRIGGER remittances_no_delete BEFORE DELETE ON remittances FOR EACH ROW EXECUTE FUNCTION trg_append_only();

ALTER TABLE courier_cash_entries ADD COLUMN remittance_id uuid REFERENCES remittances(id);
ALTER TABLE cash_counts ADD COLUMN remittance_id uuid REFERENCES remittances(id);

INSERT INTO settings(key, value, label) VALUES
  ('require_payment_proof', 1, 'Capture d''écran obligatoire pour marquer un retrait payé (1 = oui, 0 = non)');

-- ---------- Inscription : numéro de versement ----------
DROP FUNCTION fn_register(text, text, user_role, text, text);
CREATE FUNCTION fn_register(p_phone text, p_name text, p_role user_role, p_password_hash text, p_identity_doc text,
                            p_payout_method text DEFAULT NULL, p_payout_phone text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_role NOT IN ('seller','supplier') THEN
    PERFORM _err('invalid_role', 'Inscription ouverte aux vendeurs et fournisseurs uniquement');
  END IF;
  IF p_identity_doc IS NULL OR length(trim(p_identity_doc)) < 4 THEN
    PERFORM _err('identity_required', 'La pièce d''identité est obligatoire à l''inscription');
  END IF;
  IF (p_payout_method IS NULL) <> (p_payout_phone IS NULL) THEN
    PERFORM _err('invalid_input', 'Indiquez l''opérateur et le numéro de versement');
  END IF;
  BEGIN
    INSERT INTO users(role, status, full_name, phone, password_hash, identity_doc, payout_method, payout_phone)
    VALUES (p_role, CASE WHEN p_role = 'supplier' THEN 'pending'::user_status ELSE 'active'::user_status END,
            trim(p_name), p_phone, p_password_hash, trim(p_identity_doc), p_payout_method, p_payout_phone)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN PERFORM _err('phone_taken', 'Ce numéro est déjà inscrit');
    WHEN check_violation  THEN PERFORM _err('invalid_input', 'Nom, numéro ou numéro de versement invalide (9 chiffres attendus)');
  END;
  PERFORM _audit(v_id, 'register', 'user', v_id::text, jsonb_build_object('role', p_role));
  RETURN v_id;
END $$;

-- Un compte qui n'a pas encore de numéro de versement peut le définir une seule fois ;
-- ensuite seule l'administration peut le changer (protection contre le détournement).
CREATE FUNCTION fn_set_payout(p_actor uuid, p_method text, p_phone text) RETURNS void LANGUAGE plpgsql AS $$
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

-- ---------- Preuves ----------
CREATE FUNCTION fn_proof_create(p_actor uuid, p_kind text, p_mime text, p_data bytea) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_kind = 'withdrawal_payment' THEN PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  ELSIF p_kind IN ('order_payment','remittance') THEN PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  ELSE PERFORM _err('invalid_input', 'Type de preuve invalide'); END IF;
  IF p_data IS NULL OR length(p_data) < 1 OR length(p_data) > 700000 THEN
    PERFORM _err('invalid_input', 'Image invalide ou trop lourde');
  END IF;
  INSERT INTO proofs(kind, uploaded_by, mime, size, data) VALUES (p_kind, p_actor, p_mime, length(p_data), p_data)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Lecture d'une image : administrateur, auteur, ou propriétaire du retrait payé
CREATE FUNCTION fn_proof_get(p_actor uuid, p_proof uuid) RETURNS TABLE(mime text, data bytea) LANGUAGE plpgsql AS $$
DECLARE u users; p proofs;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Compte inactif ou introuvable'); END IF;
  SELECT * INTO p FROM proofs WHERE id = p_proof;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Image introuvable'); END IF;
  IF NOT (u.role = 'admin' OR p.uploaded_by = p_actor
          OR EXISTS (SELECT 1 FROM withdrawals w WHERE w.proof_id = p.id AND w.user_id = p_actor)) THEN
    PERFORM _err('forbidden', 'Action non autorisée pour votre rôle');
  END IF;
  RETURN QUERY SELECT p.mime, p.data;
END $$;

-- Contrôle commun : la preuve existe, est du bon type, a été envoyée par l'acteur et n'est pas déjà utilisée
CREATE FUNCTION _check_proof(p_actor uuid, p_proof uuid, p_kind text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM proofs WHERE id = p_proof AND kind = p_kind AND uploaded_by = p_actor) THEN
    PERFORM _err('invalid_proof', 'Capture d''écran introuvable : renvoyez l''image');
  END IF;
  IF EXISTS (SELECT 1 FROM withdrawals WHERE proof_id = p_proof)
     OR EXISTS (SELECT 1 FROM order_payments WHERE proof_id = p_proof)
     OR EXISTS (SELECT 1 FROM remittances WHERE proof_id = p_proof) THEN
    PERFORM _err('invalid_proof', 'Cette capture d''écran a déjà été utilisée');
  END IF;
END $$;

-- ---------- Retraits : numéro enregistré + capture du transfert ----------
DROP FUNCTION fn_withdrawal_request(uuid, bigint, text, text);
CREATE FUNCTION fn_withdrawal_request(p_actor uuid, p_amount bigint, p_method text DEFAULT NULL, p_account text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE u users; v_id uuid := gen_random_uuid(); v_code text; v_min bigint;
BEGIN
  u := _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier']::user_role[]);
  IF NOT u.identity_verified THEN
    PERFORM _err('identity_required', 'Identité non vérifiée : retrait impossible');
  END IF;
  -- le versement va toujours au numéro enregistré ; les paramètres ne servent que si aucun numéro n'est enregistré (tests, reprise)
  IF u.payout_phone IS NOT NULL THEN
    p_method := u.payout_method; p_account := u.payout_phone;
  ELSIF p_method IS NULL OR p_account IS NULL THEN
    PERFORM _err('payout_missing', 'Aucun numéro de versement enregistré : renseignez-le dans votre portefeuille');
  END IF;
  v_min := _setting('min_withdrawal');
  IF p_amount IS NULL OR p_amount < v_min THEN PERFORM _err('below_minimum', 'Retrait minimum : ' || v_min || ' GNF'); END IF;
  IF p_method NOT IN ('orange_money','mtn_momo') THEN PERFORM _err('invalid_input', 'Mode de paiement invalide'); END IF;
  IF p_account !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro de paiement invalide (9 chiffres)'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wallet:' || p_actor::text));
  IF _wallet_available(p_actor) < p_amount THEN PERFORM _err('insufficient_funds', 'Solde disponible insuffisant'); END IF;
  INSERT INTO withdrawals(id, user_id, amount, method, account_number) VALUES (v_id, p_actor, p_amount, p_method, p_account);
  v_code := _rand_digits(6);
  INSERT INTO one_time_codes(user_id, purpose, code_hash, expires_at, ref_id)
  VALUES (p_actor, 'withdrawal', _code_hash(v_code, v_id), now() + interval '15 minutes', v_id);
  PERFORM _queue_message(u.phone, 'withdrawal_code',
    'Wallindirain : code de confirmation de votre retrait de ' || p_amount || ' GNF : ' || v_code || '. Valable 15 minutes.');
  RETURN v_id;
END $$;

DROP FUNCTION fn_admin_pay_withdrawal(uuid, uuid, text);
CREATE FUNCTION fn_admin_pay_withdrawal(p_actor uuid, p_withdrawal uuid, p_payment_ref text, p_proof uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE w withdrawals; u users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_payment_ref IS NULL OR length(trim(p_payment_ref)) < 3 THEN PERFORM _err('invalid_input', 'Référence de paiement obligatoire'); END IF;
  SELECT * INTO w FROM withdrawals WHERE id = p_withdrawal FOR UPDATE;
  IF NOT FOUND OR w.status <> 'requested' THEN PERFORM _err('invalid_state', 'Retrait introuvable ou non confirmé'); END IF;
  SELECT * INTO u FROM users WHERE id = w.user_id;
  IF NOT u.identity_verified THEN PERFORM _err('identity_required', 'Identité non vérifiée : paiement impossible'); END IF;
  IF p_proof IS NULL THEN
    IF _setting('require_payment_proof') = 1 THEN PERFORM _err('proof_required', 'Joignez la capture d''écran du transfert'); END IF;
  ELSE
    PERFORM _check_proof(p_actor, p_proof, 'withdrawal_payment');
  END IF;
  UPDATE withdrawals SET status = 'paid', payment_ref = trim(p_payment_ref), proof_id = p_proof, decided_by = p_actor, decided_at = now() WHERE id = w.id;
  PERFORM _audit(p_actor, 'withdrawal_paid', 'withdrawal', w.id::text,
                 jsonb_build_object('amount', w.amount, 'ref', p_payment_ref, 'method', w.method, 'proof', p_proof IS NOT NULL));
  PERFORM _queue_message(u.phone, 'withdrawal_paid',
    'Wallindirain : votre retrait de ' || w.amount || ' GNF a été envoyé sur le ' || w.account_number || '.');
END $$;

-- ---------- Livreur : paiement du client et reversement ----------
CREATE FUNCTION fn_courier_declare_payment(p_actor uuid, p_order uuid, p_method text, p_proof uuid, p_reference text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order AND courier_id = p_actor FOR UPDATE;
  IF NOT FOUND OR o.status NOT IN ('on_the_way','delivered') THEN
    PERFORM _err('invalid_state', 'Commande introuvable ou pas en cours de livraison');
  END IF;
  IF p_method NOT IN ('cash','orange_money','mtn_momo') THEN PERFORM _err('invalid_input', 'Mode de paiement invalide'); END IF;
  IF p_method <> 'cash' AND p_proof IS NULL THEN PERFORM _err('proof_required', 'Joignez la capture d''écran du transfert'); END IF;
  IF p_method = 'cash' THEN p_proof := NULL; END IF;
  IF EXISTS (SELECT 1 FROM order_payments WHERE order_id = o.id) THEN
    PERFORM _err('already_taken', 'Le mode de paiement de cette commande est déjà enregistré');
  END IF;
  IF p_proof IS NOT NULL THEN PERFORM _check_proof(p_actor, p_proof, 'order_payment'); END IF;
  INSERT INTO order_payments(order_id, courier_id, method, proof_id, reference)
  VALUES (o.id, p_actor, p_method, p_proof, NULLIF(trim(COALESCE(p_reference, '')), ''));
  PERFORM _audit(p_actor, 'order_payment_declared', 'order', o.id::text, jsonb_build_object('method', p_method));
END $$;

-- Le livreur déclare qu'il a envoyé par transfert l'argent encaissé (p_orders NULL = toute la caisse en attente)
CREATE FUNCTION fn_courier_remit(p_actor uuid, p_method text, p_proof uuid, p_reference text, p_orders uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_amount bigint; v_n int;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  IF p_method NOT IN ('orange_money','mtn_momo') THEN PERFORM _err('invalid_input', 'Mode de paiement invalide'); END IF;
  IF p_proof IS NULL THEN PERFORM _err('proof_required', 'Joignez la capture d''écran du transfert'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cash:' || p_actor::text));
  PERFORM _check_proof(p_actor, p_proof, 'remittance');
  SELECT COALESCE(sum(amount), 0), count(*) INTO v_amount, v_n FROM courier_cash_entries
   WHERE courier_id = p_actor AND count_id IS NULL AND remittance_id IS NULL AND (p_orders IS NULL OR order_id = ANY (p_orders));
  IF v_n = 0 THEN PERFORM _err('invalid_state', 'Aucun encaissement à reverser'); END IF;
  IF p_orders IS NOT NULL AND v_n <> cardinality(p_orders) THEN
    PERFORM _err('invalid_state', 'Une des commandes choisies n''est plus à reverser');
  END IF;
  INSERT INTO remittances(id, courier_id, method, amount, proof_id, reference)
  VALUES (v_id, p_actor, p_method, v_amount, p_proof, NULLIF(trim(COALESCE(p_reference, '')), ''));
  UPDATE courier_cash_entries SET remittance_id = v_id
   WHERE courier_id = p_actor AND count_id IS NULL AND remittance_id IS NULL AND (p_orders IS NULL OR order_id = ANY (p_orders));
  PERFORM _audit(p_actor, 'remittance_declared', 'remittance', v_id::text, jsonb_build_object('amount', v_amount, 'method', p_method));
  RETURN jsonb_build_object('id', v_id, 'amount', v_amount);
END $$;

-- Caisse comptée en espèces : ne touche pas aux encaissements déjà couverts par un reversement en attente
CREATE OR REPLACE FUNCTION fn_admin_count_cash(p_actor uuid, p_courier uuid, p_counted bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_expected bigint; v_short bigint; v_surplus bigint; v_id uuid := gen_random_uuid();
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_counted IS NULL OR p_counted < 0 THEN PERFORM _err('invalid_input', 'Montant compté invalide'); END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_courier AND role = 'courier') THEN
    PERFORM _err('not_found', 'Livreur introuvable');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cash:' || p_courier::text));
  SELECT COALESCE(sum(amount), 0) INTO v_expected FROM courier_cash_entries
   WHERE courier_id = p_courier AND count_id IS NULL AND remittance_id IS NULL;
  IF v_expected = 0 AND p_counted = 0 THEN PERFORM _err('invalid_state', 'Aucune caisse à compter pour ce livreur'); END IF;
  v_short := GREATEST(v_expected - p_counted, 0);
  v_surplus := GREATEST(p_counted - v_expected, 0);
  INSERT INTO cash_counts(id, courier_id, admin_id, expected, counted, shortage, surplus)
  VALUES (v_id, p_courier, p_actor, v_expected, p_counted, v_short, v_surplus);
  UPDATE courier_cash_entries SET count_id = v_id WHERE courier_id = p_courier AND count_id IS NULL AND remittance_id IS NULL;
  IF v_short > 0 THEN   -- tout manque est débité au livreur
    PERFORM _wallet_add(p_courier, 'cash_shortage', -v_short, NULL, now(), 'Manque de caisse');
    PERFORM _wallet_add(_platform(), 'cash_shortage', v_short, NULL, now(), 'Manque de caisse livreur');
  END IF;
  PERFORM _audit(p_actor, 'cash_counted', 'courier', p_courier::text,
                 jsonb_build_object('expected', v_expected, 'counted', p_counted, 'shortage', v_short, 'surplus', v_surplus));
  RETURN jsonb_build_object('expected', v_expected, 'counted', p_counted, 'shortage', v_short, 'surplus', v_surplus);
END $$;

-- L'administrateur confirme avoir reçu le transfert (montant réellement reçu) : même règle que le comptage en espèces
CREATE FUNCTION fn_admin_confirm_remittance(p_actor uuid, p_remittance uuid, p_received bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r remittances; v_expected bigint; v_short bigint; v_surplus bigint; v_id uuid := gen_random_uuid();
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_received IS NULL OR p_received < 0 THEN PERFORM _err('invalid_input', 'Montant reçu invalide'); END IF;
  SELECT * INTO r FROM remittances WHERE id = p_remittance FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN PERFORM _err('invalid_state', 'Reversement introuvable ou déjà traité'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cash:' || r.courier_id::text));
  SELECT COALESCE(sum(amount), 0) INTO v_expected FROM courier_cash_entries WHERE remittance_id = r.id AND count_id IS NULL;
  v_short := GREATEST(v_expected - p_received, 0);
  v_surplus := GREATEST(p_received - v_expected, 0);
  INSERT INTO cash_counts(id, courier_id, admin_id, expected, counted, shortage, surplus, remittance_id)
  VALUES (v_id, r.courier_id, p_actor, v_expected, p_received, v_short, v_surplus, r.id);
  UPDATE courier_cash_entries SET count_id = v_id WHERE remittance_id = r.id AND count_id IS NULL;
  IF v_short > 0 THEN
    PERFORM _wallet_add(r.courier_id, 'cash_shortage', -v_short, NULL, now(), 'Manque sur reversement');
    PERFORM _wallet_add(_platform(), 'cash_shortage', v_short, NULL, now(), 'Manque sur reversement livreur');
  END IF;
  UPDATE remittances SET status = 'confirmed', received = p_received, decided_by = p_actor, decided_at = now() WHERE id = r.id;
  PERFORM _audit(p_actor, 'remittance_confirmed', 'remittance', r.id::text,
                 jsonb_build_object('expected', v_expected, 'received', p_received, 'shortage', v_short, 'surplus', v_surplus));
  RETURN jsonb_build_object('expected', v_expected, 'received', p_received, 'shortage', v_short, 'surplus', v_surplus);
END $$;

CREATE FUNCTION fn_admin_reject_remittance(p_actor uuid, p_remittance uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r remittances;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN PERFORM _err('invalid_input', 'Motif obligatoire'); END IF;
  SELECT * INTO r FROM remittances WHERE id = p_remittance FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN PERFORM _err('invalid_state', 'Reversement introuvable ou déjà traité'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cash:' || r.courier_id::text));
  UPDATE courier_cash_entries SET remittance_id = NULL WHERE remittance_id = r.id AND count_id IS NULL;
  UPDATE remittances SET status = 'rejected', decided_by = p_actor, decision_note = trim(p_reason), decided_at = now() WHERE id = r.id;
  PERFORM _audit(p_actor, 'remittance_rejected', 'remittance', r.id::text, jsonb_build_object('reason', p_reason));
END $$;

-- ---------- Administration : modifier un compte, réinitialiser un mot de passe ----------
CREATE FUNCTION fn_admin_update_user(p_actor uuid, p_user uuid, p_name text, p_team text, p_payout_method text, p_payout_phone text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO u FROM users WHERE id = p_user AND deleted_at IS NULL AND role <> 'system' FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  IF p_name IS NULL OR length(trim(p_name)) < 2 THEN PERFORM _err('invalid_input', 'Nom invalide'); END IF;
  IF (p_payout_method IS NULL) <> (p_payout_phone IS NULL) THEN
    PERFORM _err('invalid_input', 'Indiquez l''opérateur et le numéro de versement');
  END IF;
  IF u.role IN ('agent','call_chief') AND (p_team IS NULL OR length(trim(p_team)) < 2) THEN
    PERFORM _err('team_required', 'Le nom du call center est obligatoire pour un agent ou un chef');
  END IF;
  BEGIN
    UPDATE users SET full_name = trim(p_name),
           team = CASE WHEN u.role IN ('agent','call_chief') THEN NULLIF(trim(p_team), '') ELSE team END,
           payout_method = p_payout_method, payout_phone = p_payout_phone
     WHERE id = u.id;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Nom ou numéro de versement invalide (9 chiffres attendus)');
  END;
  PERFORM _audit(p_actor, 'user_updated', 'user', u.id::text,
                 jsonb_build_object('payout_changed', (u.payout_phone IS DISTINCT FROM p_payout_phone) OR (u.payout_method IS DISTINCT FROM p_payout_method)));
END $$;

CREATE FUNCTION fn_admin_reset_password(p_actor uuid, p_user uuid, p_new_hash text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO u FROM users WHERE id = p_user AND deleted_at IS NULL AND role <> 'system' FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  UPDATE users SET password_hash = p_new_hash, failed_attempts = 0, locked_until = NULL WHERE id = u.id;
  DELETE FROM sessions WHERE user_id = u.id;
  PERFORM _audit(p_actor, 'password_reset_by_admin', 'user', u.id::text);
END $$;

-- Déblocage d'un compte verrouillé par des essais de connexion
CREATE FUNCTION fn_admin_unlock_user(p_actor uuid, p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = p_user AND deleted_at IS NULL AND role <> 'system';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  PERFORM _audit(p_actor, 'user_unlocked', 'user', p_user::text);
END $$;

-- ---------- Messages : un code réellement envoyé n'est pas conservé en clair ----------
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
                    ELSE body END
                ELSE body END
   WHERE id = p_id;
END $$;

-- ---------- Droits (mêmes règles que la migration 004, rejouées pour les nouveautés) ----------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $$
DECLARE r record; v_cols text;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE '\_%' OR p.proname LIKE 'fn\_%') LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public, pg_temp', r.sig);
    IF r.proname LIKE 'fn\_%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wld_app', r.sig); END IF;
  END LOOP;

  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash')
       AND NOT (r.relname = 'proofs' AND column_name = 'data');   -- les images ne sortent que par fn_proof_get
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
