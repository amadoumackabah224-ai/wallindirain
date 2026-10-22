-- =====================================================================
-- Migration 012 : suivi de commande pour le client, parrainage de vendeurs.
-- =====================================================================

-- ---------- Suivi de commande : lien secret, sans aucune donnée personnelle ----------
ALTER TABLE orders ADD COLUMN track_token text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
CREATE UNIQUE INDEX orders_track_token_uq ON orders(track_token);

-- Ce que le client voit : référence, produit, quantité, étape, dates. Jamais le vendeur, le fournisseur, l'adresse ni le téléphone.
CREATE FUNCTION fn_public_track(p_token text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE o orders; v_step text; v_name text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{20}$' THEN RETURN NULL; END IF;
  SELECT * INTO o FROM orders WHERE track_token = p_token;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- le lien cesse de fonctionner 90 jours après la dernière étape
  IF COALESCE(o.delivered_at, o.created_at) < now() - interval '90 days' THEN RETURN NULL; END IF;
  v_step := CASE o.status
    WHEN 'new' THEN 'received' WHEN 'in_call' THEN 'received'
    WHEN 'confirmed' THEN 'confirmed'
    WHEN 'assigned' THEN 'assigned'
    WHEN 'picked_up' THEN 'on_the_way' WHEN 'on_the_way' THEN 'on_the_way'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'problem' END;
  SELECT COALESCE(p.name, o.own_product_name) INTO v_name FROM orders x LEFT JOIN products p ON p.id = x.product_id WHERE x.id = o.id;
  RETURN jsonb_build_object('ref', o.ref, 'product', v_name, 'qty', o.qty, 'amount', o.sale_total, 'step', v_step,
    'created_at', o.created_at, 'delivered_at', o.delivered_at);
END $$;

-- la commande par lien public renvoie aussi le lien de suivi
CREATE OR REPLACE FUNCTION fn_public_order(p_link text, p_qty int, p_cname text, p_cphone text, p_commune text, p_address text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE l seller_links; r jsonb; v_token text;
BEGIN
  SELECT * INTO l FROM seller_links WHERE code = p_link;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Lien invalide'); END IF;
  r := _create_order(l.seller_id, l.product_id, NULL, NULL, p_qty, p_cname, p_cphone, p_commune, p_address, NULL, 'public_link', NULL);
  SELECT track_token INTO v_token FROM orders WHERE ref = r->>'ref';
  RETURN jsonb_build_object('ref', r->>'ref', 'sale_total', (r->>'sale_total')::bigint, 'track_token', v_token);
END $$;

-- ---------- Parrainage ----------
INSERT INTO settings(key, value, label) VALUES
  ('referral_bonus',           0, 'Parrainage : bonus versé au parrain (GNF, 0 = parrainage désactivé)'),
  ('referral_orders_required', 5, 'Parrainage : nombre de commandes livrées du filleul pour que le parrain reçoive son bonus');

ALTER TABLE users ADD COLUMN referral_code text NOT NULL DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 7));
CREATE UNIQUE INDEX users_referral_code_uq ON users(referral_code);
ALTER TABLE users ADD COLUMN referred_by uuid REFERENCES users(id);
ALTER TABLE users ADD COLUMN referral_paid_at timestamptz;

-- après l'inscription : relie le nouveau vendeur à son parrain ; renvoie faux si le code est inconnu
CREATE FUNCTION fn_register_referral(p_user uuid, p_code text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r users;
BEGIN
  SELECT * INTO r FROM users WHERE referral_code = upper(trim(COALESCE(p_code, ''))) AND role IN ('seller','supplier') AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND OR r.id = p_user THEN RETURN false; END IF;
  UPDATE users SET referred_by = r.id WHERE id = p_user AND role = 'seller' AND referred_by IS NULL AND created_at > now() - interval '10 minutes';
  RETURN FOUND;
END $$;

-- le bonus est versé UNE fois, quand le filleul atteint le nombre de commandes livrées demandé (écriture double : plateforme -> parrain)
CREATE FUNCTION _referral_trg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f users; v_bonus bigint := _setting('referral_bonus'); v_need bigint := _setting('referral_orders_required'); v_n bigint; p users;
BEGIN
  IF v_bonus <= 0 THEN RETURN NEW; END IF;
  SELECT * INTO f FROM users WHERE id = NEW.seller_id FOR UPDATE;
  IF f.referred_by IS NULL OR f.referral_paid_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO v_n FROM orders WHERE seller_id = f.id AND status = 'delivered';
  IF v_n < v_need THEN RETURN NEW; END IF;
  SELECT * INTO p FROM users WHERE id = f.referred_by AND status = 'active' AND deleted_at IS NULL;
  UPDATE users SET referral_paid_at = now() WHERE id = f.id;
  IF FOUND THEN
    PERFORM _wallet_add(p.id, 'referral_bonus', v_bonus, NEW.id, now() + make_interval(hours => NEW.unlock_hours), 'Parrainage : ' || split_part(f.full_name, ' ', 1));
    PERFORM _wallet_add(_platform(), 'referral_bonus', -v_bonus, NEW.id, now(), 'Parrainage de ' || p.full_name);
    PERFORM _audit(p.id, 'referral_bonus', 'user', f.id::text, jsonb_build_object('amount', v_bonus));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_referral AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered') EXECUTE FUNCTION _referral_trg();

-- mon parrainage : mon code, mes filleuls, mes bonus
CREATE FUNCTION fn_my_referral(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, ARRAY['seller','supplier']::user_role[]);
  RETURN jsonb_build_object('code', u.referral_code, 'bonus', _setting('referral_bonus'), 'orders_required', _setting('referral_orders_required'),
    'referred', (SELECT count(*) FROM users x WHERE x.referred_by = p_actor AND x.deleted_at IS NULL),
    'paid', (SELECT count(*) FROM users x WHERE x.referred_by = p_actor AND x.referral_paid_at IS NOT NULL),
    'earned', COALESCE((SELECT sum(amount) FROM wallet_entries WHERE user_id = p_actor AND kind = 'referral_bonus'), 0),
    'my_referrer', (SELECT split_part(r.full_name, ' ', 1) FROM users r WHERE r.id = u.referred_by),
    'my_progress', (SELECT count(*) FROM orders WHERE seller_id = p_actor AND status = 'delivered'));
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
