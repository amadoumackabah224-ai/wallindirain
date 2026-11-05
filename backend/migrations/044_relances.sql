-- 044 : relances des clients par le vendeur (SMS, WhatsApp, appel), étiquettes, rappels datés, fêtes.
-- Le vendeur écrit ou appelle ses clients un par un, avec son propre téléphone : Wallindirain prépare la liste et le suivi,
-- mais n'envoie rien. Le texte des messages n'est JAMAIS enregistré : seulement qui, quand et par quel canal.
-- Aucun montant de la plateforme n'est touché (ni portefeuille, ni frais, ni marge, ni tarif). Aucune table existante n'est modifiée.
-- La fonction est éteinte par défaut (réglage feature_relances = 0) : l'administrateur l'allume dans « Réglages ».

INSERT INTO settings(key, value, label) VALUES
  ('feature_relances', 0, 'Relances des clients par le vendeur (0 = éteint, 1 = allumé)');

-- Réglages propres à chaque vendeur : engagement, maximum de messages par jour (vide = aucune limite), délai entre deux messages
CREATE TABLE relance_prefs (
  seller_id       uuid PRIMARY KEY REFERENCES users(id),
  consent_version int,
  consent_at      timestamptz,
  daily_max       int CHECK (daily_max IS NULL OR daily_max BETWEEN 1 AND 100000),
  interval_days   int NOT NULL DEFAULT 14 CHECK (interval_days BETWEEN 7 AND 365),
  shop_name       text CHECK (shop_name IS NULL OR length(trim(shop_name)) BETWEEN 2 AND 40),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- « Ne plus contacter » : un client désinscrit disparaît de toutes les listes du vendeur ; seul l'administrateur peut le réactiver
CREATE TABLE relance_optouts (
  seller_id      uuid NOT NULL REFERENCES users(id),
  customer_phone text NOT NULL CHECK (customer_phone ~ '^[0-9]{9}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_id, customer_phone)
);

-- Modèles de messages du vendeur (jamais le texte réellement envoyé). Seules marques permises : {prenom}, {boutique}, {fete}
CREATE TABLE relance_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id  uuid NOT NULL REFERENCES users(id),
  title      text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 40),
  body       text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX relance_templates_seller_idx ON relance_templates(seller_id) WHERE deleted_at IS NULL;

-- Journal des relances : qui, quand, par quel canal (jamais le texte). Pour un appel : le résultat.
CREATE TABLE relance_log (
  id             bigserial PRIMARY KEY,
  seller_id      uuid NOT NULL REFERENCES users(id),
  customer_phone text NOT NULL CHECK (customer_phone ~ '^[0-9]{9}$'),
  channel        text NOT NULL CHECK (channel IN ('sms','whatsapp','call')),
  outcome        text CHECK (outcome IS NULL OR outcome IN ('answered','no_answer','call_back')),
  list_key       text CHECK (list_key IS NULL OR list_key IN ('fideles','nouveaux','inactifs','non_abouti','etiquette','fete','rappels')),
  at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((channel = 'call') = (outcome IS NOT NULL))
);
CREATE INDEX relance_log_customer_idx ON relance_log(seller_id, customer_phone, at DESC);
CREATE INDEX relance_log_day_idx ON relance_log(seller_id, at DESC);

-- Étiquettes créées par le vendeur (avec une couleur), plusieurs par client
CREATE TABLE relance_tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id  uuid NOT NULL REFERENCES users(id),
  name       text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 30),
  color      text NOT NULL CHECK (color IN ('green','red','gold','blue','grey')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX relance_tags_name_idx ON relance_tags(seller_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE relance_customer_tags (
  tag_id         uuid NOT NULL REFERENCES relance_tags(id),
  seller_id      uuid NOT NULL REFERENCES users(id),
  customer_phone text NOT NULL CHECK (customer_phone ~ '^[0-9]{9}$'),
  PRIMARY KEY (tag_id, customer_phone)
);
CREATE INDEX relance_customer_tags_idx ON relance_customer_tags(seller_id, customer_phone);

-- Rappel daté : un seul par client (« rappeler vendredi »). Simple affichage, sans notification.
CREATE TABLE relance_reminders (
  seller_id      uuid NOT NULL REFERENCES users(id),
  customer_phone text NOT NULL CHECK (customer_phone ~ '^[0-9]{9}$'),
  due_on         date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_id, customer_phone)
);

-- Fêtes saisies par le vendeur lui-même (aucune date n'est mise d'avance : celle de la Tabaski change chaque année)
CREATE TABLE relance_feasts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id  uuid NOT NULL REFERENCES users(id),
  name       text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  on_date    date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX relance_feasts_seller_idx ON relance_feasts(seller_id, on_date) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- Règles
-- ---------------------------------------------------------------------
-- Version du texte d'engagement affiché au vendeur : si le texte change, on augmente ce numéro et chacun doit le reconfirmer.
CREATE FUNCTION _relance_consent_version() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;

CREATE FUNCTION _relance_feature_on() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF _setting('feature_relances') < 1 THEN PERFORM _err('feature_off', 'Les relances ne sont pas encore activées'); END IF;
END $$;

-- Toutes les règles de contact en un seul endroit : appelée avant d'ouvrir SMS, WhatsApp ou l'appel, puis à nouveau à l'enregistrement.
CREATE FUNCTION _relance_check(p_actor uuid, p_phone text, p_channel text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pr relance_prefs; v_last timestamptz; v_today int;
BEGIN
  PERFORM _relance_feature_on();
  IF p_phone IS NULL OR p_phone !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro du client invalide'); END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('sms','whatsapp','call') THEN PERFORM _err('invalid_input', 'Canal invalide'); END IF;
  SELECT * INTO pr FROM relance_prefs WHERE seller_id = p_actor;
  IF NOT FOUND OR pr.consent_version IS DISTINCT FROM _relance_consent_version() THEN
    PERFORM _err('consent_required', 'Confirmez d''abord votre engagement avant d''utiliser les relances');
  END IF;
  -- seulement un client qui a déjà commandé chez ce vendeur (jamais ceux d'un autre vendeur)
  IF NOT EXISTS (SELECT 1 FROM orders WHERE seller_id = p_actor AND customer_phone = p_phone AND status <> 'cancelled') THEN
    PERFORM _err('not_found', 'Client introuvable');
  END IF;
  IF EXISTS (SELECT 1 FROM relance_optouts WHERE seller_id = p_actor AND customer_phone = p_phone) THEN
    PERFORM _err('opted_out', 'Ce client a demandé à ne plus être contacté');
  END IF;
  IF EXISTS (SELECT 1 FROM risky_customers WHERE customer_phone = p_phone) THEN
    PERFORM _err('risky_customer', 'Client à risque : il n''est jamais contacté par les relances');
  END IF;
  IF p_channel IN ('sms','whatsapp') THEN
    -- un message par client tous les N jours (N choisi par le vendeur, 7 jours au minimum), bloqué par le serveur
    SELECT max(at) INTO v_last FROM relance_log WHERE seller_id = p_actor AND customer_phone = p_phone AND channel IN ('sms','whatsapp');
    IF v_last IS NOT NULL AND v_last > now() - make_interval(days => pr.interval_days) THEN
      PERFORM _err('too_soon', 'Ce client a déjà reçu un message le ' || to_char(v_last, 'DD/MM') || ' : prochain message possible à partir du ' || to_char(v_last + make_interval(days => pr.interval_days), 'DD/MM'));
    END IF;
    SELECT count(*)::int INTO v_today FROM relance_log WHERE seller_id = p_actor AND channel IN ('sms','whatsapp') AND at >= date_trunc('day', now());
    -- le maximum par jour est choisi par le vendeur ; sans maximum, aucune limite
    IF pr.daily_max IS NOT NULL AND v_today >= pr.daily_max THEN
      PERFORM _err('daily_limit', 'Vous avez atteint votre maximum de ' || pr.daily_max || ' messages aujourd''hui. Changez-le dans vos réglages pour continuer.');
    END IF;
    -- protection technique cachée contre un défaut qui enverrait des milliers de demandes d'un coup
    IF v_today >= 3000 THEN
      PERFORM _err('daily_limit', 'Limite de sécurité atteinte (3 000 messages par jour). Contactez le support si c''est normal.');
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Engagement et réglages du vendeur
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_seller_relance_consent(p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _relance_feature_on();
  INSERT INTO relance_prefs(seller_id, consent_version, consent_at) VALUES (p_actor, _relance_consent_version(), now())
  ON CONFLICT (seller_id) DO UPDATE SET consent_version = EXCLUDED.consent_version, consent_at = EXCLUDED.consent_at, updated_at = now();
  PERFORM _audit(p_actor, 'relance_consent', 'user', p_actor::text, jsonb_build_object('version', _relance_consent_version()));
END $$;

-- p_daily_max NULL = aucune limite ; p_interval entre 7 et 365 jours ; p_shop = nom de la boutique pour les messages
CREATE FUNCTION fn_seller_relance_set_prefs(p_actor uuid, p_daily_max int, p_interval int, p_shop text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_shop text := NULLIF(trim(COALESCE(p_shop, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _relance_feature_on();
  IF p_daily_max IS NOT NULL AND (p_daily_max < 1 OR p_daily_max > 100000) THEN PERFORM _err('invalid_input', 'Maximum par jour invalide (1 à 100 000, ou vide pour aucune limite)'); END IF;
  IF p_interval IS NULL OR p_interval < 7 OR p_interval > 365 THEN PERFORM _err('invalid_input', 'Le délai entre deux messages doit être de 7 jours au moins (365 au plus)'); END IF;
  IF v_shop IS NOT NULL AND length(v_shop) NOT BETWEEN 2 AND 40 THEN PERFORM _err('invalid_input', 'Nom de boutique invalide (2 à 40 caractères)'); END IF;
  INSERT INTO relance_prefs(seller_id, daily_max, interval_days, shop_name) VALUES (p_actor, p_daily_max, p_interval, v_shop)
  ON CONFLICT (seller_id) DO UPDATE SET daily_max = EXCLUDED.daily_max, interval_days = EXCLUDED.interval_days, shop_name = EXCLUDED.shop_name, updated_at = now();
  PERFORM _audit(p_actor, 'relance_prefs', 'user', p_actor::text, jsonb_build_object('daily_max', p_daily_max, 'interval_days', p_interval));
END $$;

-- ---------------------------------------------------------------------
-- Contacter un client
-- ---------------------------------------------------------------------
-- Vérification avant d'ouvrir SMS, WhatsApp ou l'appel : lève une erreur si le contact n'est pas permis. N'écrit rien.
CREATE FUNCTION fn_seller_relance_open(p_actor uuid, p_phone text, p_channel text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _relance_check(p_actor, p_phone, p_channel);
END $$;

-- Enregistre la relance (« C'est envoyé » pour un message ; résultat pour un appel). Vérifie les règles une seconde fois.
-- Pour un appel : p_outcome = answered | no_answer | call_back ; « à rappeler » crée un rappel (p_remind_on, sinon demain).
CREATE FUNCTION fn_seller_relance_log(p_actor uuid, p_phone text, p_channel text, p_outcome text, p_list text, p_remind_on date) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_channel = 'call' AND (p_outcome IS NULL OR p_outcome NOT IN ('answered','no_answer','call_back')) THEN PERFORM _err('invalid_input', 'Indiquez le résultat de l''appel'); END IF;
  IF p_channel IN ('sms','whatsapp') AND p_outcome IS NOT NULL THEN PERFORM _err('invalid_input', 'Un message n''a pas de résultat d''appel'); END IF;
  IF p_list IS NOT NULL AND p_list NOT IN ('fideles','nouveaux','inactifs','non_abouti','etiquette','fete','rappels') THEN PERFORM _err('invalid_input', 'Liste invalide'); END IF;
  IF p_remind_on IS NOT NULL AND (p_remind_on < current_date OR p_remind_on > current_date + 365) THEN PERFORM _err('invalid_input', 'Date de rappel invalide'); END IF;
  -- un vendeur à la fois : deux appuis rapides ne peuvent pas dépasser le délai entre deux messages ni le maximum par jour
  PERFORM pg_advisory_xact_lock(hashtextextended('relance:' || p_actor::text, 0));
  PERFORM _relance_check(p_actor, p_phone, p_channel);
  INSERT INTO relance_log(seller_id, customer_phone, channel, outcome, list_key) VALUES (p_actor, p_phone, p_channel, p_outcome, p_list) RETURNING id INTO v_id;
  DELETE FROM relance_reminders WHERE seller_id = p_actor AND customer_phone = p_phone;   -- le client vient d'être relancé : le rappel est fait
  IF p_outcome = 'call_back' THEN
    INSERT INTO relance_reminders(seller_id, customer_phone, due_on) VALUES (p_actor, p_phone, COALESCE(p_remind_on, current_date + 1));
  END IF;
  RETURN v_id;
END $$;

-- « Ne plus contacter » : toujours permis (même si la fonction est éteinte) ; seul l'administrateur peut revenir en arrière
CREATE FUNCTION fn_seller_relance_optout(p_actor uuid, p_phone text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_phone IS NULL OR p_phone !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro du client invalide'); END IF;
  IF NOT EXISTS (SELECT 1 FROM orders WHERE seller_id = p_actor AND customer_phone = p_phone) THEN PERFORM _err('not_found', 'Client introuvable'); END IF;
  INSERT INTO relance_optouts(seller_id, customer_phone) VALUES (p_actor, p_phone) ON CONFLICT DO NOTHING;
  DELETE FROM relance_reminders WHERE seller_id = p_actor AND customer_phone = p_phone;
  PERFORM _audit(p_actor, 'relance_optout', 'customer', p_phone, jsonb_build_object('seller', p_actor));
END $$;

CREATE FUNCTION fn_admin_relance_reactivate(p_actor uuid, p_seller uuid, p_phone text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  DELETE FROM relance_optouts WHERE seller_id = p_seller AND customer_phone = p_phone;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Ce client n''est pas désinscrit'); END IF;
  PERFORM _audit(p_actor, 'relance_optout_removed', 'customer', p_phone, jsonb_build_object('seller', p_seller));
END $$;

-- Rappel daté (p_date NULL = efface le rappel)
CREATE FUNCTION fn_seller_relance_remind(p_actor uuid, p_phone text, p_date date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _relance_feature_on();
  IF p_phone IS NULL OR p_phone !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro du client invalide'); END IF;
  IF NOT EXISTS (SELECT 1 FROM orders WHERE seller_id = p_actor AND customer_phone = p_phone AND status <> 'cancelled') THEN PERFORM _err('not_found', 'Client introuvable'); END IF;
  IF p_date IS NULL THEN
    DELETE FROM relance_reminders WHERE seller_id = p_actor AND customer_phone = p_phone;
    RETURN;
  END IF;
  IF p_date < current_date OR p_date > current_date + 365 THEN PERFORM _err('invalid_input', 'Date de rappel invalide (aujourd''hui ou plus tard, un an au plus)'); END IF;
  IF EXISTS (SELECT 1 FROM relance_optouts WHERE seller_id = p_actor AND customer_phone = p_phone) THEN PERFORM _err('opted_out', 'Ce client a demandé à ne plus être contacté'); END IF;
  IF EXISTS (SELECT 1 FROM risky_customers WHERE customer_phone = p_phone) THEN PERFORM _err('risky_customer', 'Client à risque : il n''est jamais contacté par les relances'); END IF;
  INSERT INTO relance_reminders(seller_id, customer_phone, due_on) VALUES (p_actor, p_phone, p_date)
  ON CONFLICT (seller_id, customer_phone) DO UPDATE SET due_on = EXCLUDED.due_on, created_at = now();
END $$;

-- ---------------------------------------------------------------------
-- Modèles de messages
-- ---------------------------------------------------------------------
-- p_id NULL = nouveau modèle ; sinon modification d'un modèle du vendeur
CREATE FUNCTION fn_seller_relance_template_save(p_actor uuid, p_id uuid, p_title text, p_body text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_title text := trim(COALESCE(p_title, '')); v_body text := trim(COALESCE(p_body, '')); m text; v_id uuid := p_id;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _relance_feature_on();
  IF length(v_title) NOT BETWEEN 1 AND 40 THEN PERFORM _err('invalid_input', 'Titre invalide (1 à 40 caractères)'); END IF;
  IF length(v_body) NOT BETWEEN 1 AND 300 THEN PERFORM _err('invalid_input', 'Message invalide (1 à 300 caractères)'); END IF;
  -- seules les marques {prenom}, {boutique} et {fete} sont permises : jamais une information de commande ou un code de livraison
  FOR m IN SELECT (regexp_matches(v_body, '\{[^}]*\}', 'g'))[1] LOOP
    IF m NOT IN ('{prenom}', '{boutique}', '{fete}') THEN PERFORM _err('invalid_input', 'Marque inconnue ' || m || ' : utilisez seulement {prenom}, {boutique} ou {fete}'); END IF;
  END LOOP;
  IF v_id IS NULL THEN
    IF (SELECT count(*) FROM relance_templates WHERE seller_id = p_actor AND deleted_at IS NULL) >= 30 THEN PERFORM _err('invalid_state', 'Vous avez déjà 30 modèles : supprimez-en un d''abord'); END IF;
    INSERT INTO relance_templates(seller_id, title, body) VALUES (p_actor, v_title, v_body) RETURNING id INTO v_id;
  ELSE
    UPDATE relance_templates SET title = v_title, body = v_body WHERE id = v_id AND seller_id = p_actor AND deleted_at IS NULL;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Modèle introuvable'); END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_seller_relance_template_delete(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  UPDATE relance_templates SET deleted_at = now() WHERE id = p_id AND seller_id = p_actor AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Modèle introuvable'); END IF;
END $$;

-- ---------------------------------------------------------------------
-- Étiquettes du vendeur
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_seller_relance_tag_create(p_actor uuid, p_name text, p_color text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_name text := trim(COALESCE(p_name, '')); v_id uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _relance_feature_on();
  IF length(v_name) NOT BETWEEN 1 AND 30 THEN PERFORM _err('invalid_input', 'Nom d''étiquette invalide (1 à 30 caractères)'); END IF;
  IF p_color IS NULL OR p_color NOT IN ('green','red','gold','blue','grey') THEN PERFORM _err('invalid_input', 'Couleur invalide'); END IF;
  IF (SELECT count(*) FROM relance_tags WHERE seller_id = p_actor AND deleted_at IS NULL) >= 30 THEN PERFORM _err('invalid_state', 'Vous avez déjà 30 étiquettes : supprimez-en une d''abord'); END IF;
  IF EXISTS (SELECT 1 FROM relance_tags WHERE seller_id = p_actor AND lower(name) = lower(v_name) AND deleted_at IS NULL) THEN PERFORM _err('invalid_state', 'Cette étiquette existe déjà'); END IF;
  INSERT INTO relance_tags(seller_id, name, color) VALUES (p_actor, v_name, p_color) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_seller_relance_tag_delete(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  UPDATE relance_tags SET deleted_at = now() WHERE id = p_id AND seller_id = p_actor AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Étiquette introuvable'); END IF;
  DELETE FROM relance_customer_tags WHERE tag_id = p_id AND seller_id = p_actor;
END $$;

-- Met (p_on = vrai) ou retire (faux) une étiquette sur un client
CREATE FUNCTION fn_seller_relance_tag_set(p_actor uuid, p_tag uuid, p_phone text, p_on boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _relance_feature_on();
  IF p_phone IS NULL OR p_phone !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro du client invalide'); END IF;
  IF NOT EXISTS (SELECT 1 FROM relance_tags WHERE id = p_tag AND seller_id = p_actor AND deleted_at IS NULL) THEN PERFORM _err('not_found', 'Étiquette introuvable'); END IF;
  IF NOT EXISTS (SELECT 1 FROM orders WHERE seller_id = p_actor AND customer_phone = p_phone) THEN PERFORM _err('not_found', 'Client introuvable'); END IF;
  IF COALESCE(p_on, false) THEN
    IF (SELECT count(*) FROM relance_customer_tags WHERE seller_id = p_actor AND customer_phone = p_phone) >= 10
       AND NOT EXISTS (SELECT 1 FROM relance_customer_tags WHERE tag_id = p_tag AND customer_phone = p_phone) THEN
      PERFORM _err('invalid_state', 'Un client ne peut pas avoir plus de 10 étiquettes');
    END IF;
    INSERT INTO relance_customer_tags(tag_id, seller_id, customer_phone) VALUES (p_tag, p_actor, p_phone) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM relance_customer_tags WHERE tag_id = p_tag AND seller_id = p_actor AND customer_phone = p_phone;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Fêtes
-- ---------------------------------------------------------------------
-- p_id NULL = nouvelle fête
CREATE FUNCTION fn_seller_relance_feast_save(p_actor uuid, p_id uuid, p_name text, p_date date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_name text := trim(COALESCE(p_name, '')); v_id uuid := p_id;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _relance_feature_on();
  IF length(v_name) NOT BETWEEN 1 AND 40 THEN PERFORM _err('invalid_input', 'Nom de la fête invalide (1 à 40 caractères)'); END IF;
  IF p_date IS NULL OR p_date < current_date OR p_date > current_date + 730 THEN PERFORM _err('invalid_input', 'Date invalide (aujourd''hui ou plus tard, deux ans au plus)'); END IF;
  IF v_id IS NULL THEN
    IF (SELECT count(*) FROM relance_feasts WHERE seller_id = p_actor AND deleted_at IS NULL) >= 20 THEN PERFORM _err('invalid_state', 'Vous avez déjà 20 fêtes : supprimez-en une d''abord'); END IF;
    INSERT INTO relance_feasts(seller_id, name, on_date) VALUES (p_actor, v_name, p_date) RETURNING id INTO v_id;
  ELSE
    UPDATE relance_feasts SET name = v_name, on_date = p_date WHERE id = v_id AND seller_id = p_actor AND deleted_at IS NULL;
    IF NOT FOUND THEN PERFORM _err('not_found', 'Fête introuvable'); END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_seller_relance_feast_delete(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  UPDATE relance_feasts SET deleted_at = now() WHERE id = p_id AND seller_id = p_actor AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Fête introuvable'); END IF;
END $$;

-- ---------------------------------------------------------------------
-- Lecture : tous les clients d'un vendeur, avec ce qu'il faut pour calculer étiquettes et listes (un vendeur ne voit que les siens)
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_seller_relance_customers(p_actor uuid) RETURNS TABLE(
  phone text, name text, commune text, orders int, delivered int, failed int, absent int, paid int,
  first_delivered_at timestamptz, last_delivered_at timestamptz, last_order_at timestamptz, last_status text,
  risk_incidents int, opted_out boolean, last_message_at timestamptz, last_contact_at timestamptz, reminder_on date, note text, tag_ids uuid[])
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  RETURN QUERY
  SELECT a.phone, a.name, a.commune, a.orders, a.delivered, a.failed, a.absent, a.paid, a.first_delivered_at, a.last_delivered_at, a.last_order_at, a.last_status,
    (SELECT r.incidents FROM risky_customers r WHERE r.customer_phone = a.phone),
    EXISTS (SELECT 1 FROM relance_optouts x WHERE x.seller_id = p_actor AND x.customer_phone = a.phone),
    (SELECT max(l.at) FROM relance_log l WHERE l.seller_id = p_actor AND l.customer_phone = a.phone AND l.channel IN ('sms','whatsapp')),
    (SELECT max(l.at) FROM relance_log l WHERE l.seller_id = p_actor AND l.customer_phone = a.phone),
    (SELECT m.due_on FROM relance_reminders m WHERE m.seller_id = p_actor AND m.customer_phone = a.phone),
    (SELECT n.note FROM seller_customer_notes n WHERE n.seller_id = p_actor AND n.customer_phone = a.phone),
    COALESCE((SELECT array_agg(ct.tag_id) FROM relance_customer_tags ct JOIN relance_tags t ON t.id = ct.tag_id AND t.deleted_at IS NULL
               WHERE ct.seller_id = p_actor AND ct.customer_phone = a.phone), ARRAY[]::uuid[])
  FROM (
    SELECT o.customer_phone AS phone,
      (array_agg(o.customer_name ORDER BY o.created_at DESC))[1] AS name,
      (array_agg(o.commune ORDER BY o.created_at DESC))[1] AS commune,
      count(*)::int AS orders,
      count(*) FILTER (WHERE o.status = 'delivered')::int AS delivered,
      count(*) FILTER (WHERE o.status IN ('failed','return_pending','returned','refused'))::int AS failed,
      count(*) FILTER (WHERE o.status IN ('failed','return_pending','returned','refused') AND o.failure_reason = 'customer_absent')::int AS absent,
      count(*) FILTER (WHERE o.status = 'delivered' AND EXISTS (SELECT 1 FROM wallet_entries w WHERE w.order_id = o.id AND w.user_id = p_actor AND w.kind = 'seller_gain'))::int AS paid,
      min(o.delivered_at) FILTER (WHERE o.status = 'delivered') AS first_delivered_at,
      max(o.delivered_at) FILTER (WHERE o.status = 'delivered') AS last_delivered_at,
      max(o.created_at) AS last_order_at,
      (array_agg(o.status::text ORDER BY o.created_at DESC))[1] AS last_status
    FROM orders o WHERE o.seller_id = p_actor AND o.status <> 'cancelled' GROUP BY o.customer_phone
  ) a;
END $$;

-- ---------------------------------------------------------------------
-- Vie privée : quand un compte vendeur est anonymisé, ses données de relance (numéros de ses clients) sont supprimées.
-- Trigger à part : les fonctions existantes ne sont pas modifiées.
-- ---------------------------------------------------------------------
CREATE FUNCTION trg_relances_user_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM relance_customer_tags WHERE seller_id = NEW.id;
  DELETE FROM relance_tags WHERE seller_id = NEW.id;
  DELETE FROM relance_reminders WHERE seller_id = NEW.id;
  DELETE FROM relance_log WHERE seller_id = NEW.id;
  DELETE FROM relance_optouts WHERE seller_id = NEW.id;
  DELETE FROM relance_templates WHERE seller_id = NEW.id;
  DELETE FROM relance_feasts WHERE seller_id = NEW.id;
  DELETE FROM relance_prefs WHERE seller_id = NEW.id;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_relances_user_anonymized() SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER users_relances_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_relances_user_anonymized();

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
