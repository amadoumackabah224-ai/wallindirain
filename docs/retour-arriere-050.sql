-- Retour arrière de la migration 050 (Contacts). Refuse s'il existe des contacts, notes ou étiquettes. À appliquer avant celui de la 049.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pf_contacts) OR EXISTS (SELECT 1 FROM pf_contact_notes) OR EXISTS (SELECT 1 FROM pf_contact_labels) THEN
    RAISE EXCEPTION 'retour arrière refusé : des données de Contacts existent';
  END IF;
END $$;
DROP TRIGGER users_pf_contacts_anonymized ON users;
DROP FUNCTION trg_pf_contacts_anonymized();
DROP FUNCTION fn_pf_contacts_from_orders(uuid);
DROP FUNCTION fn_pf_contact_import(uuid, jsonb);
DROP FUNCTION fn_pf_contact_labels_set(uuid, uuid, uuid[]);
DROP FUNCTION fn_pf_label_delete(uuid, uuid);
DROP FUNCTION fn_pf_label_save(uuid, uuid, text, text);
DROP FUNCTION fn_pf_contact_note_void(uuid, uuid);
DROP FUNCTION fn_pf_contact_note_add(uuid, uuid, text);
DROP FUNCTION fn_pf_contact_archive(uuid, uuid, boolean);
DROP FUNCTION fn_pf_contact_save(uuid, uuid, text, text, text, text);
DROP FUNCTION _pf_norm_phone(text);
DROP TABLE pf_contact_label_links;
DROP TABLE pf_contact_labels;
DROP TABLE pf_contact_notes;
DROP TABLE pf_contacts;
DELETE FROM settings WHERE key = 'pf_free_contacts';

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

DELETE FROM schema_migrations WHERE name = '050_contacts_crm.sql';
