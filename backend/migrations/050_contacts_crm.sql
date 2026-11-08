-- 050 : « Contacts » de Mes finances, pour tous les rôles : carnet unique (clients, prospects, autres), notes datées, étiquettes, import de fichier.
-- Les boutons Appeler / SMS / WhatsApp ouvrent simplement l'application du téléphone avec un message prérempli ; rien n'est lu ni envoyé par la plateforme.
-- Formule gratuite : N contacts (réglage). Pro : illimité, étiquettes, import de fichier.
-- Aucune table ni fonction existante modifiée (les clients et relances du vendeur restent tels quels).

INSERT INTO settings(key, value, label) VALUES
  ('pf_free_contacts', 30, 'Mes finances : nombre de contacts de la formule gratuite');

CREATE TABLE pf_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 60),
  phone       text NOT NULL CHECK (phone ~ '^[0-9]{6,15}$'),
  city        text CHECK (city IS NULL OR length(city) <= 40),
  stage       text NOT NULL DEFAULT 'prospect' CHECK (stage IN ('prospect','client','other')),
  origin      text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','import','order')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX pf_contacts_phone_idx ON pf_contacts(owner_id, phone) WHERE archived_at IS NULL;
CREATE INDEX pf_contacts_owner_idx ON pf_contacts(owner_id, name);

CREATE TABLE pf_contact_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES pf_contacts(id),
  owner_id   uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at  timestamptz
);
CREATE INDEX pf_contact_notes_idx ON pf_contact_notes(contact_id, created_at DESC);

CREATE TABLE pf_contact_labels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  name       text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 30),
  color      text NOT NULL CHECK (color IN ('green','red','gold','blue','grey')),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX pf_contact_labels_name_idx ON pf_contact_labels(owner_id, lower(name)) WHERE deleted_at IS NULL;
CREATE TABLE pf_contact_label_links (
  contact_id uuid NOT NULL REFERENCES pf_contacts(id),
  label_id   uuid NOT NULL REFERENCES pf_contact_labels(id),
  PRIMARY KEY (contact_id, label_id)
);

-- Numéro nettoyé : chiffres seuls, sans l'indicatif 224 de la Guinée
CREATE FUNCTION _pf_norm_phone(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(d) = 14 AND d LIKE '00224%' THEN substr(d, 6) WHEN length(d) = 12 AND d LIKE '224%' THEN substr(d, 4) ELSE d END
  FROM (SELECT regexp_replace(COALESCE(p, ''), '[^0-9]', '', 'g') AS d) x
$$;

-- Crée (p_id vide) ou modifie un contact
CREATE FUNCTION fn_pf_contact_save(p_actor uuid, p_id uuid, p_name text, p_phone text, p_city text, p_stage text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := p_id; v_name text := trim(COALESCE(p_name, '')); v_phone text := _pf_norm_phone(p_phone); v_city text := NULLIF(trim(COALESCE(p_city, '')), '');
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  PERFORM pg_advisory_xact_lock(hashtext('pfct:' || p_actor::text));
  IF length(v_name) < 2 OR length(v_name) > 60 THEN PERFORM _err('invalid_input', 'Nom invalide (2 à 60 caractères)'); END IF;
  IF v_phone !~ '^[0-9]{6,15}$' THEN PERFORM _err('invalid_input', 'Numéro de téléphone invalide'); END IF;
  IF v_city IS NOT NULL AND length(v_city) > 40 THEN PERFORM _err('invalid_input', 'Ville trop longue'); END IF;
  IF p_stage NOT IN ('prospect','client','other') THEN PERFORM _err('invalid_input', 'Statut invalide'); END IF;
  IF EXISTS (SELECT 1 FROM pf_contacts WHERE owner_id = p_actor AND phone = v_phone AND archived_at IS NULL AND id IS DISTINCT FROM p_id) THEN PERFORM _err('duplicate', 'Ce numéro est déjà dans vos contacts'); END IF;
  IF p_id IS NULL THEN
    IF _pf_tier(p_actor) <> 'pro' AND (SELECT count(*) FROM pf_contacts WHERE owner_id = p_actor AND archived_at IS NULL) >= _setting('pf_free_contacts') THEN
      PERFORM _err('pro_required', format('La formule gratuite permet %s contacts. Passez à Pro pour en ajouter davantage.', _setting('pf_free_contacts')::int));
    END IF;
    INSERT INTO pf_contacts(owner_id, name, phone, city, stage) VALUES (p_actor, v_name, v_phone, v_city, p_stage) RETURNING id INTO v_id;
  ELSE
    UPDATE pf_contacts SET name = v_name, phone = v_phone, city = v_city, stage = p_stage, updated_at = now() WHERE id = p_id AND owner_id = p_actor AND archived_at IS NULL;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Contact introuvable'); END IF;
  END IF;
  RETURN v_id;
END $$;

-- Archiver / rétablir (rien n'est supprimé). Rétablir respecte la limite du gratuit.
CREATE FUNCTION fn_pf_contact_archive(p_actor uuid, p_id uuid, p_archived boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  PERFORM pg_advisory_xact_lock(hashtext('pfct:' || p_actor::text));
  IF NOT p_archived THEN
    IF _pf_tier(p_actor) <> 'pro' AND (SELECT count(*) FROM pf_contacts WHERE owner_id = p_actor AND archived_at IS NULL) >= _setting('pf_free_contacts') THEN
      PERFORM _err('pro_required', 'La limite de contacts de la formule gratuite est atteinte');
    END IF;
    IF EXISTS (SELECT 1 FROM pf_contacts c JOIN pf_contacts d ON d.owner_id = c.owner_id AND d.phone = c.phone AND d.archived_at IS NULL AND d.id <> c.id WHERE c.id = p_id AND c.owner_id = p_actor) THEN
      PERFORM _err('duplicate', 'Ce numéro est déjà dans vos contacts');
    END IF;
  END IF;
  UPDATE pf_contacts SET archived_at = CASE WHEN p_archived THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = p_id AND owner_id = p_actor;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Contact introuvable'); END IF;
END $$;

CREATE FUNCTION fn_pf_contact_note_add(p_actor uuid, p_contact uuid, p_body text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_body text := trim(COALESCE(p_body, '')); v_id uuid;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF length(v_body) < 1 OR length(v_body) > 500 THEN PERFORM _err('invalid_input', 'Note invalide (1 à 500 caractères)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pf_contacts WHERE id = p_contact AND owner_id = p_actor) THEN PERFORM _err('not_found', 'Contact introuvable'); END IF;
  IF (SELECT count(*) FROM pf_contact_notes WHERE contact_id = p_contact AND voided_at IS NULL) >= 100 THEN PERFORM _err('limit', '100 notes au plus par contact'); END IF;
  INSERT INTO pf_contact_notes(contact_id, owner_id, body) VALUES (p_contact, p_actor, v_body) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_pf_contact_note_void(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  UPDATE pf_contact_notes SET voided_at = now() WHERE id = p_id AND owner_id = p_actor AND voided_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Note introuvable'); END IF;
END $$;

-- Étiquettes (Pro) : créer / renommer ; retirer = masquer
CREATE FUNCTION fn_pf_label_save(p_actor uuid, p_id uuid, p_name text, p_color text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := p_id; v_name text := trim(COALESCE(p_name, ''));
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pflb:' || p_actor::text));
  IF length(v_name) < 1 OR length(v_name) > 30 THEN PERFORM _err('invalid_input', 'Nom invalide (1 à 30 caractères)'); END IF;
  IF p_color NOT IN ('green','red','gold','blue','grey') THEN PERFORM _err('invalid_input', 'Couleur invalide'); END IF;
  IF EXISTS (SELECT 1 FROM pf_contact_labels WHERE owner_id = p_actor AND lower(name) = lower(v_name) AND deleted_at IS NULL AND id IS DISTINCT FROM p_id) THEN PERFORM _err('duplicate', 'Cette étiquette existe déjà'); END IF;
  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM pf_contact_labels WHERE owner_id = p_actor AND deleted_at IS NULL) >= 20 THEN PERFORM _err('limit', '20 étiquettes au plus'); END IF;
    INSERT INTO pf_contact_labels(owner_id, name, color) VALUES (p_actor, v_name, p_color) RETURNING id INTO v_id;
  ELSE
    UPDATE pf_contact_labels SET name = v_name, color = p_color WHERE id = p_id AND owner_id = p_actor AND deleted_at IS NULL;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Étiquette introuvable'); END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_pf_label_delete(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  UPDATE pf_contact_labels SET deleted_at = now() WHERE id = p_id AND owner_id = p_actor AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Étiquette introuvable'); END IF;
END $$;

-- Remplace les étiquettes d'un contact (Pro)
CREATE FUNCTION fn_pf_contact_labels_set(p_actor uuid, p_contact uuid, p_labels uuid[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_labels uuid[] := COALESCE(p_labels, ARRAY[]::uuid[]);
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  IF NOT EXISTS (SELECT 1 FROM pf_contacts WHERE id = p_contact AND owner_id = p_actor AND archived_at IS NULL) THEN PERFORM _err('not_found', 'Contact introuvable'); END IF;
  IF cardinality(v_labels) > 10 THEN PERFORM _err('limit', '10 étiquettes au plus par contact'); END IF;
  IF (SELECT count(*) FROM pf_contact_labels WHERE id = ANY(v_labels) AND owner_id = p_actor AND deleted_at IS NULL) <> cardinality(ARRAY(SELECT DISTINCT unnest(v_labels))) THEN PERFORM _err('not_found', 'Étiquette introuvable'); END IF;
  DELETE FROM pf_contact_label_links WHERE contact_id = p_contact;
  INSERT INTO pf_contact_label_links(contact_id, label_id) SELECT p_contact, x FROM (SELECT DISTINCT unnest(v_labels) AS x) s;
END $$;

-- Import d'une liste (lue dans le fichier par l'écran) : [{name, phone, city}] ; les doublons et lignes invalides sont ignorés (Pro)
CREATE FUNCTION fn_pf_contact_import(p_actor uuid, p_rows jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; v_name text; v_phone text; v_city text; v_added int := 0; v_skipped int := 0;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pfct:' || p_actor::text));
  IF jsonb_typeof(p_rows) <> 'array' THEN PERFORM _err('invalid_input', 'Liste invalide'); END IF;
  IF jsonb_array_length(p_rows) > 500 THEN PERFORM _err('invalid_input', '500 lignes au plus par import'); END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_name := left(trim(COALESCE(r->>'name', '')), 60); v_phone := _pf_norm_phone(r->>'phone'); v_city := NULLIF(left(trim(COALESCE(r->>'city', '')), 40), '');
    IF length(v_name) < 2 OR v_phone !~ '^[0-9]{6,15}$' OR EXISTS (SELECT 1 FROM pf_contacts WHERE owner_id = p_actor AND phone = v_phone AND archived_at IS NULL) THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
    INSERT INTO pf_contacts(owner_id, name, phone, city, stage, origin) VALUES (p_actor, v_name, v_phone, v_city, 'prospect', 'import');
    v_added := v_added + 1;
  END LOOP;
  RETURN jsonb_build_object('added', v_added, 'skipped', v_skipped);
END $$;

-- Vendeur : ajoute à son carnet les clients de ses commandes (statut « client », origine « commande »). Ne touche à aucune commande.
CREATE FUNCTION fn_pf_contacts_from_orders(p_actor uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; v_added int := 0; v_free boolean; v_count int;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]); PERFORM _pf_feature_on();
  PERFORM pg_advisory_xact_lock(hashtext('pfct:' || p_actor::text));
  v_free := _pf_tier(p_actor) <> 'pro';
  SELECT count(*) INTO v_count FROM pf_contacts WHERE owner_id = p_actor AND archived_at IS NULL;
  FOR r IN SELECT o.customer_phone AS phone, (array_agg(o.customer_name ORDER BY o.created_at DESC))[1] AS name, (array_agg(o.commune ORDER BY o.created_at DESC))[1] AS city
           FROM orders o WHERE o.seller_id = p_actor AND o.status <> 'cancelled' GROUP BY o.customer_phone ORDER BY max(o.created_at) DESC LOOP
    IF EXISTS (SELECT 1 FROM pf_contacts WHERE owner_id = p_actor AND phone = _pf_norm_phone(r.phone) AND archived_at IS NULL) THEN CONTINUE; END IF;
    IF v_free AND v_count >= _setting('pf_free_contacts') THEN EXIT; END IF;
    IF length(trim(r.name)) < 2 THEN CONTINUE; END IF;
    INSERT INTO pf_contacts(owner_id, name, phone, city, stage, origin) VALUES (p_actor, left(trim(r.name), 60), _pf_norm_phone(r.phone), NULLIF(left(r.city, 40), ''), 'client', 'order');
    v_added := v_added + 1; v_count := v_count + 1;
  END LOOP;
  RETURN v_added;
END $$;

CREATE FUNCTION trg_pf_contacts_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pf_contact_label_links WHERE contact_id IN (SELECT id FROM pf_contacts WHERE owner_id = NEW.id);
  DELETE FROM pf_contact_notes WHERE owner_id = NEW.id;
  DELETE FROM pf_contact_labels WHERE owner_id = NEW.id;
  DELETE FROM pf_contacts WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_pf_contacts_anonymized() SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER users_pf_contacts_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_contacts_anonymized();

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
