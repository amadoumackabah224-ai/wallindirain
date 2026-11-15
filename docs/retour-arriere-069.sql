-- Retour arrière de la migration 069. Une valeur ajoutée à un type PostgreSQL ne se retire pas : elle reste inutilisée et sans effet.
-- (À faire seulement après le retour arrière 070.) On enlève juste la trace de la migration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role::text = 'shipper') THEN
    RAISE EXCEPTION 'Des comptes expéditeur existent : ne pas annuler la migration 069';
  END IF;
END $$;
DELETE FROM schema_migrations WHERE name = '069_role_expediteur.sql';
