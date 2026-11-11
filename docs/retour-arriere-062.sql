-- Retour arrière de la migration 062 (vérification du véhicule des livreurs). Refuse s'il existe des véhicules enregistrés.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM courier_vehicles) THEN RAISE EXCEPTION 'retour arrière refusé : des véhicules de livreurs existent'; END IF;
END $$;
DO $$
DECLARE d text; s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['fn_chief_offer_order(uuid,uuid,uuid)', 'fn_chief_assign(uuid,uuid,uuid)'] LOOP
    d := replace(pg_get_functiondef(s::regprocedure),
      'IF NOT _courier_vehicle_ok(p_courier) THEN PERFORM _err(''vehicle_unverified'', ''La plaque et la carte grise de ce livreur ne sont pas encore vérifiées'');' || E'\n  ' || 'END IF;' || E'\n  ', '');
    EXECUTE d;
  END LOOP;
  d := replace(pg_get_functiondef('fn_admin_set_setting(uuid,text,bigint)'::regprocedure), '''kyc_images_required'',''vehicle_check_required'') AND p_value > 1', '''kyc_images_required'') AND p_value > 1');
  EXECUTE d;
END $$;
DROP TRIGGER users_vehicle_anonymized ON users;
DROP FUNCTION trg_vehicle_anonymized();
DROP FUNCTION fn_admin_reject_vehicle(uuid, uuid, text);
DROP FUNCTION fn_admin_verify_vehicle(uuid, uuid, boolean);
DROP FUNCTION fn_my_vehicle(uuid);
DROP FUNCTION fn_vehicle_image_get(uuid, uuid, text);
DROP FUNCTION fn_vehicle_submit(uuid);
DROP FUNCTION fn_vehicle_image_set(uuid, text, text, bytea);
DROP FUNCTION fn_vehicle_set(uuid, text);
DROP FUNCTION _courier_vehicle_ok(uuid);
DROP TABLE courier_vehicles;
DELETE FROM settings WHERE key = 'vehicle_check_required';
DELETE FROM schema_migrations WHERE name = '062_verification_vehicule.sql';
