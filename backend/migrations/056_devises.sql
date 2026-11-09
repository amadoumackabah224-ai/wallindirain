-- 056 : devises de « Mes finances ». Base : GNF. La personne ajoute d'autres devises avec un taux saisi à la main ; chaque compte a sa devise.
-- Les montants d'un compte sont dans sa devise (en plus petite unité : 1 USD = 100). Les totaux (tableau de bord, statistiques, budgets, prévision)
-- sont convertis en GNF au taux enregistré (taux actuel : changer un taux recalcule les totaux, pas les soldes des comptes).
-- Rien n'est supprimé ; les comptes et transactions existants restent en GNF.

CREATE TABLE pf_currencies (
  owner_id   uuid NOT NULL REFERENCES users(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z]{3}$' AND code <> 'GNF'),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  decimals   smallint NOT NULL CHECK (decimals BETWEEN 0 AND 3),
  rate       numeric(20,6) NOT NULL CHECK (rate > 0),     -- 1 unité de cette devise = rate GNF
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, code)
);
ALTER TABLE pf_accounts ADD COLUMN currency text NOT NULL DEFAULT 'GNF' CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE pf_prefs ADD COLUMN rates_auto boolean NOT NULL DEFAULT false;   -- réglage de mise à jour automatique des taux (le service de taux n'est pas encore connecté)
INSERT INTO settings(key, value, label) VALUES
  ('pf_free_currencies', 1, 'Mes finances : nombre de devises autres que le GNF en formule gratuite (Pro : illimité)');

-- Vue enveloppe : `amount` reste en GNF (tous les totaux existants continuent de fonctionner) ; `amount_orig` et `currency` donnent le montant du compte.
ALTER VIEW pf_all_tx RENAME TO pf_all_tx_raw;
CREATE VIEW pf_all_tx AS
  SELECT r.id, r.owner_id, r.account_id, r.kind,
         CASE WHEN c.rate IS NULL THEN r.amount ELSE round(r.amount::numeric / power(10, c.decimals) * c.rate)::bigint END AS amount,
         r.category, r.note, r.occurred_on, r.transfer_id, r.created_at, r.voided_at, r.source,
         r.amount AS amount_orig, COALESCE(a.currency, 'GNF') AS currency
    FROM pf_all_tx_raw r
    LEFT JOIN pf_accounts a ON a.id = r.account_id
    LEFT JOIN pf_currencies c ON c.owner_id = r.owner_id AND c.code = a.currency;

-- Créer / modifier un compte avec sa devise (la devise d'un compte ne change plus après sa création)
ALTER FUNCTION fn_pf_account_save(uuid, uuid, text, text, text, bigint) RENAME TO _pf_account_save_base;
REVOKE ALL ON FUNCTION _pf_account_save_base(uuid, uuid, text, text, text, bigint) FROM PUBLIC, wld_app;   -- interne : seule la nouvelle fonction l'appelle
CREATE FUNCTION fn_pf_account_save(p_actor uuid, p_id uuid, p_name text, p_kind text, p_color text, p_opening bigint, p_currency text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_cur text := upper(COALESCE(NULLIF(btrim(p_currency), ''), 'GNF')); v_id uuid; v_old text;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  IF v_cur <> 'GNF' AND NOT EXISTS (SELECT 1 FROM pf_currencies WHERE owner_id = p_actor AND code = v_cur) THEN
    PERFORM _err('invalid_input', 'Devise inconnue : ajoutez-la d''abord dans les devises');
  END IF;
  IF p_id IS NOT NULL THEN
    SELECT currency INTO v_old FROM pf_accounts WHERE id = p_id AND owner_id = p_actor;
    IF v_old IS NOT NULL AND v_old <> v_cur THEN PERFORM _err('invalid_state', 'La devise d''un compte ne change pas : créez un autre compte'); END IF;
  END IF;
  v_id := _pf_account_save_base(p_actor, p_id, p_name, p_kind, p_color, p_opening);
  IF p_id IS NULL THEN UPDATE pf_accounts SET currency = v_cur WHERE id = v_id; END IF;
  RETURN v_id;
END $$;

-- Un virement se fait entre deux comptes de la même devise ; la liaison Wallindirain crée son compte « Mobile Money » (en GNF) par la fonction interne
DO $$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('fn_pf_wallet_link(uuid,uuid)'::regprocedure);
  n := replace(d, 'v_acc := fn_pf_account_save(p_actor, NULL, ''Mobile Money'', ''mobile_money'', ''orange'', 0);', 'v_acc := _pf_account_save_base(p_actor, NULL, ''Mobile Money'', ''mobile_money'', ''orange'', 0);');
  IF n = d THEN RAISE EXCEPTION 'fn_pf_wallet_link : texte inattendu'; END IF;
  EXECUTE n;
  d := pg_get_functiondef('fn_pf_transfer(uuid,uuid,uuid,bigint,text,date)'::regprocedure);
  n := replace(d, 'IF p_from = p_to THEN PERFORM _err(''invalid_input'', ''Choisissez deux comptes différents''); END IF;',
    'IF p_from = p_to THEN PERFORM _err(''invalid_input'', ''Choisissez deux comptes différents''); END IF;
  IF EXISTS (SELECT 1 FROM pf_accounts f JOIN pf_accounts t ON t.owner_id = f.owner_id WHERE f.id = p_from AND t.id = p_to AND f.owner_id = p_actor AND f.currency <> t.currency) THEN
    PERFORM _err(''invalid_input'', ''Un virement se fait entre deux comptes de la même devise'');
  END IF;');
  IF n = d THEN RAISE EXCEPTION 'fn_pf_transfer : texte inattendu'; END IF;
  EXECUTE n;
END $$;

-- Ajouter ou mettre à jour une devise (taux : 1 unité = p_rate GNF)
CREATE FUNCTION fn_pf_currency_save(p_actor uuid, p_code text, p_name text, p_decimals int, p_rate numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_code text := upper(btrim(COALESCE(p_code, ''))); v_name text := btrim(COALESCE(p_name, '')); v_old smallint;
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  PERFORM pg_advisory_xact_lock(hashtext('pfcur:' || p_actor::text));
  IF v_code !~ '^[A-Z]{3}$' OR v_code = 'GNF' THEN PERFORM _err('invalid_input', 'Code de devise invalide (3 lettres, différent de GNF)'); END IF;
  IF length(v_name) < 1 OR length(v_name) > 40 THEN PERFORM _err('invalid_input', 'Nom de 1 à 40 caractères'); END IF;
  IF p_decimals IS NULL OR p_decimals < 0 OR p_decimals > 3 THEN PERFORM _err('invalid_input', 'Décimales : 0 à 3'); END IF;
  IF p_rate IS NULL OR p_rate <= 0 OR p_rate > 100000000000 THEN PERFORM _err('invalid_input', 'Taux invalide'); END IF;
  SELECT decimals INTO v_old FROM pf_currencies WHERE owner_id = p_actor AND code = v_code;
  IF NOT FOUND THEN
    IF _pf_tier(p_actor) <> 'pro' AND (SELECT count(*) FROM pf_currencies WHERE owner_id = p_actor) >= _setting('pf_free_currencies') THEN
      PERFORM _err('limit', 'La formule gratuite permet ' || _setting('pf_free_currencies') || ' devise en plus du GNF. Passez à Pro pour en ajouter.');
    END IF;
    IF (SELECT count(*) FROM pf_currencies WHERE owner_id = p_actor) >= 30 THEN PERFORM _err('limit', '30 devises au plus'); END IF;
    INSERT INTO pf_currencies(owner_id, code, name, decimals, rate) VALUES (p_actor, v_code, v_name, p_decimals, round(p_rate, 6));
  ELSE
    IF v_old <> p_decimals AND EXISTS (SELECT 1 FROM pf_accounts WHERE owner_id = p_actor AND currency = v_code) THEN
      PERFORM _err('invalid_state', 'Le nombre de décimales ne change plus une fois un compte créé dans cette devise');
    END IF;
    UPDATE pf_currencies SET name = v_name, decimals = p_decimals, rate = round(p_rate, 6), updated_at = now() WHERE owner_id = p_actor AND code = v_code;
  END IF;
END $$;

-- Retirer une devise : seulement si aucun compte (même archivé) ne l'utilise
CREATE FUNCTION fn_pf_currency_remove(p_actor uuid, p_code text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  PERFORM pg_advisory_xact_lock(hashtext('pfcur:' || p_actor::text));
  IF EXISTS (SELECT 1 FROM pf_accounts WHERE owner_id = p_actor AND currency = upper(p_code)) THEN
    PERFORM _err('invalid_state', 'Cette devise est utilisée par un compte (même archivé)');
  END IF;
  DELETE FROM pf_currencies WHERE owner_id = p_actor AND code = upper(p_code);
  IF NOT FOUND THEN PERFORM _err('not_found', 'Devise introuvable'); END IF;
END $$;

CREATE FUNCTION fn_pf_rates_auto_set(p_actor uuid, p_on boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pf_actor(p_actor); PERFORM _pf_feature_on();
  INSERT INTO pf_prefs(owner_id, rates_auto) VALUES (p_actor, COALESCE(p_on, false))
    ON CONFLICT (owner_id) DO UPDATE SET rates_auto = EXCLUDED.rates_auto, updated_at = now();
END $$;

CREATE FUNCTION trg_pf_cur_anonymized() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pf_currencies WHERE owner_id = NEW.id;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_pf_cur_anonymized() SECURITY DEFINER SET search_path = public, pg_temp;
-- le déclencheur s'exécute après celui des comptes (ordre alphabétique des noms) : les comptes d'abord
CREATE TRIGGER users_pf_zcur_anonymized AFTER UPDATE OF deleted_at ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_pf_cur_anonymized();

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
