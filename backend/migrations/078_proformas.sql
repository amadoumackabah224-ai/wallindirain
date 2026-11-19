-- 078 : proformas. Un devis du vendeur pour un client, sur un produit du catalogue : il ne touche NI le stock, NI l'argent, NI les statistiques.
-- À la confirmation du client, il devient une vraie commande par la fonction EXISTANTE de création de commande (mêmes contrôles : prix, stock, risque).
-- Réglage feature_proformas, éteint par défaut. Retour arrière : docs/retour-arriere-078.sql (refusé s'il existe des proformas : rien n'est supprimé).
INSERT INTO settings(key, value, label) VALUES
  ('feature_proformas', 0, 'Proformas (devis du vendeur transformables en commande) : 1 = oui, 0 = non')
ON CONFLICT (key) DO NOTHING;

CREATE SEQUENCE proforma_seq;
CREATE TABLE proformas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text NOT NULL UNIQUE,
  seller_id      uuid NOT NULL REFERENCES users(id),
  product_id     uuid NOT NULL REFERENCES products(id),
  unit_price     bigint NOT NULL CHECK (unit_price > 0),
  qty            int NOT NULL CHECK (qty BETWEEN 1 AND 100),
  customer_name  text NOT NULL CHECK (length(customer_name) BETWEEN 2 AND 120),
  customer_phone text NOT NULL CHECK (customer_phone ~ '^[0-9+ ]{8,16}$'),
  commune        text NOT NULL CHECK (length(commune) BETWEEN 2 AND 80),
  address        text NOT NULL CHECK (length(address) BETWEEN 3 AND 300),
  note           text CHECK (note IS NULL OR length(note) <= 300),
  valid_until    date NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','cancelled')),
  order_id       uuid REFERENCES orders(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  converted_at   timestamptz,
  CHECK ((status = 'converted') = (order_id IS NOT NULL))
);
CREATE INDEX proformas_seller_idx ON proformas(seller_id, created_at DESC);

CREATE FUNCTION _proforma_json(p proformas) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', p.id, 'number', p.number, 'status', CASE WHEN p.status = 'open' AND p.valid_until < current_date THEN 'expired' ELSE p.status END,
    'product', (SELECT name FROM products WHERE id = p.product_id), 'product_id', p.product_id, 'unit_price', p.unit_price, 'qty', p.qty, 'total', p.unit_price * p.qty,
    'customer_name', p.customer_name, 'customer_phone', p.customer_phone, 'commune', p.commune, 'address', p.address, 'note', p.note,
    'valid_until', p.valid_until, 'created_at', p.created_at, 'converted_at', p.converted_at, 'order_id', p.order_id,
    'order_ref', (SELECT ref FROM orders WHERE id = p.order_id))
$$;

CREATE FUNCTION fn_proforma_create(p_actor uuid, p_product uuid, p_unit_price bigint, p_qty int, p_cname text, p_cphone text, p_commune text, p_address text, p_note text, p_days int DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p proformas;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF _setting('feature_proformas') <> 1 THEN PERFORM _err('feature_off', 'Les proformas ne sont pas activées'); END IF;
  IF p_product IS NULL OR NOT EXISTS (SELECT 1 FROM products WHERE id = p_product AND status = 'approved' AND deleted_at IS NULL AND retired_at IS NULL) THEN PERFORM _err('not_found', 'Produit indisponible'); END IF;
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 60 THEN PERFORM _err('invalid_input', 'Durée de validité : 1 à 60 jours'); END IF;
  IF (SELECT count(*) FROM proformas WHERE seller_id = p_actor AND status = 'open' AND valid_until >= current_date) >= 200 THEN PERFORM _err('too_many', 'Trop de proformas ouvertes : annulez ou transformez les anciennes'); END IF;
  INSERT INTO proformas(number, seller_id, product_id, unit_price, qty, customer_name, customer_phone, commune, address, note, valid_until)
  VALUES ('PF-' || to_char(now(), 'YYMM') || '-' || lpad(nextval('proforma_seq')::text, 5, '0'), p_actor, p_product, p_unit_price, p_qty, trim(COALESCE(p_cname, '')), trim(COALESCE(p_cphone, '')),
          trim(COALESCE(p_commune, '')), trim(COALESCE(p_address, '')), NULLIF(trim(COALESCE(p_note, '')), ''), current_date + p_days)
  RETURNING * INTO p;
  RETURN _proforma_json(p);
END $$;

CREATE FUNCTION fn_proformas_mine(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  RETURN jsonb_build_object('enabled', _setting('feature_proformas') = 1,
    'proformas', COALESCE((SELECT jsonb_agg(_proforma_json(x) ORDER BY x.created_at DESC) FROM (SELECT * FROM proformas WHERE seller_id = p_actor ORDER BY created_at DESC LIMIT 100) x), '[]'::jsonb));
END $$;

CREATE FUNCTION fn_proforma_cancel(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p proformas;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  SELECT * INTO p FROM proformas WHERE id = p_id AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Proforma introuvable'); END IF;
  IF p.status <> 'open' THEN PERFORM _err('invalid_state', 'Cette proforma n''est plus ouverte'); END IF;
  UPDATE proformas SET status = 'cancelled' WHERE id = p_id;
END $$;

-- Transformation : la vraie commande est créée par la fonction existante (le client doit confirmer ; le stock et le risque sont contrôlés à ce moment-là).
CREATE FUNCTION fn_proforma_convert(p_actor uuid, p_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p proformas; v_res jsonb;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF _setting('feature_proformas') <> 1 THEN PERFORM _err('feature_off', 'Les proformas ne sont pas activées'); END IF;
  SELECT * INTO p FROM proformas WHERE id = p_id AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Proforma introuvable'); END IF;
  IF p.status = 'converted' THEN RETURN jsonb_build_object('id', p.order_id, 'ref', (SELECT ref FROM orders WHERE id = p.order_id), 'replayed', true); END IF;
  IF p.status <> 'open' THEN PERFORM _err('invalid_state', 'Cette proforma est annulée'); END IF;
  IF p.valid_until < current_date THEN PERFORM _err('expired', 'Cette proforma a expiré : créez-en une nouvelle'); END IF;
  v_res := fn_seller_create_order_once(p_actor, 'proforma-' || replace(p.id::text, '-', ''), p.product_id, NULL, p.unit_price, p.qty, p.customer_name, p.customer_phone, p.commune, p.address, p.note, false);
  UPDATE proformas SET status = 'converted', order_id = (v_res->>'id')::uuid, converted_at = now() WHERE id = p_id;
  RETURN v_res;
END $$;

-- La réinitialisation de l'activité connaît les proformas (elles dépendent des commandes).
DO $$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('fn_admin_reset_activity(uuid,text)'::regprocedure);
  n := replace(d, 'TRUNCATE TABLE dlv_requests,', 'TRUNCATE TABLE proformas, dlv_requests,');
  IF n = d THEN RAISE EXCEPTION 'fn_admin_reset_activity : texte inattendu'; END IF;
  EXECUTE n;
END $$;

-- Administration : lecture seule
CREATE FUNCTION fn_admin_proformas(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN jsonb_build_object('enabled', _setting('feature_proformas') = 1,
    'totals', (SELECT jsonb_build_object('open', count(*) FILTER (WHERE status = 'open' AND valid_until >= current_date), 'converted', count(*) FILTER (WHERE status = 'converted'),
                 'cancelled_or_expired', count(*) FILTER (WHERE status = 'cancelled' OR (status = 'open' AND valid_until < current_date))) FROM proformas),
    'proformas', COALESCE((SELECT jsonb_agg(_proforma_json(x) || jsonb_build_object('seller', (SELECT full_name FROM users WHERE id = x.seller_id)) ORDER BY x.created_at DESC) FROM (SELECT * FROM proformas ORDER BY created_at DESC LIMIT 100) x), '[]'::jsonb));
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
