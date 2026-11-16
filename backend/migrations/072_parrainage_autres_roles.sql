-- 072 : parrainage pour les autres rôles.
--  * Qui peut parrainer : vendeurs, fournisseurs et LIVREURS (des personnes qui peuvent retirer de l'argent).
--  * Qui peut être parrainé : vendeurs (comme avant), EXPÉDITEURS (code saisi à l'inscription) et LIVREURS (code saisi par l'administration, car les livreurs sont créés par l'administration).
--  * Le bonus est versé UNE seule fois au parrain, quand le filleul atteint son objectif :
--      expéditeur : N courses livrées (referral_dlv_required, 3)   | bonus referral_bonus_shipper (0 = désactivé)
--      livreur    : N livraisons réussies, commandes + courses à la demande (referral_courier_required, 20) | bonus referral_bonus_courier (0 = désactivé)
-- Tout est désactivé par défaut (montants à 0). Le bonus est prélevé sur la plateforme (écriture double).
INSERT INTO settings(key, value, label) VALUES
  ('referral_bonus_shipper',   0, 'Parrainage d''un expéditeur : bonus versé au parrain (GNF, 0 = désactivé)'),
  ('referral_dlv_required',    3, 'Parrainage d''un expéditeur : nombre de courses livrées pour que le parrain reçoive son bonus'),
  ('referral_bonus_courier',   0, 'Parrainage d''un livreur : bonus versé au parrain (GNF, 0 = désactivé)'),
  ('referral_courier_required', 20, 'Parrainage d''un livreur : nombre de livraisons réussies pour que le parrain reçoive son bonus')
ON CONFLICT (key) DO NOTHING;

-- Le code d'un vendeur, fournisseur ou livreur actif est accepté ; le filleul peut être un vendeur ou un expéditeur.
CREATE OR REPLACE FUNCTION fn_register_referral(p_user uuid, p_code text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r users;
BEGIN
  SELECT * INTO r FROM users WHERE referral_code = upper(trim(COALESCE(p_code, ''))) AND role IN ('seller','supplier','courier') AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND OR r.id = p_user THEN RETURN false; END IF;
  UPDATE users SET referred_by = r.id WHERE id = p_user AND role IN ('seller','shipper') AND referred_by IS NULL AND created_at > now() - interval '10 minutes';
  RETURN FOUND;
END $$;

-- Paiement unique du bonus (appelé sous verrou de la ligne du filleul).
CREATE FUNCTION _referral_pay(p_filleul uuid, p_bonus bigint, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE f users; p users;
BEGIN
  IF p_bonus <= 0 THEN RETURN; END IF;
  SELECT * INTO f FROM users WHERE id = p_filleul FOR UPDATE;
  IF f.referred_by IS NULL OR f.referral_paid_at IS NOT NULL THEN RETURN; END IF;
  UPDATE users SET referral_paid_at = now() WHERE id = f.id;
  SELECT * INTO p FROM users WHERE id = f.referred_by AND status = 'active' AND deleted_at IS NULL;
  IF FOUND THEN
    PERFORM _wallet_add(p.id, 'referral_bonus', p_bonus, NULL, now(), 'Parrainage : ' || p_label || ' ' || split_part(f.full_name, ' ', 1));
    PERFORM _wallet_add(_platform(), 'referral_bonus', -p_bonus, NULL, now(), 'Parrainage de ' || p.full_name);
    PERFORM _audit(p.id, 'referral_bonus', 'user', f.id::text, jsonb_build_object('amount', p_bonus, 'role', f.role));
  END IF;
END $$;

CREATE FUNCTION _referral_dlv_trg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  -- expéditeur parrainé : objectif de courses livrées
  IF _setting('referral_bonus_shipper') > 0 AND EXISTS (SELECT 1 FROM users WHERE id = NEW.shipper_id AND referred_by IS NOT NULL AND referral_paid_at IS NULL) THEN
    SELECT count(*) INTO v_n FROM dlv_requests WHERE shipper_id = NEW.shipper_id AND status = 'delivered';
    IF v_n >= _setting('referral_dlv_required') THEN PERFORM _referral_pay(NEW.shipper_id, _setting('referral_bonus_shipper'), 'expéditeur'); END IF;
  END IF;
  -- livreur parrainé
  IF NEW.courier_id IS NOT NULL THEN PERFORM _referral_courier_check(NEW.courier_id); END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION _referral_courier_check(p_courier uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  IF _setting('referral_bonus_courier') <= 0 OR NOT EXISTS (SELECT 1 FROM users WHERE id = p_courier AND referred_by IS NOT NULL AND referral_paid_at IS NULL) THEN RETURN; END IF;
  SELECT (SELECT count(*) FROM orders WHERE courier_id = p_courier AND status = 'delivered') + (SELECT count(*) FROM dlv_requests WHERE courier_id = p_courier AND status = 'delivered') INTO v_n;
  IF v_n >= _setting('referral_courier_required') THEN PERFORM _referral_pay(p_courier, _setting('referral_bonus_courier'), 'livreur'); END IF;
END $$;

CREATE FUNCTION _referral_courier_orders_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.courier_id IS NOT NULL THEN PERFORM _referral_courier_check(NEW.courier_id); END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER dlv_referral AFTER UPDATE OF status ON dlv_requests
  FOR EACH ROW WHEN (NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered') EXECUTE FUNCTION _referral_dlv_trg();
CREATE TRIGGER orders_referral_courier AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered') EXECUTE FUNCTION _referral_courier_orders_trg();

-- L'administration indique le parrain d'un livreur (les livreurs ne s'inscrivent pas seuls).
CREATE FUNCTION fn_admin_set_referrer(p_actor uuid, p_user uuid, p_code text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE u users; r users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO u FROM users WHERE id = p_user AND role = 'courier' AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Livreur introuvable'); END IF;
  IF u.referred_by IS NOT NULL THEN PERFORM _err('invalid_state', 'Ce livreur a déjà un parrain'); END IF;
  SELECT * INTO r FROM users WHERE referral_code = upper(trim(COALESCE(p_code, ''))) AND role IN ('seller','supplier','courier') AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Code de parrainage inconnu'); END IF;
  IF r.id = u.id THEN PERFORM _err('invalid_input', 'Un livreur ne peut pas se parrainer lui-même'); END IF;
  UPDATE users SET referred_by = r.id WHERE id = u.id;
  PERFORM _audit(p_actor, 'referrer_set', 'user', u.id::text, jsonb_build_object('referrer', r.id));
  RETURN split_part(r.full_name, ' ', 1);
END $$;

CREATE OR REPLACE FUNCTION fn_my_referral(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, ARRAY['seller','supplier','courier']::user_role[]);
  RETURN jsonb_build_object('code', u.referral_code, 'bonus', _setting('referral_bonus'), 'orders_required', _setting('referral_orders_required'), 'bonus_shipper', _setting('referral_bonus_shipper'), 'dlv_required', _setting('referral_dlv_required'), 'bonus_courier', _setting('referral_bonus_courier'), 'courier_required', _setting('referral_courier_required'), 'role', u.role,
    'referred', (SELECT count(*) FROM users x WHERE x.referred_by = p_actor AND x.deleted_at IS NULL),
    'paid', (SELECT count(*) FROM users x WHERE x.referred_by = p_actor AND x.referral_paid_at IS NOT NULL),
    'earned', COALESCE((SELECT sum(amount) FROM wallet_entries WHERE user_id = p_actor AND kind = 'referral_bonus'), 0),
    'my_referrer', (SELECT split_part(r.full_name, ' ', 1) FROM users r WHERE r.id = u.referred_by),
    'my_progress', (SELECT count(*) FROM orders WHERE seller_id = p_actor AND status = 'delivered'));
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
