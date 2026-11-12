-- Retour arrière de la migration 064 (codes par SMS) : tout repart par WhatsApp comme avant.
DO $$
DECLARE d text;
BEGIN
  d := replace(pg_get_functiondef('fn_admin_set_setting(uuid,text,bigint)'::regprocedure), '''kyc_images_required'',''vehicle_check_required'',''sms_codes'') AND p_value > 1', '''kyc_images_required'',''vehicle_check_required'') AND p_value > 1');
  EXECUTE d;
END $$;
CREATE OR REPLACE FUNCTION _queue_message(p_phone text, p_template text, p_body text, p_order uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO messages(to_phone, template, body, order_id) VALUES (p_phone, p_template, p_body, p_order)
$$;
DELETE FROM settings WHERE key = 'sms_codes';
DELETE FROM schema_migrations WHERE name = '064_sms_nimba.sql';
