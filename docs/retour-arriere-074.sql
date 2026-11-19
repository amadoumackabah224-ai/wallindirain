-- Retour arrière de la migration 074 (annonces en fenêtre). À jouer en tant que propriétaire de la base.
-- Refuse si des annonces ou des statistiques existent déjà (rien n'est perdu) : archivez-les ou exportez-les d'abord.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM popups) THEN RAISE EXCEPTION 'Retour arrière refusé : des annonces en fenêtre existent. Rien n''a été supprimé.'; END IF;
END $$;
DROP FUNCTION IF EXISTS fn_popup_image_get(uuid, uuid);
DROP FUNCTION IF EXISTS fn_popup_event(uuid, uuid, text);
DROP FUNCTION IF EXISTS fn_popup_next(uuid);
DROP FUNCTION IF EXISTS fn_admin_popups(uuid);
DROP FUNCTION IF EXISTS fn_admin_popup_archive(uuid, uuid);
DROP FUNCTION IF EXISTS fn_admin_popup_active(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS fn_admin_popup_save(uuid, uuid, text, text, text, text, text, timestamptz, timestamptz, text, text, bytea);
DROP TABLE IF EXISTS popup_views;
DROP TABLE IF EXISTS popups;
DELETE FROM settings WHERE key = 'feature_popups';
DELETE FROM schema_migrations WHERE name = '074_annonces_fenetre.sql';
COMMIT;
