-- 058 : « Données personnelles » de Mes finances — la personne peut effacer elle-même ses données Mes finances.
-- Efface uniquement ce qui appartient à Mes finances (comptes, transactions, budgets, objectifs, récurrents, contacts, catégories,
-- devises, réglages). Ne touche ni au compte, ni au portefeuille Wallindirain, ni aux commandes, ni à l'accès Pro (pf_access,
-- gardé pour que l'essai ne puisse pas être rejoué). Les espaces de groupe dont la personne est propriétaire doivent être archivés
-- d'abord ; ses participations à d'autres espaces sont quittées (ses opérations y restent, elles appartiennent au groupe).
CREATE FUNCTION fn_pf_erase(p_actor uuid, p_confirm text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_confirm IS DISTINCT FROM 'EFFACER' THEN PERFORM _err('invalid_input', 'Confirmation manquante'); END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_actor AND deleted_at IS NULL) THEN PERFORM _err('not_found', 'Compte introuvable'); END IF;
  IF EXISTS (SELECT 1 FROM pf_spaces WHERE owner_id = p_actor AND archived_at IS NULL) THEN
    PERFORM _err('invalid_state', 'Archivez d''abord vos espaces de groupe : ils appartiennent à plusieurs personnes');
  END IF;
  UPDATE pf_space_members SET status = 'left', responded_at = now() WHERE user_id = p_actor AND status IN ('active', 'invited') AND role <> 'owner';
  DELETE FROM pf_transactions WHERE owner_id = p_actor;
  DELETE FROM pf_budgets WHERE owner_id = p_actor;
  DELETE FROM pf_goals WHERE owner_id = p_actor;
  DELETE FROM pf_recurring WHERE owner_id = p_actor;
  DELETE FROM pf_contact_label_links WHERE contact_id IN (SELECT id FROM pf_contacts WHERE owner_id = p_actor);
  DELETE FROM pf_contact_notes WHERE owner_id = p_actor;
  DELETE FROM pf_contact_labels WHERE owner_id = p_actor;
  DELETE FROM pf_contacts WHERE owner_id = p_actor;
  DELETE FROM pf_accounts WHERE owner_id = p_actor;
  DELETE FROM pf_cat_override WHERE owner_id = p_actor;
  DELETE FROM pf_cat_custom WHERE owner_id = p_actor;
  DELETE FROM pf_currencies WHERE owner_id = p_actor;
  DELETE FROM pf_prefs WHERE owner_id = p_actor;
END $$;

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

GRANT SELECT ON pf_all_tx TO wld_app;
