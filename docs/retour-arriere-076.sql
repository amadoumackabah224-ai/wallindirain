-- Retour arrière de la migration 076 (session longue) : retour aux sessions fixes de 12 heures.
BEGIN;
DROP FUNCTION IF EXISTS fn_session_touch(text);
CREATE OR REPLACE FUNCTION fn_session_create(p_user uuid, p_token_hash text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE v_exp timestamptz := now() + interval '12 hours';
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
  INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (p_token_hash, p_user, v_exp);
  RETURN v_exp;
END $$;
DROP FUNCTION IF EXISTS _session_ttl(uuid);
UPDATE sessions SET expires_at = LEAST(expires_at, now() + interval '12 hours');
DELETE FROM schema_migrations WHERE name = '076_session_longue.sql';
COMMIT;
