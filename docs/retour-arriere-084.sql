-- Retour arrière de la migration 084 (style bulles). Ne touche à aucune donnée métier.
BEGIN;
DELETE FROM settings WHERE key = 'feature_style_bulles';
DELETE FROM schema_migrations WHERE name = '084_style_bulles.sql';
COMMIT;
