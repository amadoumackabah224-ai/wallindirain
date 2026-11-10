-- 059 : fonctions Pro de Mes finances — règles automatiques de catégorie et import de transactions (CSV lu côté application).
CREATE TABLE pf_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  contains   text NOT NULL CHECK (length(contains) BETWEEN 2 AND 40),
  kind       text CHECK (kind IN ('income','expense')),
  category   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pf_rules_owner ON pf_rules(owner_id, created_at);

-- Catégorie proposée pour une note : première règle (la plus ancienne) qui correspond.
CREATE FUNCTION _pf_rule_match(p_owner uuid, p_kind text, p_note text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT category FROM pf_rules
   WHERE owner_id = p_owner AND (kind IS NULL OR kind = p_kind) AND p_note IS NOT NULL
     AND position(lower(contains) in lower(p_note)) > 0
   ORDER BY created_at, id LIMIT 1
$$;

CREATE FUNCTION fn_pf_rule_save(p_actor uuid, p_contains text, p_kind text, p_category text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_txt text := lower(trim(COALESCE(p_contains, '')));
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pfrule:' || p_actor::text));
  IF length(v_txt) < 2 OR length(v_txt) > 40 THEN PERFORM _err('invalid_input', 'Le mot à repérer fait entre 2 et 40 caractères'); END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('income','expense') THEN PERFORM _err('invalid_input', 'Type invalide'); END IF;
  IF p_kind IS NOT NULL AND NOT _pf_cat_ok(p_actor, p_kind, p_category) THEN PERFORM _err('invalid_input', 'Catégorie invalide'); END IF;
  IF p_kind IS NULL AND NOT (_pf_cat_ok(p_actor, 'income', p_category) OR _pf_cat_ok(p_actor, 'expense', p_category)) THEN PERFORM _err('invalid_input', 'Catégorie invalide'); END IF;
  IF EXISTS (SELECT 1 FROM pf_rules WHERE owner_id = p_actor AND contains = v_txt AND kind IS NOT DISTINCT FROM p_kind) THEN PERFORM _err('duplicate', 'Cette règle existe déjà'); END IF;
  IF (SELECT count(*) FROM pf_rules WHERE owner_id = p_actor) >= 50 THEN PERFORM _err('limit', '50 règles au plus'); END IF;
  INSERT INTO pf_rules(owner_id, contains, kind, category) VALUES (p_actor, v_txt, p_kind, p_category) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_pf_rule_remove(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  DELETE FROM pf_rules WHERE id = p_id AND owner_id = p_actor;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Règle introuvable'); END IF;
END $$;

-- Import : p_rows = [{date, kind, amount (unités mineures du compte), category?, note?}], 500 lignes au plus.
-- Catégorie absente ou invalide : règle automatique, sinon « Revenus non affectés » / « Autre dépense ». Les lignes invalides sont ignorées et listées.
CREATE FUNCTION fn_pf_tx_import(p_actor uuid, p_account uuid, p_rows jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; n int := 0; v_added int := 0; v_skipped int := 0; v_errs jsonb := '[]'::jsonb;
        v_kind text; v_cat text; v_note text; v_day date; v_amt bigint;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on(); PERFORM _pf_pro(p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('pftx:' || p_actor::text));
  IF jsonb_typeof(p_rows) <> 'array' THEN PERFORM _err('invalid_input', 'Liste invalide'); END IF;
  IF jsonb_array_length(p_rows) = 0 THEN PERFORM _err('invalid_input', 'Aucune ligne à importer'); END IF;
  IF jsonb_array_length(p_rows) > 500 THEN PERFORM _err('invalid_input', '500 lignes au plus par import'); END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    n := n + 1;
    BEGIN
      v_kind := r->>'kind'; v_note := NULLIF(left(trim(COALESCE(r->>'note', '')), 200), ''); v_day := (r->>'date')::date; v_amt := (r->>'amount')::bigint;
      IF v_kind NOT IN ('income','expense') THEN RAISE EXCEPTION 'type invalide'; END IF;
      v_cat := r->>'category';
      IF v_cat IS NULL OR NOT _pf_cat_ok(p_actor, v_kind, v_cat) THEN
        v_cat := COALESCE(_pf_rule_match(p_actor, v_kind, v_note), CASE v_kind WHEN 'income' THEN 'unassigned_income' ELSE 'other_out' END);
        IF NOT _pf_cat_ok(p_actor, v_kind, v_cat) THEN v_cat := CASE v_kind WHEN 'income' THEN 'unassigned_income' ELSE 'other_out' END; END IF;
      END IF;
      PERFORM _pf_check_tx(p_actor, p_account, v_kind, v_amt, v_cat, v_note, v_day);
      INSERT INTO pf_transactions(owner_id, account_id, kind, amount, category, note, occurred_on) VALUES (p_actor, p_account, v_kind, v_amt, v_cat, v_note, v_day);
      v_added := v_added + 1;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
      IF jsonb_array_length(v_errs) < 10 THEN v_errs := v_errs || to_jsonb('Ligne ' || n || ' : ' || left(SQLERRM, 80)); END IF;
    END;
  END LOOP;
  IF v_added > 0 THEN PERFORM _pf_touch(p_actor); END IF;
  RETURN jsonb_build_object('added', v_added, 'skipped', v_skipped, 'errors', v_errs);
END $$;

-- Effacement des données Mes finances (058) : ajouter les règles.
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('fn_pf_erase(uuid,text)'::regprocedure) INTO d;
  IF position('DELETE FROM pf_prefs WHERE owner_id = p_actor;' in d) = 0 THEN RAISE EXCEPTION 'fn_pf_erase : repère introuvable'; END IF;
  EXECUTE replace(d, 'DELETE FROM pf_prefs WHERE owner_id = p_actor;', 'DELETE FROM pf_rules WHERE owner_id = p_actor;' || E'\n  ' || 'DELETE FROM pf_prefs WHERE owner_id = p_actor;');
END $$;
CREATE FUNCTION trg_pf_rules_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN DELETE FROM pf_rules WHERE owner_id = NEW.id; RETURN NEW; END $$;
CREATE TRIGGER users_pf_rules_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_rules_anonymized();

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
