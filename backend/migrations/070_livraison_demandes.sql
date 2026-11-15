-- 070 : livraison à la demande, côté expéditeur : inscription, demande d'envoi avec prix figé, suivi, annulation tant que non prise en charge.
-- Fermé par défaut : il faut que « Livraison à la demande » (feature_livraison_demande) ET « Inscription expéditeurs » (dlv_open_signup) soient à 1.
-- Cette étape ne fait PAS encore intervenir les livreurs ni l'argent : la prise en charge et l'encaissement viennent ensuite.
INSERT INTO settings(key, value, label) VALUES
  ('dlv_open_signup', 0, 'Livraison à la demande : inscription ouverte aux expéditeurs (1 = oui)'),
  ('dlv_daily_limit', 5, 'Livraison à la demande : demandes par expéditeur et par jour'),
  ('dlv_max_declared', 500000, 'Livraison à la demande : valeur déclarée maximale d''un colis (GNF)')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE dlv_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref            text NOT NULL UNIQUE,
  shipper_id     uuid NOT NULL REFERENCES users(id),
  from_place     text NOT NULL,
  from_address   text NOT NULL CHECK (length(from_address) BETWEEN 3 AND 200),
  to_place       text NOT NULL,
  to_address     text NOT NULL CHECK (length(to_address) BETWEEN 3 AND 200),
  receiver_name  text NOT NULL CHECK (length(receiver_name) BETWEEN 2 AND 100),
  receiver_phone text NOT NULL CHECK (receiver_phone ~ '^[0-9]{9}$'),
  description    text NOT NULL CHECK (length(description) BETWEEN 3 AND 300),
  weight_kg      numeric(7,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 1000),
  weight_class   text NOT NULL CHECK (weight_class IN ('light', 'heavy')),
  price          bigint NOT NULL CHECK (price >= 0),
  tariff_id      uuid REFERENCES dlv_tariffs(id),
  declared_value bigint NOT NULL CHECK (declared_value >= 0),
  payer          text NOT NULL CHECK (payer IN ('sender', 'receiver')),
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dlv_requests_shipper ON dlv_requests(shipper_id, created_at DESC);
CREATE INDEX dlv_requests_status ON dlv_requests(status, created_at DESC);

-- Inscription : un seul cas ajouté à fn_register (comme pour le membre, 053).
DO $$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('fn_register(text,text,user_role,text,text,text,text,text)'::regprocedure);
  n := replace(d, '_setting(''feature_finances_perso'') = 1) THEN', '_setting(''feature_finances_perso'') = 1) AND NOT (p_role::text = ''shipper'' AND _setting(''dlv_open_signup'') = 1 AND _setting(''feature_livraison_demande'') = 1) THEN');
  IF n = d THEN RAISE EXCEPTION 'fn_register : texte inattendu'; END IF;
  EXECUTE n;
END $$;

CREATE FUNCTION _dlv_ref() RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  LOOP
    r := 'LD-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM dlv_requests WHERE ref = r);
  END LOOP;
  RETURN r;
END $$;

CREATE FUNCTION fn_dlv_request_create(p_actor uuid, p_from text, p_from_address text, p_to text, p_to_address text, p_receiver_name text, p_receiver_phone text,
                                      p_description text, p_kg numeric, p_declared bigint, p_payer text, p_ack boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; v_q jsonb; v_id uuid; v_ref text; v_today int;
BEGIN
  u := _require(p_actor, ARRAY['shipper']::user_role[]);
  IF u.status <> 'active' THEN PERFORM _err('forbidden', 'Compte non actif'); END IF;
  IF _setting('feature_livraison_demande') <> 1 THEN PERFORM _err('forbidden', 'La livraison à la demande n''est pas ouverte'); END IF;
  IF p_ack IS NOT TRUE THEN PERFORM _err('invalid_input', 'Confirmez que le colis ne contient aucun objet interdit'); END IF;
  IF p_payer NOT IN ('sender', 'receiver') THEN PERFORM _err('invalid_input', 'Indiquez qui paie la course'); END IF;
  IF p_declared IS NULL OR p_declared < 0 OR p_declared > _setting('dlv_max_declared') THEN
    PERFORM _err('invalid_input', 'Valeur déclarée invalide (maximum ' || _setting('dlv_max_declared') || ' GNF)');
  END IF;
  SELECT count(*) INTO v_today FROM dlv_requests WHERE shipper_id = p_actor AND status <> 'cancelled' AND created_at >= date_trunc('day', now());
  IF v_today >= _setting('dlv_daily_limit') THEN PERFORM _err('limit', 'Limite de demandes atteinte pour aujourd''hui'); END IF;
  v_q := fn_dlv_quote(p_actor, p_from, p_to, p_kg);   -- prix figé à la création ; refuse un trajet sans tarif
  v_ref := _dlv_ref();
  BEGIN
    INSERT INTO dlv_requests(ref, shipper_id, from_place, from_address, to_place, to_address, receiver_name, receiver_phone, description, weight_kg, weight_class, price, tariff_id, declared_value, payer)
    VALUES (v_ref, p_actor, btrim(p_from), btrim(p_from_address), btrim(p_to), btrim(p_to_address), btrim(p_receiver_name), p_receiver_phone, btrim(p_description), p_kg,
            v_q->>'weight_class', (v_q->>'price')::bigint, (v_q->>'tariff_id')::uuid, p_declared, p_payer)
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Informations invalides : vérifiez adresses, nom, téléphone et description');
  END;
  PERFORM _audit(p_actor, 'dlv_request_created', 'dlv_request', v_id::text, jsonb_build_object('ref', v_ref, 'price', (v_q->>'price')::bigint, 'class', v_q->>'weight_class'));
  RETURN jsonb_build_object('id', v_id, 'ref', v_ref, 'price', (v_q->>'price')::bigint, 'weight_class', v_q->>'weight_class');
END $$;

CREATE FUNCTION fn_dlv_my_requests(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['shipper']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'ref', ref, 'from', from_place, 'to', to_place, 'to_address', to_address, 'receiver_name', receiver_name,
           'description', description, 'weight_kg', weight_kg, 'weight_class', weight_class, 'price', price, 'payer', payer, 'status', status, 'created_at', created_at) ORDER BY created_at DESC)
      FROM (SELECT * FROM dlv_requests WHERE shipper_id = p_actor ORDER BY created_at DESC LIMIT 100) r), '[]'::jsonb);
END $$;

-- Annulation : seulement par l'expéditeur, tant que personne n'a pris le colis en charge.
CREATE FUNCTION fn_dlv_request_cancel(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r dlv_requests;
BEGIN
  PERFORM _require(p_actor, ARRAY['shipper']::user_role[]);
  SELECT * INTO r FROM dlv_requests WHERE id = p_id AND shipper_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Demande introuvable'); END IF;
  IF r.status <> 'new' THEN PERFORM _err('invalid_state', 'Cette demande est déjà prise en charge : contactez-nous pour l''annuler'); END IF;
  UPDATE dlv_requests SET status = 'cancelled', updated_at = now() WHERE id = p_id;
  PERFORM _audit(p_actor, 'dlv_request_cancelled', 'dlv_request', p_id::text, jsonb_build_object('ref', r.ref));
END $$;

CREATE FUNCTION fn_admin_dlv_requests(p_actor uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'created_at') DESC) FROM (
    SELECT jsonb_build_object('id', r.id, 'ref', r.ref, 'shipper', u.full_name, 'shipper_phone', u.phone, 'from', r.from_place, 'from_address', r.from_address, 'to', r.to_place, 'to_address', r.to_address,
           'receiver_name', r.receiver_name, 'receiver_phone', r.receiver_phone, 'description', r.description, 'weight_kg', r.weight_kg, 'weight_class', r.weight_class, 'price', r.price,
           'declared_value', r.declared_value, 'payer', r.payer, 'status', r.status, 'created_at', r.created_at) AS x
      FROM dlv_requests r JOIN users u ON u.id = r.shipper_id
     WHERE p_status IS NULL OR r.status = p_status ORDER BY r.created_at DESC LIMIT 200) s), '[]'::jsonb);
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
