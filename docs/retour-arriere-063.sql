-- Retour arrière de la migration 063 (saisie hors connexion). Les clés d'envoi ne sont que des protections contre les doublons : on peut les effacer.
DO $$
DECLARE d text; a text := 'DELETE FROM pf_client_keys WHERE owner_id = p_actor;' || E'\n  ';
BEGIN
  d := replace(pg_get_functiondef('fn_pf_erase(uuid,text)'::regprocedure), a, '');
  EXECUTE d;
END $$;
DROP TRIGGER users_pf_keys_anonymized ON users;
DROP FUNCTION trg_pf_keys_anonymized();
DROP FUNCTION fn_pf_once_release(uuid, text);
DROP FUNCTION fn_pf_once_done(uuid, text, jsonb);
DROP FUNCTION fn_pf_once(uuid, text);
DROP TABLE pf_client_keys;
DELETE FROM schema_migrations WHERE name = '063_saisie_hors_connexion.sql';
