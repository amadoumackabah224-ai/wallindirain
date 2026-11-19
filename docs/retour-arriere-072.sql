-- Retour arrière de la migration 072. Refusé si un bonus a déjà été versé pour un expéditeur ou un livreur (aucune donnée n'est supprimée).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users u WHERE u.role IN ('shipper', 'courier') AND u.referral_paid_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Des bonus de parrainage expéditeur ou livreur ont été versés : le retour arrière 072 est refusé';
  END IF;
END $$;
DROP TRIGGER IF EXISTS orders_referral_courier ON orders;
DROP TRIGGER IF EXISTS dlv_referral ON dlv_requests;
DROP FUNCTION IF EXISTS fn_admin_set_referrer(uuid, uuid, text);
DROP FUNCTION IF EXISTS _referral_courier_orders_trg();
DROP FUNCTION IF EXISTS _referral_dlv_trg();
DROP FUNCTION IF EXISTS _referral_courier_check(uuid);
DROP FUNCTION IF EXISTS _referral_pay(uuid, bigint, text);
CREATE OR REPLACE FUNCTION fn_register_referral(p_user uuid, p_code text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r users;
BEGIN
  SELECT * INTO r FROM users WHERE referral_code = upper(trim(COALESCE(p_code, ''))) AND role IN ('seller','supplier') AND status = 'active' AND deleted_at IS NULL;
  IF NOT FOUND OR r.id = p_user THEN RETURN false; END IF;
  UPDATE users SET referred_by = r.id WHERE id = p_user AND role = 'seller' AND referred_by IS NULL AND created_at > now() - interval '10 minutes';
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION fn_my_referral(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
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
DELETE FROM settings WHERE key IN ('referral_bonus_shipper', 'referral_dlv_required', 'referral_bonus_courier', 'referral_courier_required');
DELETE FROM schema_migrations WHERE name = '072_parrainage_autres_roles.sql';
