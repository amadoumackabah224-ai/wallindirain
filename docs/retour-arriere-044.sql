-- Retour arrière de la migration 044 (relances des clients : journal, étiquettes, rappels, fêtes, modèles, réglages).
-- Refuse s'il existe des données de relance (sinon elles seraient perdues). Le réglage feature_relances doit être éteint (0).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM relance_log) OR EXISTS (SELECT 1 FROM relance_optouts) OR EXISTS (SELECT 1 FROM relance_tags)
     OR EXISTS (SELECT 1 FROM relance_reminders) OR EXISTS (SELECT 1 FROM relance_feasts) OR EXISTS (SELECT 1 FROM relance_templates)
     OR EXISTS (SELECT 1 FROM relance_prefs) THEN
    RAISE EXCEPTION 'retour arrière refusé : des données de relance existent (journal, désinscriptions, étiquettes, rappels, fêtes, modèles ou réglages)';
  END IF;
  IF COALESCE((SELECT value FROM settings WHERE key = 'feature_relances'), 0) <> 0 THEN
    RAISE EXCEPTION 'retour arrière refusé : éteignez d''abord la fonction (réglage feature_relances = 0)';
  END IF;
END $$;
DROP TRIGGER users_relances_anonymized ON users;
DROP FUNCTION trg_relances_user_anonymized();
DROP FUNCTION fn_seller_relance_customers(uuid);
DROP FUNCTION fn_seller_relance_feast_delete(uuid, uuid);
DROP FUNCTION fn_seller_relance_feast_save(uuid, uuid, text, date);
DROP FUNCTION fn_seller_relance_tag_set(uuid, uuid, text, boolean);
DROP FUNCTION fn_seller_relance_tag_delete(uuid, uuid);
DROP FUNCTION fn_seller_relance_tag_create(uuid, text, text);
DROP FUNCTION fn_seller_relance_template_delete(uuid, uuid);
DROP FUNCTION fn_seller_relance_template_save(uuid, uuid, text, text);
DROP FUNCTION fn_seller_relance_remind(uuid, text, date);
DROP FUNCTION fn_admin_relance_reactivate(uuid, uuid, text);
DROP FUNCTION fn_seller_relance_optout(uuid, text);
DROP FUNCTION fn_seller_relance_log(uuid, text, text, text, text, date);
DROP FUNCTION fn_seller_relance_open(uuid, text, text);
DROP FUNCTION fn_seller_relance_set_prefs(uuid, int, int, text);
DROP FUNCTION fn_seller_relance_consent(uuid);
DROP FUNCTION _relance_check(uuid, text, text);
DROP FUNCTION _relance_feature_on();
DROP FUNCTION _relance_consent_version();
DROP TABLE relance_customer_tags;
DROP TABLE relance_tags;
DROP TABLE relance_reminders;
DROP TABLE relance_feasts;
DROP TABLE relance_templates;
DROP TABLE relance_log;
DROP TABLE relance_optouts;
DROP TABLE relance_prefs;
DELETE FROM settings WHERE key = 'feature_relances';

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
DO $$
DECLARE r record; v_cols text;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE '\_%' OR p.proname LIKE 'fn\_%' OR p.proname = 'trg_orders_frozen') LOOP
    IF r.proname <> 'trg_orders_frozen' THEN
      EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public, pg_temp', r.sig);
      IF r.proname LIKE 'fn\_%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wld_app', r.sig); END IF;
    END IF;
  END LOOP;

  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions','order_requests') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash')
       AND NOT (r.relname IN ('proofs','avatars','product_images','return_photos','invoices') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

DELETE FROM schema_migrations WHERE name = '044_relances.sql';
