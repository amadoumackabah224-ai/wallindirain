-- Retour arrière de la migration 068 (grille tarifaire de livraison à la demande). Refusé si la fonction est allumée.
DO $$ BEGIN
  IF COALESCE((SELECT value FROM settings WHERE key = 'feature_livraison_demande'), 0) = 1 THEN
    RAISE EXCEPTION 'Éteignez d''abord « Livraison à la demande » dans Réglages avant le retour arrière';
  END IF;
END $$;
DROP FUNCTION IF EXISTS fn_dlv_quote(uuid, text, text, numeric);
DROP FUNCTION IF EXISTS fn_admin_dlv_list(uuid);
DROP FUNCTION IF EXISTS fn_admin_dlv_import(uuid, text, jsonb);
DROP FUNCTION IF EXISTS fn_admin_dlv_tariff_save(uuid, uuid, text, text[], bigint, bigint, boolean);
DROP FUNCTION IF EXISTS _dlv_check_overlap(text, text[], uuid);
DROP FUNCTION IF EXISTS _dlv_clean_places(text[]);
DROP FUNCTION IF EXISTS _dlv_norm(text);
DROP TABLE IF EXISTS dlv_tariffs;
DELETE FROM settings WHERE key IN ('feature_livraison_demande', 'delivery_heavy_kg');
DELETE FROM schema_migrations WHERE name = '068_livraison_grille.sql';
