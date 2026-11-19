-- Retour arrière de la migration 071. Refusé si une course a déjà été confiée à un livreur ou si de l'argent a circulé (aucune donnée n'est supprimée).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dlv_requests WHERE courier_id IS NOT NULL OR status NOT IN ('new', 'cancelled')) OR EXISTS (SELECT 1 FROM courier_cash_entries WHERE dlv_request_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Des courses à la demande ont été confiées à un livreur : le retour arrière 071 est refusé pour ne rien perdre';
  END IF;
END $$;
DO $$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('fn_courier_remit(uuid,text,uuid,text,uuid[],text)'::regprocedure);
  n := replace(d, '(order_id = ANY (p_orders) OR dlv_request_id = ANY (p_orders))', 'order_id = ANY (p_orders)');
  IF n <> d THEN EXECUTE n; END IF;
  d := pg_get_functiondef('fn_admin_reset_activity(uuid,text)'::regprocedure);
  n := replace(d, 'TRUNCATE TABLE dlv_requests, order_payments,', 'TRUNCATE TABLE order_payments,');
  IF n <> d THEN EXECUTE n; END IF;
END $$;
CREATE OR REPLACE FUNCTION fn_dlv_my_requests(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['shipper']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'ref', ref, 'from', from_place, 'to', to_place, 'to_address', to_address, 'receiver_name', receiver_name,
           'description', description, 'weight_kg', weight_kg, 'weight_class', weight_class, 'price', price, 'payer', payer, 'status', status, 'created_at', created_at) ORDER BY created_at DESC)
      FROM (SELECT * FROM dlv_requests WHERE shipper_id = p_actor ORDER BY created_at DESC LIMIT 100) r), '[]'::jsonb);
END $$;
CREATE OR REPLACE FUNCTION fn_admin_dlv_requests(p_actor uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'created_at') DESC) FROM (
    SELECT jsonb_build_object('id', r.id, 'ref', r.ref, 'shipper', u.full_name, 'shipper_phone', u.phone, 'from', r.from_place, 'from_address', r.from_address, 'to', r.to_place, 'to_address', r.to_address,
           'receiver_name', r.receiver_name, 'receiver_phone', r.receiver_phone, 'description', r.description, 'weight_kg', r.weight_kg, 'weight_class', r.weight_class, 'price', r.price,
           'declared_value', r.declared_value, 'payer', r.payer, 'status', r.status, 'created_at', r.created_at) AS x
      FROM dlv_requests r JOIN users u ON u.id = r.shipper_id
     WHERE p_status IS NULL OR r.status = p_status ORDER BY r.created_at DESC LIMIT 200) s), '[]'::jsonb);
END $$;
DROP FUNCTION IF EXISTS fn_courier_dlv_fail(uuid, uuid, text);
DROP FUNCTION IF EXISTS fn_courier_dlv_deliver(uuid, uuid);
DROP FUNCTION IF EXISTS fn_courier_dlv_pickup(uuid, uuid);
DROP FUNCTION IF EXISTS fn_courier_dlv_list(uuid);
DROP FUNCTION IF EXISTS fn_admin_dlv_unassign(uuid, uuid);
DROP FUNCTION IF EXISTS fn_admin_dlv_assign(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS _dlv_settle_failed(dlv_requests);
DROP FUNCTION IF EXISTS _dlv_settle_delivered(dlv_requests);
DROP FUNCTION IF EXISTS _dlv_collect_cash(dlv_requests);
DROP FUNCTION IF EXISTS _dlv_pay(bigint);
ALTER TABLE courier_cash_entries DROP CONSTRAINT IF EXISTS courier_cash_one_source;
ALTER TABLE courier_cash_entries DROP COLUMN IF EXISTS dlv_request_id;
ALTER TABLE courier_cash_entries ALTER COLUMN order_id SET NOT NULL;
DROP INDEX IF EXISTS dlv_requests_courier;
ALTER TABLE dlv_requests DROP COLUMN IF EXISTS courier_id, DROP COLUMN IF EXISTS assigned_at, DROP COLUMN IF EXISTS picked_up_at, DROP COLUMN IF EXISTS delivered_at,
  DROP COLUMN IF EXISTS failed_at, DROP COLUMN IF EXISTS fail_reason,
  DROP COLUMN IF EXISTS cash_collected, DROP COLUMN IF EXISTS courier_pay;
DELETE FROM settings WHERE key IN ('dlv_courier_share', 'dlv_failed_pay_pct');
DELETE FROM schema_migrations WHERE name = '071_livraison_livreur_argent.sql';
