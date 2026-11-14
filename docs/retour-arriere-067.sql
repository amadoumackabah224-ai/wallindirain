-- Retour arrière de la migration 067 (indicateurs des livreurs) : lecture seule, on retire seulement la fonction et le réglage.
DROP FUNCTION IF EXISTS fn_courier_stats(uuid, date, date);
DELETE FROM settings WHERE key = 'courier_late_hours';
DELETE FROM schema_migrations WHERE name = '067_indicateurs_livreurs.sql';
