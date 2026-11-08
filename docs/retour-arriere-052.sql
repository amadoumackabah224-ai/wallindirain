-- Retour arrière de la migration 052 (rôle membre).
-- PostgreSQL ne permet pas de retirer une valeur d'un type énuméré : la valeur « member », inutilisée une fois la 053 défaite, reste sans effet. Refuse s'il existe des comptes membres.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role::text = 'member') THEN RAISE EXCEPTION 'retour arrière refusé : des comptes membres existent'; END IF;
END $$;
DELETE FROM schema_migrations WHERE name = '052_role_membre.sql';
