-- RETOUR ARRIÈRE de la migration 018 (profil et zones du livreur). JAMAIS AUTOMATIQUE.
-- Efface les profils et zones saisis (aucune donnée financière ni commande). Retirer aussi le code déployé correspondant.
BEGIN;
DROP FUNCTION IF EXISTS fn_courier_profile(uuid);
DROP FUNCTION IF EXISTS fn_courier_set_availability(uuid, boolean);
DROP FUNCTION IF EXISTS fn_admin_set_courier_zones(uuid, uuid, text[]);
DROP FUNCTION IF EXISTS fn_admin_set_courier_profile(uuid, uuid, text);
DROP FUNCTION IF EXISTS _courier_exists(uuid);
DROP TABLE IF EXISTS courier_zones;
DROP TABLE IF EXISTS courier_profiles;
DELETE FROM schema_migrations WHERE name = '018_profil_livreur.sql';
COMMIT;
