-- Retour arrière de la migration 059 (règles automatiques, import). Refuse s'il existe des règles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pf_rules) THEN RAISE EXCEPTION 'retour arrière refusé : des règles existent'; END IF;
END $$;
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('fn_pf_erase(uuid,text)'::regprocedure) INTO d;
  EXECUTE replace(d, 'DELETE FROM pf_rules WHERE owner_id = p_actor;' || E'\n  ', '');
END $$;
DROP TRIGGER users_pf_rules_anonymized ON users;
DROP FUNCTION trg_pf_rules_anonymized();
DROP FUNCTION fn_pf_tx_import(uuid, uuid, jsonb);
DROP FUNCTION fn_pf_rule_remove(uuid, uuid);
DROP FUNCTION fn_pf_rule_save(uuid, text, text, text);
DROP FUNCTION _pf_rule_match(uuid, text, text);
DROP TABLE pf_rules;
DELETE FROM schema_migrations WHERE name = '059_pro_regles_import.sql';
