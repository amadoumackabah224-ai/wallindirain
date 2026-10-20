-- =====================================================================
-- Migration 010 : vérification d'identité (KYC) avec images de la pièce.
--  - recto (obligatoire), verso (facultatif) et selfie avec la pièce (obligatoire)
--  - visibles uniquement du propriétaire et des administrateurs
--  - chaque consultation par un administrateur est enregistrée et visible par la personne concernée
--  - validation ou refus (avec motif) par l'administrateur ; images supprimées à l'anonymisation du compte
-- =====================================================================
INSERT INTO settings(key, value, label) VALUES
  ('kyc_images_required', 1, 'Photos de la pièce d''identité obligatoires avant de vérifier un compte (1 = oui, 0 = non)')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION fn_admin_set_setting(p_actor uuid, p_key text, p_value bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_value IS NULL OR p_value < 0 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key IN ('margin_bps','fee_order_bps','courier_share_bps') AND p_value > 10000 THEN PERFORM _err('invalid_input', 'Pourcentage invalide (10000 = 100 %)'); END IF;
  IF p_key IN ('code_max_attempts','call_attempt_limit') AND p_value < 1 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key IN ('require_delivery_code','require_payment_proof','subscription_required','kyc_images_required') AND p_value > 1 THEN PERFORM _err('invalid_input', 'Valeur invalide : 0 ou 1'); END IF;
  SELECT value INTO v_old FROM settings WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Réglage inconnu'); END IF;
  UPDATE settings SET value = p_value WHERE key = p_key;
  PERFORM _audit(p_actor, 'setting_changed', 'setting', p_key, jsonb_build_object('from', v_old, 'to', p_value));
END $$;

CREATE TABLE identity_documents (
  user_id       uuid PRIMARY KEY REFERENCES users(id),
  doc_type      text NOT NULL DEFAULT 'cni' CHECK (doc_type IN ('cni','passeport','autre')),
  front         bytea CHECK (front  IS NULL OR octet_length(front)  BETWEEN 1000 AND 600000),
  front_mime    text  CHECK (front_mime  IS NULL OR front_mime  IN ('image/jpeg','image/png','image/webp')),
  back          bytea CHECK (back   IS NULL OR octet_length(back)   BETWEEN 1000 AND 600000),
  back_mime     text  CHECK (back_mime   IS NULL OR back_mime   IN ('image/jpeg','image/png','image/webp')),
  selfie        bytea CHECK (selfie IS NULL OR octet_length(selfie) BETWEEN 1000 AND 600000),
  selfie_mime   text  CHECK (selfie_mime IS NULL OR selfie_mime IN ('image/jpeg','image/png','image/webp')),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','verified','rejected')),
  reject_reason text,
  submitted_at  timestamptz,
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Les personnes qui peuvent envoyer leur pièce : celles qui reçoivent de l'argent
CREATE FUNCTION _kyc_user(p_actor uuid) RETURNS users LANGUAGE plpgsql AS $$
BEGIN
  RETURN _require(p_actor, ARRAY['seller','supplier','agent','call_chief','courier']::user_role[]);
END $$;

-- Le numéro de la pièce peut maintenant être saisi par tous ceux qui reçoivent de l'argent
CREATE OR REPLACE FUNCTION fn_set_identity_doc(p_actor uuid, p_doc text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  u := _kyc_user(p_actor);
  IF u.identity_verified THEN PERFORM _err('identity_locked', 'Pièce déjà vérifiée : contactez l''administration pour la modifier'); END IF;
  IF p_doc IS NULL OR length(trim(p_doc)) < 4 OR length(trim(p_doc)) > 60 THEN PERFORM _err('invalid_input', 'Pièce d''identité invalide'); END IF;
  UPDATE users SET identity_doc = trim(p_doc) WHERE id = p_actor;
  PERFORM _audit(p_actor, 'identity_doc_set', 'user', p_actor::text);
END $$;

-- Dépôt d'une image (recto, verso ou selfie). Impossible une fois la pièce vérifiée ou pendant l'examen.
CREATE FUNCTION fn_identity_image_set(p_actor uuid, p_side text, p_doc_type text, p_mime text, p_data bytea) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users; d identity_documents;
BEGIN
  u := _kyc_user(p_actor);
  IF p_side NOT IN ('front','back','selfie') THEN PERFORM _err('invalid_input', 'Côté de la pièce invalide'); END IF;
  IF p_doc_type NOT IN ('cni','passeport','autre') THEN PERFORM _err('invalid_input', 'Type de pièce invalide'); END IF;
  IF u.identity_verified THEN PERFORM _err('identity_locked', 'Pièce déjà vérifiée : contactez l''administration pour la modifier'); END IF;
  SELECT * INTO d FROM identity_documents WHERE user_id = p_actor FOR UPDATE;
  IF FOUND AND d.status = 'submitted' THEN PERFORM _err('invalid_state', 'Votre pièce est en cours d''examen : attendez la décision de l''administration'); END IF;
  INSERT INTO identity_documents(user_id, doc_type) VALUES (p_actor, p_doc_type) ON CONFLICT (user_id) DO NOTHING;
  BEGIN
    IF p_side = 'front' THEN UPDATE identity_documents SET front = p_data, front_mime = p_mime WHERE user_id = p_actor;
    ELSIF p_side = 'back' THEN UPDATE identity_documents SET back = p_data, back_mime = p_mime WHERE user_id = p_actor;
    ELSE UPDATE identity_documents SET selfie = p_data, selfie_mime = p_mime WHERE user_id = p_actor; END IF;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Image invalide ou trop lourde');
  END;
  UPDATE identity_documents SET doc_type = p_doc_type, status = 'draft', reject_reason = NULL, updated_at = now() WHERE user_id = p_actor;
  PERFORM _audit(p_actor, 'identity_image_uploaded', 'user', p_actor::text, jsonb_build_object('side', p_side));
END $$;

-- Envoi pour vérification : le recto et le selfie sont obligatoires
CREATE FUNCTION fn_identity_submit(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users; d identity_documents;
BEGIN
  u := _kyc_user(p_actor);
  IF u.identity_verified THEN PERFORM _err('identity_locked', 'Pièce déjà vérifiée'); END IF;
  SELECT * INTO d FROM identity_documents WHERE user_id = p_actor FOR UPDATE;
  IF NOT FOUND OR d.front IS NULL THEN PERFORM _err('invalid_input', 'Ajoutez d''abord la photo du recto de votre pièce'); END IF;
  IF d.selfie IS NULL THEN PERFORM _err('invalid_input', 'Ajoutez votre selfie en tenant la pièce'); END IF;
  IF u.identity_doc IS NULL THEN PERFORM _err('invalid_input', 'Saisissez d''abord le numéro de votre pièce'); END IF;
  IF d.status = 'submitted' THEN RETURN; END IF;
  UPDATE identity_documents SET status = 'submitted', submitted_at = now(), reject_reason = NULL, updated_at = now() WHERE user_id = p_actor;
  PERFORM _audit(p_actor, 'identity_submitted', 'user', p_actor::text);
END $$;

-- Lecture d'une image : la personne elle-même, ou un administrateur (consultation alors enregistrée)
CREATE FUNCTION fn_identity_image_get(p_actor uuid, p_user uuid, p_side text) RETURNS TABLE(mime text, data bytea) LANGUAGE plpgsql AS $$
DECLARE a users; d identity_documents; v_mime text; v_data bytea;
BEGIN
  SELECT * INTO a FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Compte inactif ou introuvable'); END IF;
  IF a.id <> p_user AND a.role <> 'admin' THEN PERFORM _err('forbidden', 'Action non autorisée pour votre rôle'); END IF;
  IF p_side NOT IN ('front','back','selfie') THEN PERFORM _err('invalid_input', 'Côté de la pièce invalide'); END IF;
  SELECT * INTO d FROM identity_documents WHERE user_id = p_user;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_side = 'front' THEN v_mime := d.front_mime; v_data := d.front;
  ELSIF p_side = 'back' THEN v_mime := d.back_mime; v_data := d.back;
  ELSE v_mime := d.selfie_mime; v_data := d.selfie; END IF;
  IF v_data IS NULL THEN RETURN; END IF;
  IF a.id <> p_user THEN PERFORM _audit(p_actor, 'identity_image_viewed', 'user', p_user::text, jsonb_build_object('side', p_side)); END IF;
  RETURN QUERY SELECT v_mime, v_data;
END $$;

-- État de ma vérification + qui a consulté mes images (transparence)
CREATE FUNCTION fn_my_identity(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; d identity_documents; v_views jsonb;
BEGIN
  u := _kyc_user(p_actor);
  SELECT * INTO d FROM identity_documents WHERE user_id = p_actor;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at', x.at, 'by', x.name, 'side', x.side) ORDER BY x.at DESC), '[]'::jsonb) INTO v_views FROM (
    SELECT l.at, usr.full_name AS name, l.details->>'side' AS side
      FROM audit_log l JOIN users usr ON usr.id = l.actor_id
     WHERE l.action = 'identity_image_viewed' AND l.entity = 'user' AND l.entity_id = p_actor::text
     ORDER BY l.at DESC LIMIT 50) x;
  RETURN jsonb_build_object(
    'verified', u.identity_verified, 'doc_number', u.identity_doc,
    'status', CASE WHEN u.identity_verified THEN 'verified' ELSE COALESCE(d.status, 'none') END,
    'doc_type', COALESCE(d.doc_type, 'cni'),
    'has_front', d.front IS NOT NULL, 'has_back', d.back IS NOT NULL, 'has_selfie', d.selfie IS NOT NULL,
    'reject_reason', d.reject_reason, 'submitted_at', d.submitted_at, 'decided_at', d.decided_at,
    'views', v_views);
END $$;

-- Validation par l'administrateur (images obligatoires si le réglage l'exige)
CREATE OR REPLACE FUNCTION fn_admin_verify_identity(p_actor uuid, p_user uuid, p_verified boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d identity_documents;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO d FROM identity_documents WHERE user_id = p_user;
  IF p_verified AND _setting('kyc_images_required') = 1 THEN
    IF NOT FOUND OR d.front IS NULL OR d.selfie IS NULL OR d.status NOT IN ('submitted','verified') THEN
      PERFORM _err('kyc_images_missing', 'La personne doit d''abord envoyer les photos de sa pièce (recto et selfie)');
    END IF;
  END IF;
  UPDATE users SET identity_verified = p_verified WHERE id = p_user AND deleted_at IS NULL AND role <> 'system';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  IF FOUND THEN
    UPDATE identity_documents SET status = CASE WHEN p_verified THEN 'verified' ELSE 'submitted' END,
           decided_at = now(), decided_by = p_actor, reject_reason = NULL, updated_at = now() WHERE user_id = p_user;
  END IF;
  PERFORM _audit(p_actor, 'verify_identity', 'user', p_user::text, jsonb_build_object('verified', p_verified));
END $$;

-- Refus avec motif : la personne peut renvoyer de nouvelles photos
CREATE FUNCTION fn_admin_reject_identity(p_actor uuid, p_user uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d identity_documents;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 OR length(p_reason) > 300 THEN PERFORM _err('invalid_input', 'Indiquez le motif du refus (3 à 300 caractères)'); END IF;
  SELECT * INTO d FROM identity_documents WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Aucune pièce envoyée par cette personne'); END IF;
  UPDATE identity_documents SET status = 'rejected', reject_reason = trim(p_reason), decided_at = now(), decided_by = p_actor, updated_at = now() WHERE user_id = p_user;
  UPDATE users SET identity_verified = false WHERE id = p_user;
  PERFORM _audit(p_actor, 'identity_rejected', 'user', p_user::text, jsonb_build_object('reason', trim(p_reason)));
END $$;

-- Anonymisation d'un compte : photo, conversations et images de la pièce sont supprimées
CREATE OR REPLACE FUNCTION trg_user_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    DELETE FROM avatars WHERE user_id = NEW.id;
    DELETE FROM identity_documents WHERE user_id = NEW.id;
    DELETE FROM support_messages WHERE thread_id IN (SELECT id FROM support_threads WHERE user_id = NEW.id);
    DELETE FROM support_threads WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

-- ---------- Droits (mêmes règles que les migrations précédentes ; les images ne sont jamais lisibles directement) ----------
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
