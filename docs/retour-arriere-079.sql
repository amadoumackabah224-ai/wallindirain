-- Retour arrière de la 079 (points de retrait). Refusé s'il existe des points : rien n'est supprimé.
BEGIN;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pickup_points) THEN RAISE EXCEPTION 'Retour arrière refusé : des points de retrait existent. Rien n''a été supprimé.'; END IF; END $$;
DROP FUNCTION IF EXISTS fn_pickup_suggest(uuid, uuid, text);
DROP FUNCTION IF EXISTS fn_product_use_pickup_point(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS fn_pickup_point_remove(uuid, uuid);
DROP FUNCTION IF EXISTS fn_pickup_point_save(uuid, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS fn_pickup_points_mine(uuid);
DROP FUNCTION IF EXISTS _pp_json(pickup_points);
DROP TABLE IF EXISTS pickup_points;
DELETE FROM settings WHERE key = 'feature_pickup_points';
DELETE FROM schema_migrations WHERE name = '079_points_retrait.sql';
COMMIT;
