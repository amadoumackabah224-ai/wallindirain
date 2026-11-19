-- 074 : annonces en fenêtre (comme les messages d'Orange) : image, titre, texte, bouton, public, dates, fréquence, statistiques.
-- Désactivé par défaut : rien n'est affiché tant que l'administrateur n'a pas activé « feature_popups » ET publié une annonce.
-- Rien n'est supprimé : une annonce se met en brouillon ou à l'archive. Les annonces existantes (cloche) ne changent pas.

INSERT INTO settings(key, value, label) VALUES
  ('feature_popups', 0, 'Annonces en fenêtre à l''ouverture de l''application (1 = oui)')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE popups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  body        text CHECK (body IS NULL OR length(body) <= 400),
  image_mime  text CHECK (image_mime IS NULL OR image_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  image_data  bytea CHECK (image_data IS NULL OR octet_length(image_data) <= 700000),
  audience    text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','seller','supplier','agent','call_chief','courier','warehouse','shipper','member')),
  cta_label   text CHECK (cta_label IS NULL OR length(cta_label) BETWEEN 2 AND 30),
  cta_target  text CHECK (cta_target IS NULL OR cta_target ~ '^tab:[a-z]{2,20}$' OR cta_target ~ '^https://[^[:space:]]{4,255}$'),
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  frequency   text NOT NULL DEFAULT 'once' CHECK (frequency IN ('once', 'daily')),
  active      boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK ((cta_label IS NULL) = (cta_target IS NULL))
);

CREATE TABLE popup_views (
  popup_id      uuid NOT NULL REFERENCES popups(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  seen_count    int NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  clicked_at    timestamptz,
  closed_at     timestamptz,
  PRIMARY KEY (popup_id, user_id)
);
CREATE INDEX popup_views_user ON popup_views(user_id);

CREATE FUNCTION fn_admin_popup_save(p_actor uuid, p_id uuid, p_title text, p_body text, p_audience text, p_cta_label text, p_cta_target text,
                                    p_starts timestamptz, p_ends timestamptz, p_frequency text, p_mime text, p_image bytea) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := p_id; v_label text := NULLIF(trim(COALESCE(p_cta_label, '')), ''); v_target text := NULLIF(trim(COALESCE(p_cta_target, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF length(trim(COALESCE(p_title, ''))) NOT BETWEEN 3 AND 120 THEN PERFORM _err('invalid_input', 'Le titre doit faire entre 3 et 120 caractères'); END IF;
  IF length(COALESCE(p_body, '')) > 400 THEN PERFORM _err('invalid_input', 'Le texte fait 400 caractères au maximum'); END IF;
  IF (v_label IS NULL) <> (v_target IS NULL) THEN PERFORM _err('invalid_input', 'Le bouton demande un texte et une destination'); END IF;
  IF p_ends IS NOT NULL AND p_ends <= COALESCE(p_starts, now()) THEN PERFORM _err('invalid_input', 'La fin doit être après le début'); END IF;
  IF p_image IS NOT NULL AND (p_mime IS NULL OR octet_length(p_image) > 700000) THEN PERFORM _err('invalid_input', 'Image invalide ou trop lourde'); END IF;
  BEGIN
    IF v_id IS NULL THEN
      INSERT INTO popups(title, body, image_mime, image_data, audience, cta_label, cta_target, starts_at, ends_at, frequency, created_by)
        VALUES (trim(p_title), NULLIF(trim(COALESCE(p_body, '')), ''), p_mime, p_image, COALESCE(p_audience, 'all'), v_label, v_target, COALESCE(p_starts, now()), p_ends, COALESCE(p_frequency, 'once'), p_actor)
        RETURNING id INTO v_id;
    ELSE
      UPDATE popups SET title = trim(p_title), body = NULLIF(trim(COALESCE(p_body, '')), ''), audience = COALESCE(p_audience, audience), cta_label = v_label, cta_target = v_target,
             starts_at = COALESCE(p_starts, starts_at), ends_at = p_ends, frequency = COALESCE(p_frequency, frequency),
             image_mime = CASE WHEN p_image IS NOT NULL THEN p_mime ELSE image_mime END, image_data = COALESCE(p_image, image_data), updated_at = now()
       WHERE id = v_id AND archived_at IS NULL;
      IF NOT FOUND THEN PERFORM _err('not_found', 'Annonce introuvable'); END IF;
    END IF;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Annonce invalide : vérifiez le public, le bouton (adresse https ou écran de l''application) et l''image');
  END;
  PERFORM _audit(p_actor, 'popup_saved', 'popup', v_id::text, jsonb_build_object('audience', COALESCE(p_audience, 'all')));
  RETURN v_id;
END $$;

CREATE FUNCTION fn_admin_popup_active(p_actor uuid, p_id uuid, p_active boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  UPDATE popups SET active = COALESCE(p_active, false), updated_at = now() WHERE id = p_id AND archived_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Annonce introuvable'); END IF;
  PERFORM _audit(p_actor, CASE WHEN p_active THEN 'popup_published' ELSE 'popup_unpublished' END, 'popup', p_id::text, '{}'::jsonb);
END $$;

CREATE FUNCTION fn_admin_popup_archive(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  UPDATE popups SET active = false, archived_at = now(), updated_at = now() WHERE id = p_id AND archived_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Annonce introuvable'); END IF;
  PERFORM _audit(p_actor, 'popup_archived', 'popup', p_id::text, '{}'::jsonb);
END $$;

CREATE FUNCTION fn_admin_popups(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN jsonb_build_object('enabled', _setting('feature_popups') = 1, 'popups', COALESCE((SELECT jsonb_agg(x ORDER BY x->>'created_at' DESC) FROM (
    SELECT jsonb_build_object('id', p.id, 'title', p.title, 'body', p.body, 'audience', p.audience, 'cta_label', p.cta_label, 'cta_target', p.cta_target,
             'starts_at', p.starts_at, 'ends_at', p.ends_at, 'frequency', p.frequency, 'active', p.active, 'has_image', p.image_data IS NOT NULL, 'created_at', p.created_at,
             'live', p.active AND p.starts_at <= now() AND (p.ends_at IS NULL OR p.ends_at > now()),
             'views', (SELECT count(*) FROM popup_views v WHERE v.popup_id = p.id), 'clicks', (SELECT count(*) FROM popup_views v WHERE v.popup_id = p.id AND v.clicked_at IS NOT NULL),
             'closed', (SELECT count(*) FROM popup_views v WHERE v.popup_id = p.id AND v.closed_at IS NOT NULL)) AS x
      FROM popups p WHERE p.archived_at IS NULL ORDER BY p.created_at DESC LIMIT 50) s), '[]'::jsonb));
END $$;

-- La prochaine annonce à montrer à cette personne (ou NULL) : fonction active, annonce publiée, dans ses dates, pour son rôle, pas déjà vue selon la fréquence
CREATE FUNCTION fn_popup_next(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users; p popups;
BEGIN
  IF _setting('feature_popups') <> 1 THEN RETURN NULL; END IF;
  SELECT * INTO u FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND OR u.role = 'system' THEN RETURN NULL; END IF;
  SELECT pp.* INTO p FROM popups pp
   WHERE pp.active AND pp.archived_at IS NULL AND pp.starts_at <= now() AND (pp.ends_at IS NULL OR pp.ends_at > now())
     AND (pp.audience = 'all' OR pp.audience = u.role::text)
     AND NOT EXISTS (SELECT 1 FROM popup_views v WHERE v.popup_id = pp.id AND v.user_id = p_actor
                      AND (pp.frequency = 'once' OR v.last_seen_at >= date_trunc('day', now())))
   ORDER BY pp.created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', p.id, 'title', p.title, 'body', p.body, 'has_image', p.image_data IS NOT NULL, 'cta_label', p.cta_label, 'cta_target', p.cta_target);
END $$;

CREATE FUNCTION fn_popup_event(p_actor uuid, p_id uuid, p_event text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_event NOT IN ('seen', 'click', 'close') THEN PERFORM _err('invalid_input', 'Événement inconnu'); END IF;
  PERFORM 1 FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Compte inactif ou introuvable'); END IF;
  PERFORM 1 FROM popups WHERE id = p_id AND archived_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO popup_views(popup_id, user_id, seen_count, clicked_at, closed_at)
    VALUES (p_id, p_actor, CASE WHEN p_event = 'seen' THEN 1 ELSE 0 END, CASE WHEN p_event = 'click' THEN now() END, CASE WHEN p_event = 'close' THEN now() END)
  ON CONFLICT (popup_id, user_id) DO UPDATE SET
    seen_count = popup_views.seen_count + CASE WHEN p_event = 'seen' THEN 1 ELSE 0 END,
    last_seen_at = CASE WHEN p_event = 'seen' THEN now() ELSE popup_views.last_seen_at END,
    clicked_at = CASE WHEN p_event = 'click' THEN COALESCE(popup_views.clicked_at, now()) ELSE popup_views.clicked_at END,
    closed_at = CASE WHEN p_event = 'close' THEN now() ELSE popup_views.closed_at END;
END $$;

CREATE FUNCTION fn_popup_image_get(p_actor uuid, p_id uuid) RETURNS TABLE(mime text, data bytea) LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM 1 FROM users WHERE id = p_actor AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('forbidden', 'Compte inactif ou introuvable'); END IF;
  RETURN QUERY SELECT p.image_mime, p.image_data FROM popups p WHERE p.id = p_id AND p.image_data IS NOT NULL AND p.archived_at IS NULL;
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
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'))
       AND NOT (r.relname = 'courier_vehicles' AND column_name IN ('plate_img','card_img'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

GRANT SELECT ON pf_all_tx TO wld_app;
