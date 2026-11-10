-- Retour arrière de la migration 058 (effacement des données Mes finances par la personne).
DROP FUNCTION fn_pf_erase(uuid, text);
DELETE FROM schema_migrations WHERE name = '058_donnees_personnelles.sql';
